import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type {
  JsonObject,
  OnethingRuntimeFacade,
  RuntimeEventEnvelope,
  RuntimeRequestContext,
  RuntimeStreamPayload,
  RuntimeUnsubscribe,
} from '@onething/core'
import type { ProxySettings } from '@shared/ipc/settings.js'
import type { SessionEventEnvelope, StreamChunk } from '@shared/events/index.js'
import { SessionStreamCoalescer } from '@onething/backend/events/stream-coalescer.js'
import { dispatchRpc } from '@onething/backend/rpc/registry.js'
import { RPC_ERROR_CODES, type RpcDispatchContext, type RpcRequest, type RpcResponse } from '@shared/ipc/rpc.js'
import { createServerRpcDispatchContext } from './runtime.js'
import { getLogger } from '../wiring/logging/index.js'

/**
 * 访问日志(logging L1 §2.2 的 `server.http`)。在它之前这个 1900 行的文件里
 * 一条日志都没有 —— 没有访问记录、没有 4xx/5xx、没有耗时,server 出问题只能靠猜。
 */
const httpLog = getLogger('server.http')

/** `/api/sessions/<id>/…` 里的会话 id —— 让访问日志能和会话账本 join。 */
export function sessionIdFromPath(pathname: string): string | undefined {
  const match = /^\/api\/sessions\/([^/]+)/.exec(pathname)
  if (!match) return undefined
  const id = decodeURIComponent(match[1])
  return id && id !== 'search' ? id : undefined
}

export type OnethingServerRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void

export interface OnethingHttpServerOptions {
  runtime: OnethingRuntimeFacade
  corsOrigin?: string
  defaultUserId?: string
  defaultWorkspaceId?: string
  /**
   * Shared secret required as a Bearer token on every request. Identity headers
   * (x-onething-user-id / x-onething-workspace-id) select an owner scope, so they
   * are rejected unless this token is configured and presented — otherwise any
   * process that can reach the port could read/write another owner's data by
   * spoofing headers.
   */
  authToken?: string
  /**
   * Root under which each owner's workspace sandbox lives. Required by the
   * sandbox-scoped RPC domains (主线 T 批 3); without it the app-layer guard
   * refuses those calls rather than running unconfined.
   */
  workspaceRoot?: string
}

interface RouteContext {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  runtime: OnethingRuntimeFacade
  corsOrigin?: string
  requestContext: RuntimeRequestContext
  /** Derived from `requestContext` (bearer-gated headers), never the body. */
  rpcContext: RpcDispatchContext
}

type RouteHandler = (context: RouteContext) => Promise<void> | void

export function createOnethingHttpServer(options: OnethingHttpServerOptions): Server {
  return createServer(createOnethingServerRequestHandler(options))
}

export function createOnethingServerRequestHandler(
  options: OnethingHttpServerOptions,
): OnethingServerRequestHandler {
  return (request, response) => {
    const url = getRequestUrl(request)
    const startedAt = Date.now()
    const sessionId = sessionIdFromPath(url.pathname)
    // `close` 而不是 `finish`:SSE 那条长连接永远不会 `finish`,只有断开才算一次
    // 请求结束。一次只记一条(两个事件都可能到)。
    let logged = false
    const logRequest = (): void => {
      if (logged) return
      logged = true
      const status = response.statusCode
      const fields = {
        method: request.method || 'GET',
        path: url.pathname,
        status,
        ms: Date.now() - startedAt,
        ...(sessionId ? { sessionId } : {}),
      }
      if (status >= 500) httpLog.error('request failed', fields)
      else if (status >= 400) httpLog.warn('request rejected', fields)
      else httpLog.info('request', fields)
    }
    response.on('finish', logRequest)
    response.on('close', logRequest)

    if (request.method !== 'OPTIONS') {
      const authError = checkRequestAuthorization(request, options)
      if (authError) {
        sendJson(response, 401, { success: false, error: authError }, options.corsOrigin)
        return
      }
    }
    const requestContext = getRuntimeRequestContext(request, options)
    void handleRequest({
      request,
      response,
      url,
      runtime: options.runtime,
      corsOrigin: options.corsOrigin,
      requestContext,
      rpcContext: createServerRpcDispatchContext(options.workspaceRoot, requestContext),
    }).catch(error => {
      sendJson(response, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }, options.corsOrigin)
    })
  }
}

async function handleRequest(context: RouteContext): Promise<void> {
  if (context.request.method === 'OPTIONS') {
    sendOptions(context.response, context.corsOrigin)
    return
  }

  const route = matchRoute(context.request.method || 'GET', context.url.pathname)
  if (!route) {
    sendJson(context.response, 404, { success: false, error: 'Not found' }, context.corsOrigin)
    return
  }

  await route(context)
}

function matchRoute(method: string, pathname: string): RouteHandler | undefined {
  if (method === 'GET' && pathname === '/api/capabilities') return handleGetCapabilities
  if (method === 'GET' && pathname === '/api/settings') return handleGetSettings
  if (method === 'POST' && pathname === '/api/settings') return handleUpdateSettings
  if (method === 'POST' && pathname === '/api/network/test-proxy') return handleTestProxy
  if (method === 'POST' && pathname === '/api/search/query') return handleSearchQuery
  if (method === 'POST' && pathname === '/api/search/actions') return handleSearchAction
  if (method === 'GET' && pathname === '/api/themes') return handleGetThemes
  if (method === 'POST' && pathname === '/api/themes/refresh') return handleRefreshThemes
  if (method === 'POST' && pathname === '/api/themes/open-folder') return handleOpenThemesFolder
  if (method === 'GET' && pathname === '/api/skills') return handleListSkills
  if (method === 'POST' && pathname === '/api/skills') return handleCreateSkill
  if (method === 'POST' && pathname === '/api/skills/refresh') return handleRefreshSkills
  if (method === 'POST' && pathname === '/api/skills/read-file') return handleReadSkillFile
  if (method === 'POST' && pathname === '/api/skills/open-directory') return handleOpenSkillDirectory
  if (method === 'POST' && pathname === '/api/skills/execute') return handleExecuteSkill
  if (method === 'GET' && pathname === '/api/plugins') return handleListPlugins
  if (method === 'POST' && pathname === '/api/plugins/enable') return handleEnablePlugin
  if (method === 'POST' && pathname === '/api/plugins/disable') return handleDisablePlugin
  if (method === 'POST' && pathname === '/api/plugins/refresh') return handleRefreshPlugins
  if (method === 'GET' && pathname === '/api/plugins/commands') return handlePluginCommands
  if (method === 'POST' && pathname === '/api/plugins/execute-command') return handleExecutePluginCommand
  if (method === 'POST' && pathname === '/api/oauth/start') return handleOAuthStart
  if (method === 'POST' && pathname === '/api/oauth/callback') return handleOAuthCallback
  if (method === 'POST' && pathname === '/api/oauth/device-poll') return handleOAuthDevicePoll
  if (method === 'POST' && pathname === '/api/oauth/refresh') return handleOAuthRefresh
  if (method === 'POST' && pathname === '/api/oauth/status') return handleOAuthStatus
  if (method === 'POST' && pathname === '/api/oauth/logout') return handleOAuthLogout
  if (method === 'GET' && pathname === '/api/oauth/events') return handleOAuthEvents
  if (method === 'GET' && pathname === '/api/gateway/status') return handleGatewayGetStatus
  if (method === 'POST' && pathname === '/api/gateway/start') return handleGatewayStart
  if (method === 'POST' && pathname === '/api/gateway/stop') return handleGatewayStop
  if (method === 'POST' && pathname === '/api/gateway/wechat/logout') return handleGatewayWechatLogout
  if (method === 'POST' && pathname === '/api/gateway/wechat/accounts/add') return handleGatewayWechatAddAccount
  if (method === 'POST' && pathname === '/api/gateway/wechat/accounts/stop') return handleGatewayWechatStopAccount
  if (method === 'POST' && pathname === '/api/gateway/wechat/accounts/remove') return handleGatewayWechatRemoveAccount
  if (method === 'POST' && pathname === '/api/gateway/wechat/accounts/rename') return handleGatewayWechatRenameAccount
  if (method === 'GET' && pathname === '/api/voice/state') return handleVoiceGetState
  if (method === 'POST' && pathname === '/api/voice/start') return handleVoiceStart
  if (method === 'POST' && pathname === '/api/voice/stop') return handleVoiceStop
  if (method === 'POST' && pathname === '/api/voice/submit-utterance') return handleVoiceSubmitUtterance
  if (method === 'POST' && pathname === '/api/voice/submit-transcript') return handleVoiceSubmitTranscript
  if (method === 'POST' && pathname === '/api/voice/synthesize') return handleVoiceSynthesize
  if (method === 'POST' && pathname === '/api/voice/test-asr') return handleVoiceTestASR
  if (method === 'POST' && pathname === '/api/voice/test-tts') return handleVoiceTestTTS
  if (method === 'POST' && pathname === '/api/voice/tts-models') return handleVoiceGetTTSModels
  if (method === 'POST' && pathname === '/api/voice/runtime-ready') return handleVoiceRuntimeReady
  if (method === 'POST' && pathname === '/api/voice/runtime-event') return handleVoiceRuntimeEvent
  if (method === 'GET' && pathname === '/api/voice/events') return handleVoiceEvents
  if (method === 'GET' && pathname === '/api/voice/runtime-commands') return handleVoiceRuntimeCommands
  if (method === 'GET' && pathname === '/api/acp/agents') return handleACPGetAgents
  if (method === 'POST' && pathname === '/api/acp/agents') return handleACPAddAgent
  if (method === 'POST' && pathname === '/api/acp/agents/update') return handleACPUpdateAgent
  if (method === 'POST' && pathname === '/api/acp/agents/remove') return handleACPRemoveAgent
  if (method === 'POST' && pathname === '/api/acp/agents/connect') return handleACPConnectAgent
  if (method === 'POST' && pathname === '/api/acp/agents/disconnect') return handleACPDisconnectAgent
  if (method === 'POST' && pathname === '/api/acp/agents/refresh') return handleACPRefreshAgent
  if (method === 'POST' && pathname === '/api/acp/sessions/cancel') return handleACPCancelSession
  if (method === 'GET' && pathname === '/api/todo-plan/events') return handleTodoPlanEvents
  if (method === 'GET' && pathname === '/api/scratchpad/events') return handleScratchpadEvents
  if (method === 'GET' && pathname === '/api/tools') return handleGetTools
  if (method === 'POST' && pathname === '/api/tools/execute') return handleExecuteTool
  if (method === 'POST' && pathname === '/api/tools/cancel') return handleCancelTool
  if (method === 'POST' && pathname === '/api/tools/update-call') return handleUpdateToolCall
  if (method === 'GET' && pathname === '/api/tools/background-jobs') return handleListBackgroundJobs
  if (method === 'GET' && pathname === '/api/mcp/servers') return handleMCPGetServers
  if (method === 'POST' && pathname === '/api/mcp/servers') return handleMCPAddServer
  if (method === 'GET' && pathname === '/api/mcp/tools') return handleMCPGetTools
  if (method === 'POST' && pathname === '/api/mcp/tools/call') return handleMCPCallTool
  if (method === 'GET' && pathname === '/api/mcp/resources') return handleMCPGetResources
  if (method === 'POST' && pathname === '/api/mcp/resources/read') return handleMCPReadResource
  if (method === 'GET' && pathname === '/api/mcp/prompts') return handleMCPGetPrompts
  if (method === 'POST' && pathname === '/api/mcp/prompts/get') return handleMCPGetPrompt
  if (method === 'POST' && pathname === '/api/mcp/config-file/read') return handleMCPReadConfigFile
  if (method === 'POST' && pathname === '/api/files/list') return handleListFiles
  if (method === 'POST' && pathname === '/api/dirs/list') return handleListDirs
  if (method === 'POST' && pathname === '/api/files/read') return handleReadFileContent
  if (method === 'POST' && pathname === '/api/files/save') return handleSaveFileContent
  if (method === 'POST' && pathname === '/api/files/rollback') return handleRollbackFile
  if (method === 'POST' && pathname === '/api/files/watch/start') return handleWatchWorkspace
  if (method === 'POST' && pathname === '/api/files/watch/stop') return handleUnwatchWorkspace
  if (method === 'GET' && pathname === '/api/files/watch/events') return handleWorkspaceFileEvents
  if (method === 'POST' && pathname === '/api/files/list-directory') return handleListDirectory
  if (method === 'POST' && pathname === '/api/files/stat') return handleStatPath
  if (method === 'POST' && pathname === '/api/files/create') return handleCreateFile
  if (method === 'POST' && pathname === '/api/files/create-directory') return handleCreateDirectory
  if (method === 'POST' && pathname === '/api/files/rename') return handleRenamePath
  if (method === 'POST' && pathname === '/api/files/delete') return handleDeletePath
  if (method === 'POST' && pathname === '/api/files/reveal') return handleRevealPath
  if (method === 'POST' && pathname === '/api/chat/history') return handleChatHistory
  if (method === 'POST' && pathname === '/api/chat/title') return handleGenerateTitle
  if (method === 'POST' && pathname === '/api/chat/messages') return handleChatMessages
  if (method === 'POST' && pathname === '/api/chat/token-usage') return handleChatTokenUsage
  // 通用 RPC 单路由(主线 T0):所有 router 域走这一条,加域不再往本文件加路由。
  if (method === 'POST' && pathname === '/api/rpc') return handleRpc
  if (method === 'POST' && pathname === '/api/chat/update-session-pin') return handleUpdateSessionPin
  if (method === 'POST' && pathname === '/api/chat/add-system-message') return handleAddSystemMessage
  if (method === 'POST' && pathname === '/api/chat/remove-system-marker') return handleRemoveSystemMarkerMessage
  if (method === 'POST' && pathname === '/api/chat/remove-message') return handleRemoveMessage
  if (method === 'POST' && pathname === '/api/chat/update-thinking-time') return handleUpdateMessageThinkingTime
  if (method === 'GET' && pathname === '/api/media/assets') return handleListMediaAssets
  if (method === 'POST' && pathname === '/api/media/ingest') return handleIngestMediaFiles
  if (method === 'POST' && pathname === '/api/media/assets/hide') return handleHideMediaAsset
  if (method === 'POST' && pathname === '/api/media/rebuild') return handleRebuildMediaLibrary
  if (method === 'POST' && pathname === '/api/media/gallery') return handleGetMediaGallery
  if (method === 'POST' && pathname === '/api/media/save-image') return handleSaveMediaImage
  if (method === 'GET' && pathname === '/api/media/legacy-images') return handleLoadAllMedia
  if (method === 'POST' && pathname === '/api/media/delete') return handleDeleteMedia
  if (method === 'POST' && pathname === '/api/media/clear-all') return handleClearAllMedia
  if (method === 'POST' && pathname === '/api/media/read-image') return handleReadMediaImageBase64
  if (method === 'POST' && pathname === '/api/media/preview/open') return handleOpenImagePreview
  if (method === 'POST' && pathname === '/api/media/preview/get') return handleGetImagePreview
  if (method === 'POST' && pathname === '/api/media/gallery/open') return handleOpenImageGallery
  if (method === 'GET' && pathname === '/api/media/events') return handleMediaEvents
  if (method === 'GET' && pathname === '/api/sessions') return handleListSessions
  if (method === 'POST' && pathname === '/api/sessions') return handleCreateSession
  if (method === 'POST' && pathname === '/api/sessions/branch') return handleCreateBranch
  if (method === 'POST' && pathname === '/api/session-messages/page') return handleMessagePage
  if (method === 'GET' && pathname === '/api/events') return handleEvents
  if (method === 'POST' && pathname === '/api/streams/abort') return handleAbortStream
  if (method === 'GET' && pathname === '/api/streams/active') return handleGetActiveStreams

  const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)(?:\/([^/]+))?$/)
  if (skillMatch) {
    const action = skillMatch[2]
    if (method === 'DELETE' && !action) return withSkillId(skillMatch[1], handleDeleteSkill)
    if (method === 'POST' && action === 'toggle') return withSkillId(skillMatch[1], handleToggleSkillEnabled)
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/)
  if (sessionMatch) {
    const action = sessionMatch[2]
    if (method === 'GET' && !action) return withSessionId(sessionMatch[1], handleGetSession)
    if (method === 'DELETE' && !action) return withSessionId(sessionMatch[1], handleDeleteSession)
    if (method === 'POST' && action === 'activate') return withSessionId(sessionMatch[1], handleActivateSession)
    if (method === 'POST' && action === 'switch') return withSessionId(sessionMatch[1], handleActivateSession)
    if (method === 'POST' && action === 'commands') return withSessionId(sessionMatch[1], handleEmitCommand)
    if (method === 'POST' && action === 'rename') return withSessionId(sessionMatch[1], handleRenameSession)
    if (method === 'POST' && action === 'archive') return withSessionId(sessionMatch[1], handleUpdateSessionArchive)
    if (method === 'POST' && action === 'working-directory') return withSessionId(sessionMatch[1], handleUpdateSessionWorkingDirectory)
    if (method === 'POST' && action === 'agent') return withSessionId(sessionMatch[1], handleUpdateSessionAgent)
    if (method === 'POST' && action === 'permission-mode') return withSessionId(sessionMatch[1], handleUpdateSessionPermissionMode)
    if (method === 'POST' && action === 'model') return withSessionId(sessionMatch[1], handleUpdateSessionModel)
    if (method === 'POST' && action === 'max-tokens') return withSessionId(sessionMatch[1], handleUpdateSessionMaxTokens)
    if (method === 'GET' && action === 'system-prompt-snapshot') return withSessionId(sessionMatch[1], handleGetSystemPromptSnapshot)
    if (method === 'GET' && action === 'events') return withSessionId(sessionMatch[1], handleEvents)
    if (method === 'GET' && action === 'user-markers') return withSessionId(sessionMatch[1], handleUserMarkers)
  }

  const themeMatch = pathname.match(/^\/api\/themes\/([^/]+)(?:\/([^/]+))?$/)
  if (themeMatch) {
    const action = themeMatch[2]
    if (method === 'GET' && !action) return withThemeId(themeMatch[1], handleGetTheme)
    if (method === 'POST' && action === 'apply') return withThemeId(themeMatch[1], handleApplyTheme)
  }

  const mcpServerMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)(?:\/([^/]+))?$/)
  if (mcpServerMatch) {
    const action = mcpServerMatch[2]
    if (method === 'POST' && action === 'update') return withMCPServerId(mcpServerMatch[1], handleMCPUpdateServer)
    if (method === 'DELETE' && !action) return withMCPServerId(mcpServerMatch[1], handleMCPRemoveServer)
    if (method === 'POST' && action === 'connect') return withMCPServerId(mcpServerMatch[1], handleMCPConnectServer)
    if (method === 'POST' && action === 'disconnect') return withMCPServerId(mcpServerMatch[1], handleMCPDisconnectServer)
    if (method === 'POST' && action === 'refresh') return withMCPServerId(mcpServerMatch[1], handleMCPRefreshServer)
  }

  const mcpOAuthLogoutMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/oauth\/logout$/)
  if (mcpOAuthLogoutMatch && method === 'POST') {
    return withMCPServerId(mcpOAuthLogoutMatch[1], handleMCPLogoutServer)
  }

  if (pathname === '/api/mcp/probe' && method === 'POST') {
    return handleMCPProbeServer
  }

  const backgroundJobMatch = pathname.match(/^\/api\/tools\/background-jobs\/([^/]+)\/stop$/)
  if (backgroundJobMatch && method === 'POST') {
    return withBackgroundJobId(backgroundJobMatch[1], handleStopBackgroundJob)
  }

  const permissionMatch = pathname.match(/^\/api\/permissions\/([^/]+)\/respond$/)
  if (permissionMatch && method === 'POST') {
    return withRequestId(permissionMatch[1], handlePermissionResponse)
  }

  // 统一插件请求通道(R2)。方案 A 下 server 上没有插件执行面,这条路由存在的
  // 唯一目的就是**不静默**:调用方拿到一条能读懂的 501,而不是 404 或者一个
  // 永远 pending 的请求。将来 server 真跑插件时,替换 handler 即可,协议不变。
  const pluginRequestMatch = pathname.match(/^\/api\/plugins\/([^/]+)\/([^/]+)$/)
  if (pluginRequestMatch && method === 'POST') {
    return withPluginRequestTarget(pluginRequestMatch[1], pluginRequestMatch[2], handlePluginRequest)
  }

  const mediaFileMatch = pathname.match(/^\/api\/media\/file\/([^/]+)$/)
  if (mediaFileMatch && method === 'GET') {
    return withMediaFileName(mediaFileMatch[1], handleReadMediaFile)
  }

  return undefined
}

function withSessionId(encodedSessionId: string, handler: RouteHandler): RouteHandler {
  return (context) => {
    context.url.searchParams.set('sessionId', decodeURIComponent(encodedSessionId))
    return handler(context)
  }
}

function withRequestId(encodedRequestId: string, handler: RouteHandler): RouteHandler {
  return (context) => {
    context.url.searchParams.set('requestId', decodeURIComponent(encodedRequestId))
    return handler(context)
  }
}

function withMCPServerId(encodedServerId: string, handler: RouteHandler): RouteHandler {
  return (context) => {
    context.url.searchParams.set('serverId', decodeURIComponent(encodedServerId))
    return handler(context)
  }
}

function withBackgroundJobId(encodedJobId: string, handler: RouteHandler): RouteHandler {
  return (context) => {
    context.url.searchParams.set('jobId', decodeURIComponent(encodedJobId))
    return handler(context)
  }
}

function withThemeId(encodedThemeId: string, handler: RouteHandler): RouteHandler {
  return (context) => {
    context.url.searchParams.set('themeId', decodeURIComponent(encodedThemeId))
    return handler(context)
  }
}

function withSkillId(encodedSkillId: string, handler: RouteHandler): RouteHandler {
  return (context) => {
    context.url.searchParams.set('skillId', decodeURIComponent(encodedSkillId))
    return handler(context)
  }
}

function withPluginRequestTarget(
  encodedPluginId: string,
  encodedAction: string,
  handler: RouteHandler,
): RouteHandler {
  return (context) => {
    context.url.searchParams.set('pluginId', decodeURIComponent(encodedPluginId))
    context.url.searchParams.set('action', decodeURIComponent(encodedAction))
    return handler(context)
  }
}

function withMediaFileName(encodedFileName: string, handler: RouteHandler): RouteHandler {
  return (context) => {
    context.url.searchParams.set('fileName', decodeURIComponent(encodedFileName))
    return handler(context)
  }
}

async function handleGetCapabilities(context: RouteContext): Promise<void> {
  const adapter = context.runtime.capabilities
  if (!adapter) return sendNotImplemented(context, 'capabilities.get')
  sendJson(context.response, 200, await adapter.get(context.requestContext), context.corsOrigin)
}

async function handleListFiles(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.listFiles) return sendNotImplemented(context, 'files.listFiles')
  sendJson(context.response, 200, await adapter.listFiles(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleListDirs(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.listDirs) return sendNotImplemented(context, 'files.listDirs')
  sendJson(context.response, 200, await adapter.listDirs(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleReadFileContent(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.readContent) return sendNotImplemented(context, 'files.readContent')
  const body = await readJson<{ path?: string; maxSize?: number }>(context.request)
  sendJson(context.response, 200, await adapter.readContent(body?.path ?? '', body?.maxSize, context.requestContext), context.corsOrigin)
}

async function handleSaveFileContent(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.saveContent) return sendNotImplemented(context, 'files.saveContent')
  const body = await readJson<{ path?: string; content?: string; expectedMtimeMs?: number }>(context.request)
  sendJson(
    context.response,
    200,
    await adapter.saveContent(body?.path ?? '', body?.content ?? '', body?.expectedMtimeMs, context.requestContext),
    context.corsOrigin,
  )
}

async function handleRollbackFile(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.rollback) return sendNotImplemented(context, 'files.rollback')
  sendJson(context.response, 200, await adapter.rollback(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleWatchWorkspace(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.watchWorkspace) return sendNotImplemented(context, 'files.watchWorkspace')
  const body = await readJson<{ root?: string }>(context.request)
  sendJson(context.response, 200, await adapter.watchWorkspace(body?.root ?? '', context.requestContext), context.corsOrigin)
}

async function handleUnwatchWorkspace(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.unwatchWorkspace) return sendNotImplemented(context, 'files.unwatchWorkspace')
  const body = await readJson<{ root?: string }>(context.request)
  sendJson(context.response, 200, await adapter.unwatchWorkspace(body?.root ?? '', context.requestContext), context.corsOrigin)
}

async function handleListDirectory(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.listDirectory) return sendNotImplemented(context, 'files.listDirectory')
  const body = await readJson<{ path?: string }>(context.request)
  sendJson(context.response, 200, await adapter.listDirectory(body?.path ?? '', context.requestContext), context.corsOrigin)
}

async function handleStatPath(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.stat) return sendNotImplemented(context, 'files.stat')
  const body = await readJson<{ path?: string }>(context.request)
  sendJson(context.response, 200, await adapter.stat(body?.path ?? '', context.requestContext), context.corsOrigin)
}

async function handleCreateFile(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.createFile) return sendNotImplemented(context, 'files.createFile')
  const body = await readJson<{ path?: string; content?: string }>(context.request)
  sendJson(context.response, 200, await adapter.createFile(body?.path ?? '', body?.content, context.requestContext), context.corsOrigin)
}

async function handleCreateDirectory(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.createDirectory) return sendNotImplemented(context, 'files.createDirectory')
  const body = await readJson<{ path?: string }>(context.request)
  sendJson(context.response, 200, await adapter.createDirectory(body?.path ?? '', context.requestContext), context.corsOrigin)
}

async function handleRenamePath(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.renamePath) return sendNotImplemented(context, 'files.renamePath')
  const body = await readJson<{ oldPath?: string; newPath?: string }>(context.request)
  sendJson(context.response, 200, await adapter.renamePath(body?.oldPath ?? '', body?.newPath ?? '', context.requestContext), context.corsOrigin)
}

async function handleDeletePath(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.deletePath) return sendNotImplemented(context, 'files.deletePath')
  const body = await readJson<{ path?: string }>(context.request)
  sendJson(context.response, 200, await adapter.deletePath(body?.path ?? '', context.requestContext), context.corsOrigin)
}

async function handleRevealPath(context: RouteContext): Promise<void> {
  const adapter = context.runtime.files
  if (!adapter?.revealPath) return sendNotImplemented(context, 'files.revealPath')
  const body = await readJson<{ path?: string }>(context.request)
  sendJson(context.response, 200, await adapter.revealPath(body?.path ?? '', context.requestContext), context.corsOrigin)
}

async function handleChatHistory(context: RouteContext): Promise<void> {
  const adapter = context.runtime.chat
  if (!adapter?.getHistory) return sendNotImplemented(context, 'chat.getHistory')
  const body = await readJson<{ sessionId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.getHistory(body?.sessionId ?? '', context.requestContext), context.corsOrigin)
}

async function handleGenerateTitle(context: RouteContext): Promise<void> {
  const adapter = context.runtime.chat
  if (!adapter?.generateTitle) return sendNotImplemented(context, 'chat.generateTitle')
  const body = await readJson<{ message?: string }>(context.request)
  sendJson(context.response, 200, await adapter.generateTitle(body?.message ?? '', context.requestContext), context.corsOrigin)
}

async function handleChatMessages(context: RouteContext): Promise<void> {
  const adapter = context.runtime.chat
  if (!adapter?.getMessages) return sendNotImplemented(context, 'chat.getMessages')
  const body = await readJson<{ sessionId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.getMessages(body?.sessionId ?? '', context.requestContext), context.corsOrigin)
}

async function handleChatTokenUsage(context: RouteContext): Promise<void> {
  const adapter = context.runtime.chat
  if (!adapter?.getTokenUsage) return sendNotImplemented(context, 'chat.getTokenUsage')
  const body = await readJson<{ sessionId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.getTokenUsage(body?.sessionId ?? '', context.requestContext), context.corsOrigin)
}

/**
 * The generic RPC adapter — server half (主线 T0).
 *
 * One route for every domain, forever. It sits behind the same bearer-auth
 * gate as every other `/api` route (checked in the request handler before any
 * route matching) and hands the envelope straight to the assembly layer's
 * dispatch table; nothing about a domain is known here.
 *
 * Always 200 with an `RpcResponse` body: the failure shape must be identical
 * across IPC and HTTP, and the renderer client is the one place that turns
 * `{ ok:false }` into a throw. A malformed body is an RPC-level error too, not
 * an HTTP one.
 */
async function handleRpc(context: RouteContext): Promise<void> {
  let request: RpcRequest
  try {
    request = await readJson<RpcRequest>(context.request)
  } catch (error) {
    sendJson(context.response, 200, {
      ok: false,
      error: {
        message: `Invalid RPC request body: ${error instanceof Error ? error.message : String(error)}`,
        code: RPC_ERROR_CODES.BAD_REQUEST,
      },
    } satisfies RpcResponse, context.corsOrigin)
    return
  }
  sendJson(context.response, 200, await dispatchRpc(request, context.rpcContext), context.corsOrigin)
}

async function handleUpdateSessionPin(context: RouteContext): Promise<void> {
  const adapter = context.runtime.chat
  if (!adapter?.updateSessionPin) return sendNotImplemented(context, 'chat.updateSessionPin')
  const body = await readJson<{ sessionId?: string; isPinned?: boolean }>(context.request)
  sendJson(
    context.response,
    200,
    await adapter.updateSessionPin(body?.sessionId ?? '', Boolean(body?.isPinned), context.requestContext),
    context.corsOrigin,
  )
}

async function handleAddSystemMessage(context: RouteContext): Promise<void> {
  const adapter = context.runtime.chat
  if (!adapter?.addSystemMessage) return sendNotImplemented(context, 'chat.addSystemMessage')
  const body = await readJson<{ sessionId?: string; message?: unknown }>(context.request)
  sendJson(context.response, 200, await adapter.addSystemMessage(body?.sessionId ?? '', body?.message, context.requestContext), context.corsOrigin)
}

async function handleRemoveSystemMarkerMessage(context: RouteContext): Promise<void> {
  const adapter = context.runtime.chat
  if (!adapter?.removeSystemMarkerMessage) return sendNotImplemented(context, 'chat.removeSystemMarkerMessage')
  const body = await readJson<{ sessionId?: string; markerType?: string }>(context.request)
  sendJson(context.response, 200, await adapter.removeSystemMarkerMessage(body?.sessionId ?? '', body?.markerType ?? '', context.requestContext), context.corsOrigin)
}

async function handleRemoveMessage(context: RouteContext): Promise<void> {
  const adapter = context.runtime.chat
  if (!adapter?.removeMessage) return sendNotImplemented(context, 'chat.removeMessage')
  const body = await readJson<{ sessionId?: string; messageId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.removeMessage(body?.sessionId ?? '', body?.messageId ?? '', context.requestContext), context.corsOrigin)
}

async function handleUpdateMessageThinkingTime(context: RouteContext): Promise<void> {
  const adapter = context.runtime.chat
  if (!adapter?.updateMessageThinkingTime) return sendNotImplemented(context, 'chat.updateMessageThinkingTime')
  const body = await readJson<{ sessionId?: string; messageId?: string; thinkingTime?: number }>(context.request)
  sendJson(
    context.response,
    200,
    await adapter.updateMessageThinkingTime(
      body?.sessionId ?? '',
      body?.messageId ?? '',
      typeof body?.thinkingTime === 'number' ? body.thinkingTime : 0,
      context.requestContext,
    ),
    context.corsOrigin,
  )
}

async function handleListMediaAssets(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.listAssets) return sendNotImplemented(context, 'media.listAssets')
  sendJson(context.response, 200, await adapter.listAssets(readMediaQuery(context), context.requestContext), context.corsOrigin)
}

async function handleIngestMediaFiles(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.ingestFiles) return sendNotImplemented(context, 'media.ingestFiles')
  // 请求整体透传:files/source/links 是共享契约,拆字段只会让服务端悄悄吞掉新字段。
  sendJson(context.response, 200, await adapter.ingestFiles(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleHideMediaAsset(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.hideAsset) return sendNotImplemented(context, 'media.hideAsset')
  const body = await readJson<{ id?: string }>(context.request)
  sendJson(context.response, 200, await adapter.hideAsset(body?.id ?? '', context.requestContext), context.corsOrigin)
}

async function handleRebuildMediaLibrary(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.rebuildLibrary) return sendNotImplemented(context, 'media.rebuildLibrary')
  sendJson(context.response, 200, await adapter.rebuildLibrary(context.requestContext), context.corsOrigin)
}

async function handleGetMediaGallery(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.getGallery) return sendNotImplemented(context, 'media.getGallery')
  const body = await readJson<{ assetId?: string; query?: unknown }>(context.request)
  sendJson(context.response, 200, await adapter.getGallery(body?.assetId ?? '', body?.query, context.requestContext), context.corsOrigin)
}

async function handleSaveMediaImage(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.saveImage) return sendNotImplemented(context, 'media.saveImage')
  sendJson(context.response, 200, await adapter.saveImage(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleLoadAllMedia(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.loadAll) return sendNotImplemented(context, 'media.loadAll')
  sendJson(context.response, 200, await adapter.loadAll(context.requestContext), context.corsOrigin)
}

async function handleDeleteMedia(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.delete) return sendNotImplemented(context, 'media.delete')
  const body = await readJson<{ id?: string }>(context.request)
  sendJson(context.response, 200, await adapter.delete(body?.id ?? '', context.requestContext), context.corsOrigin)
}

async function handleClearAllMedia(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.clearAll) return sendNotImplemented(context, 'media.clearAll')
  sendJson(context.response, 200, await adapter.clearAll(context.requestContext) ?? { success: true }, context.corsOrigin)
}

async function handleReadMediaImageBase64(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.readImageBase64) return sendNotImplemented(context, 'media.readImageBase64')
  const body = await readJson<{ filePath?: string }>(context.request)
  sendJson(context.response, 200, await adapter.readImageBase64(body?.filePath ?? '', context.requestContext), context.corsOrigin)
}

async function handleOpenImagePreview(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.openPreview) return sendNotImplemented(context, 'media.openPreview')
  const body = await readJson<{ src?: string; alt?: string }>(context.request)
  sendJson(context.response, 200, await adapter.openPreview(body?.src ?? '', body?.alt, context.requestContext), context.corsOrigin)
}

async function handleGetImagePreview(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.getPreview) return sendNotImplemented(context, 'media.getPreview')
  const body = await readJson<{ previewId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.getPreview(body?.previewId ?? '', context.requestContext), context.corsOrigin)
}

async function handleOpenImageGallery(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.openGallery) return sendNotImplemented(context, 'media.openGallery')
  const body = await readJson<{ mediaId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.openGallery(body?.mediaId ?? '', context.requestContext), context.corsOrigin)
}

async function handleReadMediaFile(context: RouteContext): Promise<void> {
  const adapter = context.runtime.media
  if (!adapter?.resolveFile) return sendNotImplemented(context, 'media.resolveFile')
  const result = await adapter.resolveFile(context.url.searchParams.get('fileName') ?? '', context.requestContext)
  if (!result.success || !result.path) {
    sendJson(context.response, 404, { success: false, error: result.error || 'Media file not found' }, context.corsOrigin)
    return
  }

  context.response.writeHead(200, {
    ...corsHeaders(context.corsOrigin),
    'content-type': result.mimeType || 'application/octet-stream',
    'cache-control': 'private, max-age=300',
  })
  createReadStream(result.path).pipe(context.response)
}

async function handleGetSettings(context: RouteContext): Promise<void> {
  const adapter = context.runtime.settings
  if (!adapter) return sendNotImplemented(context, 'settings.get')
  sendJson(context.response, 200, await adapter.get(context.requestContext), context.corsOrigin)
}

async function handleUpdateSettings(context: RouteContext): Promise<void> {
  const adapter = context.runtime.settings
  if (!adapter) return sendNotImplemented(context, 'settings.update')
  sendJson(context.response, 200, await adapter.update(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleTestProxy(context: RouteContext): Promise<void> {
  const adapter = context.runtime.network
  if (!adapter) return sendNotImplemented(context, 'network.testProxy')
  const body = await readJson<{ proxy?: ProxySettings }>(context.request)
  sendJson(context.response, 200, await adapter.testProxy(body?.proxy ?? { enabled: false, url: '' }, context.requestContext), context.corsOrigin)
}

async function handleSearchQuery(context: RouteContext): Promise<void> {
  const adapter = context.runtime.search
  if (!adapter) return sendNotImplemented(context, 'search.query')
  sendJson(context.response, 200, await adapter.query(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleSearchAction(context: RouteContext): Promise<void> {
  const adapter = context.runtime.search
  if (!adapter) return sendNotImplemented(context, 'search.executeAction')
  const body = await readJson<{ actionId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.executeAction(body?.actionId || '', context.requestContext), context.corsOrigin)
}

async function handleGetThemes(context: RouteContext): Promise<void> {
  const adapter = context.runtime.themes
  if (!adapter) return sendNotImplemented(context, 'themes.getThemes')
  sendJson(context.response, 200, await adapter.getThemes(context.requestContext), context.corsOrigin)
}

async function handleGetTheme(context: RouteContext): Promise<void> {
  const adapter = context.runtime.themes
  if (!adapter) return sendNotImplemented(context, 'themes.getTheme')
  sendJson(context.response, 200, await adapter.getTheme(readThemeId(context), context.requestContext), context.corsOrigin)
}

async function handleApplyTheme(context: RouteContext): Promise<void> {
  const adapter = context.runtime.themes
  if (!adapter) return sendNotImplemented(context, 'themes.applyTheme')
  const body = await readJson<{ mode?: 'dark' | 'light' }>(context.request)
  const mode = body?.mode === 'light' ? 'light' : 'dark'
  sendJson(context.response, 200, await adapter.applyTheme(readThemeId(context), mode, context.requestContext), context.corsOrigin)
}

async function handleRefreshThemes(context: RouteContext): Promise<void> {
  const adapter = context.runtime.themes
  if (!adapter) return sendNotImplemented(context, 'themes.refreshThemes')
  const body = await readJson<{ projectPath?: string }>(context.request)
  sendJson(context.response, 200, await adapter.refreshThemes(body?.projectPath, context.requestContext), context.corsOrigin)
}

async function handleOpenThemesFolder(context: RouteContext): Promise<void> {
  const adapter = context.runtime.themes
  if (!adapter?.openThemesFolder) return sendNotImplemented(context, 'themes.openThemesFolder')
  sendJson(context.response, 200, await adapter.openThemesFolder(context.requestContext), context.corsOrigin)
}

async function handleGetSystemPromptSnapshot(context: RouteContext): Promise<void> {
  const adapter = context.runtime.prompts
  if (!adapter) return sendNotImplemented(context, 'prompts.getSystemPromptSnapshot')
  sendJson(
    context.response,
    200,
    await adapter.getSystemPromptSnapshot(readSessionId(context), context.requestContext),
    context.corsOrigin,
  )
}

async function handleListSkills(context: RouteContext): Promise<void> {
  const adapter = context.runtime.skills
  if (!adapter?.list) return sendNotImplemented(context, 'skills.list')
  const workingDirectory = context.url.searchParams.get('workingDirectory') || undefined
  sendJson(context.response, 200, await adapter.list(workingDirectory, context.requestContext), context.corsOrigin)
}

async function handleRefreshSkills(context: RouteContext): Promise<void> {
  const adapter = context.runtime.skills
  if (!adapter?.refresh) return sendNotImplemented(context, 'skills.refresh')
  sendJson(context.response, 200, await adapter.refresh(context.requestContext), context.corsOrigin)
}

async function handleReadSkillFile(context: RouteContext): Promise<void> {
  const adapter = context.runtime.skills
  if (!adapter?.readFile) return sendNotImplemented(context, 'skills.readFile')
  const body = await readJson<{ skillId?: string; fileName?: string }>(context.request)
  sendJson(
    context.response,
    200,
    await adapter.readFile(body?.skillId || '', body?.fileName || '', context.requestContext),
    context.corsOrigin,
  )
}

async function handleOpenSkillDirectory(context: RouteContext): Promise<void> {
  const adapter = context.runtime.skills
  if (!adapter?.openDirectory) return sendNotImplemented(context, 'skills.openDirectory')
  const body = await readJson<{ skillId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.openDirectory(body?.skillId, context.requestContext), context.corsOrigin)
}

async function handleCreateSkill(context: RouteContext): Promise<void> {
  const adapter = context.runtime.skills
  if (!adapter?.create) return sendNotImplemented(context, 'skills.create')
  sendJson(context.response, 200, await adapter.create(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleDeleteSkill(context: RouteContext): Promise<void> {
  const adapter = context.runtime.skills
  if (!adapter?.delete) return sendNotImplemented(context, 'skills.delete')
  sendJson(context.response, 200, await adapter.delete(readSkillId(context), context.requestContext), context.corsOrigin)
}

async function handleToggleSkillEnabled(context: RouteContext): Promise<void> {
  const adapter = context.runtime.skills
  if (!adapter?.toggleEnabled) return sendNotImplemented(context, 'skills.toggleEnabled')
  const body = await readJson<{ enabled?: boolean }>(context.request)
  sendJson(context.response, 200, await adapter.toggleEnabled(readSkillId(context), Boolean(body?.enabled), context.requestContext), context.corsOrigin)
}

async function handleExecuteSkill(context: RouteContext): Promise<void> {
  const adapter = context.runtime.skills
  if (!adapter?.execute) return sendNotImplemented(context, 'skills.execute')
  const body = await readJson<{ skillId?: string; options?: unknown }>(context.request)
  sendJson(context.response, 200, await adapter.execute(body?.skillId || '', body?.options, context.requestContext), context.corsOrigin)
}

async function handleListPlugins(context: RouteContext): Promise<void> {
  const adapter = context.runtime.plugins
  if (!adapter?.list) return sendNotImplemented(context, 'plugins.list')
  sendJson(context.response, 200, await adapter.list(context.requestContext), context.corsOrigin)
}

async function handleEnablePlugin(context: RouteContext): Promise<void> {
  const adapter = context.runtime.plugins
  if (!adapter?.enable) return sendNotImplemented(context, 'plugins.enable')
  const body = await readJson<{ pluginId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.enable(body?.pluginId || '', context.requestContext), context.corsOrigin)
}

async function handleDisablePlugin(context: RouteContext): Promise<void> {
  const adapter = context.runtime.plugins
  if (!adapter?.disable) return sendNotImplemented(context, 'plugins.disable')
  const body = await readJson<{ pluginId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.disable(body?.pluginId || '', context.requestContext), context.corsOrigin)
}

async function handleRefreshPlugins(context: RouteContext): Promise<void> {
  const adapter = context.runtime.plugins
  if (!adapter?.refresh) return sendNotImplemented(context, 'plugins.refresh')
  sendJson(context.response, 200, await adapter.refresh(context.requestContext), context.corsOrigin)
}

async function handlePluginCommands(context: RouteContext): Promise<void> {
  const adapter = context.runtime.plugins
  if (!adapter?.commands) return sendNotImplemented(context, 'plugins.commands')
  sendJson(context.response, 200, await adapter.commands(context.requestContext), context.corsOrigin)
}

async function handleExecutePluginCommand(context: RouteContext): Promise<void> {
  const adapter = context.runtime.plugins
  if (!adapter?.executeCommand) return sendNotImplemented(context, 'plugins.executeCommand')
  sendJson(context.response, 200, await adapter.executeCommand(await readJson(context.request), context.requestContext), context.corsOrigin)
}

/**
 * 插件请求通道 —— 桌面-only(设计文档 §6 已拍板的方案 A)。
 *
 * apps/server 的插件目录是只读镜像:ServerPluginCatalogManager 的 entry 全是
 * noop,插件代码在 server 上从不执行。所以这里返回一条**说明了原因**的 501,
 * 而不是让请求悄无声息地消失。
 */
async function handlePluginRequest(context: RouteContext): Promise<void> {
  const pluginId = context.url.searchParams.get('pluginId') || ''
  const action = context.url.searchParams.get('action') || ''
  sendJson(context.response, 501, {
    success: false,
    error: 'Plugins execute on the desktop host only; this server mirrors the plugin catalog read-only.',
    pluginId,
    action,
    host: 'server',
  }, context.corsOrigin)
}

async function handleOAuthStart(context: RouteContext): Promise<void> {
  const adapter = context.runtime.oauth
  if (!adapter) return sendNotImplemented(context, 'oauth.start')
  const body = await readJson<{ providerId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.start(body?.providerId || '', context.requestContext), context.corsOrigin)
}

async function handleOAuthCallback(context: RouteContext): Promise<void> {
  const adapter = context.runtime.oauth
  if (!adapter) return sendNotImplemented(context, 'oauth.callback')
  sendJson(context.response, 200, await adapter.callback(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleOAuthDevicePoll(context: RouteContext): Promise<void> {
  const adapter = context.runtime.oauth
  if (!adapter) return sendNotImplemented(context, 'oauth.devicePoll')
  sendJson(context.response, 200, await adapter.devicePoll(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleOAuthRefresh(context: RouteContext): Promise<void> {
  const adapter = context.runtime.oauth
  if (!adapter) return sendNotImplemented(context, 'oauth.refresh')
  const body = await readJson<{ providerId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.refresh(body?.providerId || '', context.requestContext), context.corsOrigin)
}

async function handleOAuthStatus(context: RouteContext): Promise<void> {
  const adapter = context.runtime.oauth
  if (!adapter) return sendNotImplemented(context, 'oauth.status')
  const body = await readJson<{ providerId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.status(body?.providerId || '', context.requestContext), context.corsOrigin)
}

async function handleOAuthLogout(context: RouteContext): Promise<void> {
  const adapter = context.runtime.oauth
  if (!adapter) return sendNotImplemented(context, 'oauth.logout')
  const body = await readJson<{ providerId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.logout(body?.providerId || '', context.requestContext), context.corsOrigin)
}

function handleOAuthEvents(context: RouteContext): void {
  const adapter = context.runtime.oauth
  if (!adapter?.subscribe) {
    sendNotImplemented(context, 'oauth.subscribe')
    return
  }

  context.response.writeHead(200, {
    ...corsHeaders(context.corsOrigin),
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  context.response.write('\n')

  const unsubscribe = adapter.subscribe((event) => {
    writeSse(context.response, event.type, event)
  }, context.requestContext)
  context.request.on('close', unsubscribe)
}

async function handleGatewayGetStatus(context: RouteContext): Promise<void> {
  const adapter = context.runtime.gateway
  if (!adapter) return sendNotImplemented(context, 'gateway.getStatus')
  sendJson(context.response, 200, await adapter.getStatus(context.requestContext), context.corsOrigin)
}

async function handleGatewayStart(context: RouteContext): Promise<void> {
  const adapter = context.runtime.gateway
  if (!adapter) return sendNotImplemented(context, 'gateway.start')
  sendJson(context.response, 200, await adapter.start(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleGatewayStop(context: RouteContext): Promise<void> {
  const adapter = context.runtime.gateway
  if (!adapter) return sendNotImplemented(context, 'gateway.stop')
  sendJson(context.response, 200, await adapter.stop(context.requestContext), context.corsOrigin)
}

async function handleGatewayWechatLogout(context: RouteContext): Promise<void> {
  const adapter = context.runtime.gateway
  if (!adapter) return sendNotImplemented(context, 'gateway.wechatLogout')
  sendJson(context.response, 200, await adapter.wechatLogout(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleGatewayWechatAddAccount(context: RouteContext): Promise<void> {
  const adapter = context.runtime.gateway
  if (!adapter?.wechatAddAccount) return sendNotImplemented(context, 'gateway.wechatAddAccount')
  sendJson(context.response, 200, await adapter.wechatAddAccount(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleGatewayWechatStopAccount(context: RouteContext): Promise<void> {
  const adapter = context.runtime.gateway
  if (!adapter?.wechatStopAccount) return sendNotImplemented(context, 'gateway.wechatStopAccount')
  sendJson(context.response, 200, await adapter.wechatStopAccount(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleGatewayWechatRemoveAccount(context: RouteContext): Promise<void> {
  const adapter = context.runtime.gateway
  if (!adapter?.wechatRemoveAccount) return sendNotImplemented(context, 'gateway.wechatRemoveAccount')
  sendJson(context.response, 200, await adapter.wechatRemoveAccount(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleGatewayWechatRenameAccount(context: RouteContext): Promise<void> {
  const adapter = context.runtime.gateway
  if (!adapter?.wechatRenameAccount) return sendNotImplemented(context, 'gateway.wechatRenameAccount')
  sendJson(context.response, 200, await adapter.wechatRenameAccount(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleVoiceGetState(context: RouteContext): Promise<void> {
  const adapter = context.runtime.voice
  if (!adapter) return sendNotImplemented(context, 'voice.getState')
  sendJson(context.response, 200, await adapter.getState(context.requestContext), context.corsOrigin)
}

async function handleVoiceStart(context: RouteContext): Promise<void> {
  const adapter = context.runtime.voice
  if (!adapter) return sendNotImplemented(context, 'voice.start')
  sendJson(context.response, 200, await adapter.start(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleVoiceStop(context: RouteContext): Promise<void> {
  const adapter = context.runtime.voice
  if (!adapter) return sendNotImplemented(context, 'voice.stop')
  sendJson(context.response, 200, await adapter.stop(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleVoiceSubmitUtterance(context: RouteContext): Promise<void> {
  const adapter = context.runtime.voice
  if (!adapter) return sendNotImplemented(context, 'voice.submitUtterance')
  sendJson(context.response, 200, await adapter.submitUtterance(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleVoiceSubmitTranscript(context: RouteContext): Promise<void> {
  const adapter = context.runtime.voice
  if (!adapter) return sendNotImplemented(context, 'voice.submitTranscript')
  sendJson(context.response, 200, await adapter.submitTranscript(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleVoiceSynthesize(context: RouteContext): Promise<void> {
  const adapter = context.runtime.voice
  if (!adapter) return sendNotImplemented(context, 'voice.synthesize')
  sendJson(context.response, 200, await adapter.synthesize(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleVoiceTestASR(context: RouteContext): Promise<void> {
  const adapter = context.runtime.voice
  if (!adapter) return sendNotImplemented(context, 'voice.testASR')
  sendJson(context.response, 200, await adapter.testASR(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleVoiceTestTTS(context: RouteContext): Promise<void> {
  const adapter = context.runtime.voice
  if (!adapter) return sendNotImplemented(context, 'voice.testTTS')
  sendJson(context.response, 200, await adapter.testTTS(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleVoiceGetTTSModels(context: RouteContext): Promise<void> {
  const adapter = context.runtime.voice
  if (!adapter) return sendNotImplemented(context, 'voice.getTTSModels')
  sendJson(context.response, 200, await adapter.getTTSModels(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleVoiceRuntimeReady(context: RouteContext): Promise<void> {
  const adapter = context.runtime.voice
  if (!adapter) return sendNotImplemented(context, 'voice.runtimeReady')
  sendJson(context.response, 200, await adapter.runtimeReady(context.requestContext), context.corsOrigin)
}

async function handleVoiceRuntimeEvent(context: RouteContext): Promise<void> {
  const adapter = context.runtime.voice
  if (!adapter) return sendNotImplemented(context, 'voice.runtimeEvent')
  sendJson(context.response, 200, await adapter.runtimeEvent(await readJson(context.request), context.requestContext), context.corsOrigin)
}

function handleVoiceEvents(context: RouteContext): void {
  const adapter = context.runtime.voice
  if (!adapter?.subscribeEvents) {
    sendNotImplemented(context, 'voice.subscribeEvents')
    return
  }

  context.response.writeHead(200, {
    ...corsHeaders(context.corsOrigin),
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  context.response.write('\n')

  const unsubscribe = adapter.subscribeEvents((event) => {
    writeSse(context.response, 'voice:event', event)
  }, context.requestContext)
  context.request.on('close', unsubscribe)
}

function handleVoiceRuntimeCommands(context: RouteContext): void {
  const adapter = context.runtime.voice
  if (!adapter?.subscribeRuntimeCommands) {
    sendNotImplemented(context, 'voice.subscribeRuntimeCommands')
    return
  }

  context.response.writeHead(200, {
    ...corsHeaders(context.corsOrigin),
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  context.response.write('\n')

  const unsubscribe = adapter.subscribeRuntimeCommands((command) => {
    writeSse(context.response, 'voice:runtime-command', command)
  }, context.requestContext)
  context.request.on('close', unsubscribe)
}

async function handleACPGetAgents(context: RouteContext): Promise<void> {
  const adapter = context.runtime.acp
  if (!adapter) return sendNotImplemented(context, 'acp.getAgents')
  sendJson(context.response, 200, await adapter.getAgents(context.requestContext), context.corsOrigin)
}

async function handleACPAddAgent(context: RouteContext): Promise<void> {
  const adapter = context.runtime.acp
  if (!adapter) return sendNotImplemented(context, 'acp.addAgent')
  const body = await readJson<{ config?: unknown }>(context.request)
  sendJson(context.response, 200, await adapter.addAgent(body?.config, context.requestContext), context.corsOrigin)
}

async function handleACPUpdateAgent(context: RouteContext): Promise<void> {
  const adapter = context.runtime.acp
  if (!adapter) return sendNotImplemented(context, 'acp.updateAgent')
  const body = await readJson<{ config?: unknown }>(context.request)
  sendJson(context.response, 200, await adapter.updateAgent(body?.config, context.requestContext), context.corsOrigin)
}

async function handleACPRemoveAgent(context: RouteContext): Promise<void> {
  const adapter = context.runtime.acp
  if (!adapter) return sendNotImplemented(context, 'acp.removeAgent')
  const body = await readJson<{ agentId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.removeAgent(body?.agentId || '', context.requestContext), context.corsOrigin)
}

async function handleACPConnectAgent(context: RouteContext): Promise<void> {
  const adapter = context.runtime.acp
  if (!adapter) return sendNotImplemented(context, 'acp.connectAgent')
  const body = await readJson<{ agentId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.connectAgent(body?.agentId || '', context.requestContext), context.corsOrigin)
}

async function handleACPDisconnectAgent(context: RouteContext): Promise<void> {
  const adapter = context.runtime.acp
  if (!adapter) return sendNotImplemented(context, 'acp.disconnectAgent')
  const body = await readJson<{ agentId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.disconnectAgent(body?.agentId || '', context.requestContext), context.corsOrigin)
}

async function handleACPRefreshAgent(context: RouteContext): Promise<void> {
  const adapter = context.runtime.acp
  if (!adapter) return sendNotImplemented(context, 'acp.refreshAgent')
  const body = await readJson<{ agentId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.refreshAgent(body?.agentId || '', context.requestContext), context.corsOrigin)
}

async function handleACPCancelSession(context: RouteContext): Promise<void> {
  const adapter = context.runtime.acp
  if (!adapter) return sendNotImplemented(context, 'acp.cancelSession')
  const body = await readJson<{ sessionId?: string; agentId?: string }>(context.request)
  sendJson(
    context.response,
    200,
    await adapter.cancelSession(body?.sessionId || '', body?.agentId, context.requestContext),
    context.corsOrigin,
  )
}

async function handleGetTools(context: RouteContext): Promise<void> {
  const adapter = context.runtime.tools
  if (!adapter) return sendNotImplemented(context, 'tools.getTools')
  sendJson(context.response, 200, await adapter.getTools(context.requestContext), context.corsOrigin)
}

async function handleExecuteTool(context: RouteContext): Promise<void> {
  const adapter = context.runtime.tools
  if (!adapter) return sendNotImplemented(context, 'tools.executeTool')
  const body = await readJson<{
    toolId?: string
    arguments?: JsonObject
    messageId?: string
    sessionId?: string
  }>(context.request)
  sendJson(
    context.response,
    200,
    await adapter.executeTool(
      body?.toolId || '',
      body?.arguments ?? {},
      body?.messageId || '',
      body?.sessionId || '',
      context.requestContext,
    ),
    context.corsOrigin,
  )
}

async function handleCancelTool(context: RouteContext): Promise<void> {
  const adapter = context.runtime.tools
  if (!adapter?.cancelTool) return sendNotImplemented(context, 'tools.cancelTool')
  const body = await readJson<{ toolCallId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.cancelTool(body?.toolCallId || '', context.requestContext), context.corsOrigin)
}

async function handleUpdateToolCall(context: RouteContext): Promise<void> {
  const adapter = context.runtime.tools
  if (!adapter?.updateToolCall) return sendNotImplemented(context, 'tools.updateToolCall')
  const body = await readJson<{
    sessionId?: string
    messageId?: string
    toolCallId?: string
    updates?: JsonObject
  }>(context.request)
  sendJson(
    context.response,
    200,
    await adapter.updateToolCall(
      body?.sessionId || '',
      body?.messageId || '',
      body?.toolCallId || '',
      body?.updates ?? {},
      context.requestContext,
    ),
    context.corsOrigin,
  )
}

async function handleListBackgroundJobs(context: RouteContext): Promise<void> {
  const adapter = context.runtime.tools
  if (!adapter?.listBackgroundJobs) return sendNotImplemented(context, 'tools.listBackgroundJobs')
  sendJson(context.response, 200, await adapter.listBackgroundJobs({
    includeInactive: context.url.searchParams.get('includeInactive') === 'true',
  }, context.requestContext), context.corsOrigin)
}

async function handleStopBackgroundJob(context: RouteContext): Promise<void> {
  const adapter = context.runtime.tools
  if (!adapter?.stopBackgroundJob) return sendNotImplemented(context, 'tools.stopBackgroundJob')
  sendJson(context.response, 200, await adapter.stopBackgroundJob(readBackgroundJobId(context), context.requestContext), context.corsOrigin)
}

async function handleMCPGetServers(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter) return sendNotImplemented(context, 'mcp.getServers')
  sendJson(context.response, 200, await adapter.getServers(context.requestContext), context.corsOrigin)
}

async function handleMCPAddServer(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter) return sendNotImplemented(context, 'mcp.addServer')
  sendJson(context.response, 200, await adapter.addServer(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleMCPUpdateServer(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter) return sendNotImplemented(context, 'mcp.updateServer')
  const config = await readJson<JsonObject>(context.request) ?? {}
  sendJson(context.response, 200, await adapter.updateServer({
    ...config,
    id: readMCPServerId(context),
  }, context.requestContext), context.corsOrigin)
}

async function handleMCPRemoveServer(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter) return sendNotImplemented(context, 'mcp.removeServer')
  sendJson(context.response, 200, await adapter.removeServer(readMCPServerId(context), context.requestContext), context.corsOrigin)
}

async function handleMCPConnectServer(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter) return sendNotImplemented(context, 'mcp.connectServer')
  sendJson(context.response, 200, await adapter.connectServer(readMCPServerId(context), context.requestContext), context.corsOrigin)
}

async function handleMCPDisconnectServer(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter) return sendNotImplemented(context, 'mcp.disconnectServer')
  sendJson(context.response, 200, await adapter.disconnectServer(readMCPServerId(context), context.requestContext), context.corsOrigin)
}

async function handleMCPLogoutServer(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter?.logoutServer) return sendNotImplemented(context, 'mcp.logoutServer')
  sendJson(context.response, 200, await adapter.logoutServer(readMCPServerId(context), context.requestContext), context.corsOrigin)
}

async function handleMCPProbeServer(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter?.probeServer) return sendNotImplemented(context, 'mcp.probeServer')
  // The web client posts the candidate config as the raw body (same shape as
  // POST /api/mcp/servers); an envelope form {config: …} is also accepted to
  // match the electron IPC request shape.
  const body = await readJson<JsonObject & { config?: JsonObject }>(context.request)
  const config = body?.config ?? body ?? {}
  sendJson(context.response, 200, await adapter.probeServer(config, context.requestContext), context.corsOrigin)
}

async function handleMCPRefreshServer(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter) return sendNotImplemented(context, 'mcp.refreshServer')
  sendJson(context.response, 200, await adapter.refreshServer(readMCPServerId(context), context.requestContext), context.corsOrigin)
}

async function handleMCPGetTools(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter?.getTools) return sendNotImplemented(context, 'mcp.getTools')
  sendJson(context.response, 200, await adapter.getTools(context.requestContext), context.corsOrigin)
}

async function handleMCPCallTool(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter?.callTool) return sendNotImplemented(context, 'mcp.callTool')
  const body = await readJson<{ serverId?: string; toolName?: string; arguments?: JsonObject }>(context.request)
  sendJson(
    context.response,
    200,
    await adapter.callTool(body?.serverId || '', body?.toolName || '', body?.arguments ?? {}, context.requestContext),
    context.corsOrigin,
  )
}

async function handleMCPGetResources(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter?.getResources) return sendNotImplemented(context, 'mcp.getResources')
  sendJson(context.response, 200, await adapter.getResources(context.requestContext), context.corsOrigin)
}

async function handleMCPReadResource(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter?.readResource) return sendNotImplemented(context, 'mcp.readResource')
  const body = await readJson<{ serverId?: string; uri?: string }>(context.request)
  sendJson(context.response, 200, await adapter.readResource(body?.serverId || '', body?.uri || '', context.requestContext), context.corsOrigin)
}

async function handleMCPGetPrompts(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter?.getPrompts) return sendNotImplemented(context, 'mcp.getPrompts')
  sendJson(context.response, 200, await adapter.getPrompts(context.requestContext), context.corsOrigin)
}

async function handleMCPGetPrompt(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter?.getPrompt) return sendNotImplemented(context, 'mcp.getPrompt')
  const body = await readJson<{ serverId?: string; name?: string; arguments?: Record<string, string> }>(context.request)
  sendJson(
    context.response,
    200,
    await adapter.getPrompt(body?.serverId || '', body?.name || '', body?.arguments, context.requestContext),
    context.corsOrigin,
  )
}

async function handleMCPReadConfigFile(context: RouteContext): Promise<void> {
  const adapter = context.runtime.mcp
  if (!adapter?.readConfigFile) return sendNotImplemented(context, 'mcp.readConfigFile')
  const body = await readJson<{ filePath?: string }>(context.request)
  sendJson(context.response, 200, await adapter.readConfigFile(body?.filePath || '', context.requestContext), context.corsOrigin)
}

async function handleListSessions(context: RouteContext): Promise<void> {
  sendJson(context.response, 200, await context.runtime.sessions.list(context.requestContext), context.corsOrigin)
}

async function handleCreateSession(context: RouteContext): Promise<void> {
  const body = await readJson<{ name?: string; sessionId?: string; kind?: string }>(context.request)
  // Collab session kinds (room/work) need the in-process RoomCoordinator,
  // which the server does not run — reject instead of silently creating a
  // plain chat that masquerades as a room (docs/design/multi-agent-collab.md).
  if (body?.kind !== undefined) {
    sendJson(context.response, 400, { success: false, error: `Session kind '${body.kind}' is not supported on the server host` }, context.corsOrigin)
    return
  }
  sendJson(context.response, 200, await context.runtime.sessions.create(body?.name || 'New Chat', context.requestContext, body?.sessionId), context.corsOrigin)
}

async function handleGetSession(context: RouteContext): Promise<void> {
  if (!context.runtime.sessions.get) return sendNotImplemented(context, 'sessions.get')
  sendJson(context.response, 200, await context.runtime.sessions.get(readSessionId(context), context.requestContext), context.corsOrigin)
}

async function handleActivateSession(context: RouteContext): Promise<void> {
  if (!context.runtime.sessions.activate) return sendNotImplemented(context, 'sessions.activate')
  sendJson(context.response, 200, await context.runtime.sessions.activate(readSessionId(context), context.requestContext), context.corsOrigin)
}

async function handleDeleteSession(context: RouteContext): Promise<void> {
  if (!context.runtime.sessions.delete) return sendNotImplemented(context, 'sessions.delete')
  sendJson(context.response, 200, await context.runtime.sessions.delete(readSessionId(context), context.requestContext), context.corsOrigin)
}

async function handleRenameSession(context: RouteContext): Promise<void> {
  if (!context.runtime.sessions.rename) return sendNotImplemented(context, 'sessions.rename')
  const body = await readJson<{ name?: string }>(context.request)
  sendJson(context.response, 200, await context.runtime.sessions.rename(readSessionId(context), body?.name || '', context.requestContext), context.corsOrigin)
}

async function handleCreateBranch(context: RouteContext): Promise<void> {
  const adapter = context.runtime.sessions
  if (!adapter.createBranch) return sendNotImplemented(context, 'sessions.createBranch')
  const body = await readJson<{ parentSessionId?: string; branchFromMessageId?: string }>(context.request)
  sendJson(
    context.response,
    200,
    await adapter.createBranch(
      body?.parentSessionId ?? '',
      body?.branchFromMessageId ?? '',
      context.requestContext,
    ),
    context.corsOrigin,
  )
}

async function handleUpdateSessionArchive(context: RouteContext): Promise<void> {
  const body = await readJson<{ isArchived?: boolean; archivedAt?: number | null }>(context.request)
  sendJson(context.response, 200, await updateSession(context, {
    isArchived: Boolean(body?.isArchived),
    archivedAt: body?.archivedAt ?? null,
  }), context.corsOrigin)
}

async function handleUpdateSessionWorkingDirectory(context: RouteContext): Promise<void> {
  const body = await readJson<{ workingDirectory?: string | null }>(context.request)
  sendJson(context.response, 200, await updateSession(context, {
    workingDirectory: body?.workingDirectory ?? null,
  }), context.corsOrigin)
}

async function handleUpdateSessionAgent(context: RouteContext): Promise<void> {
  const body = await readJson<{ agentId?: string }>(context.request)
  sendJson(context.response, 200, await updateSession(context, {
    agentId: body?.agentId || '',
  }), context.corsOrigin)
}

async function handleUpdateSessionPermissionMode(context: RouteContext): Promise<void> {
  const body = await readJson<{ permissionMode?: string }>(context.request)
  sendJson(context.response, 200, await updateSession(context, {
    permissionMode: body?.permissionMode,
  }), context.corsOrigin)
}

async function handleUpdateSessionModel(context: RouteContext): Promise<void> {
  const body = await readJson<{ provider?: string; model?: string }>(context.request)
  sendJson(context.response, 200, await updateSession(context, {
    lastProvider: body?.provider || '',
    lastModel: body?.model || '',
    // This route IS the picker (renderer platformApi.updateSessionModel), so
    // the choice is the user's — mirrors the desktop repository's pin.
    modelPinned: true,
  }), context.corsOrigin)
}

async function handleUpdateSessionMaxTokens(context: RouteContext): Promise<void> {
  const body = await readJson<{ maxTokens?: number }>(context.request)
  sendJson(context.response, 200, await updateSession(context, {
    maxTokens: body?.maxTokens,
  }), context.corsOrigin)
}

async function updateSession(context: RouteContext, patch: JsonObject): Promise<unknown> {
  const adapter = context.runtime.sessions
  if (!adapter.update) {
    return {
      success: false,
      error: 'Server adapter has not implemented sessions.update.',
    }
  }
  return adapter.update(readSessionId(context), patch, context.requestContext)
}

async function handleMessagePage(context: RouteContext): Promise<void> {
  const adapter = context.runtime.messages
  if (!adapter) return sendNotImplemented(context, 'messages.page')
  sendJson(context.response, 200, await adapter.page(await readJson(context.request), context.requestContext), context.corsOrigin)
}

async function handleUserMarkers(context: RouteContext): Promise<void> {
  const adapter = context.runtime.messages
  if (!adapter?.userMarkers) return sendNotImplemented(context, 'messages.userMarkers')
  sendJson(context.response, 200, await adapter.userMarkers(readSessionId(context), context.requestContext), context.corsOrigin)
}

async function handleEmitCommand(context: RouteContext): Promise<void> {
  sendJson(
    context.response,
    200,
    await context.runtime.commands.emit(readSessionId(context), await readJson(context.request), context.requestContext),
    context.corsOrigin,
  )
}

async function handlePermissionResponse(context: RouteContext): Promise<void> {
  const adapter = context.runtime.permissions
  if (!adapter) return sendNotImplemented(context, 'permissions.respond')
  sendJson(
    context.response,
    200,
    await adapter.respond(readRequestId(context), await readJson(context.request), context.requestContext),
    context.corsOrigin,
  )
}

async function handleAbortStream(context: RouteContext): Promise<void> {
  const adapter = context.runtime.streams
  if (!adapter?.abort) return sendNotImplemented(context, 'streams.abort')
  const body = await readJson<{ sessionId?: string }>(context.request)
  sendJson(context.response, 200, await adapter.abort(body?.sessionId, context.requestContext), context.corsOrigin)
}

async function handleGetActiveStreams(context: RouteContext): Promise<void> {
  const adapter = context.runtime.streams
  if (!adapter?.active) return sendNotImplemented(context, 'streams.active')
  sendJson(context.response, 200, {
    success: true,
    streams: await adapter.active(context.requestContext),
  }, context.corsOrigin)
}

function handleEvents(context: RouteContext): void {
  const sessionId = context.url.searchParams.get('sessionId') || '*'
  // Resume support for mobile/weak-network clients: explicit ?after=<seq> wins;
  // the standard Last-Event-ID header (sent automatically by EventSource
  // polyfills on reconnect) is the fallback. Both mean "events after this seq".
  const afterParam = Number.parseInt(context.url.searchParams.get('after') || '', 10)
  const lastEventIdValue = context.request.headers['last-event-id']
  const lastEventIdHeader = Number.parseInt(typeof lastEventIdValue === 'string' ? lastEventIdValue : '', 10)
  const afterSeq = Number.isFinite(afterParam) ? afterParam : lastEventIdHeader
  const options = Number.isFinite(afterSeq) ? { afterSeq } : undefined
  const unsubs: RuntimeUnsubscribe[] = []

  context.response.writeHead(200, {
    ...corsHeaders(context.corsOrigin),
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  context.response.flushHeaders()
  context.response.write(': connected\n\n')

  // Per-connection coalescing: real providers emit hundreds of delta chunks
  // per second; the shared coalescer batches them on a 16ms ordered buffer,
  // stamps the active stream's messageId, and flushes pending deltas before
  // any session event goes out (same semantics as the desktop IPCBridge).
  const coalescer = new SessionStreamCoalescer({
    sendChunk: (chunkSessionId, chunk) => {
      writeSse(context.response, 'session:stream', { sessionId: chunkSessionId, chunk })
    },
  }, { debugLabel: 'ServerSSE' })

  unsubs.push(context.runtime.events.subscribe(sessionId, (envelope: RuntimeEventEnvelope) => {
    coalescer.handleEvent(envelope as unknown as SessionEventEnvelope)
    // Stamp the SSE id from the committed sequence so clients can resume
    // with Last-Event-ID after a reconnect.
    writeSse(context.response, 'session:event', envelope, envelope.sequence)
  }, options, context.requestContext))

  if (context.runtime.streams) {
    unsubs.push(context.runtime.streams.subscribe(sessionId, (payload: RuntimeStreamPayload) => {
      coalescer.handleChunk(payload.sessionId, payload.chunk as StreamChunk)
    }, options, context.requestContext))
  }

  context.request.on('close', () => {
    for (const unsubscribe of unsubs) unsubscribe()
    coalescer.dispose()
  })
}

function handleScratchpadEvents(context: RouteContext): void {
  const adapter = context.runtime.scratchpad
  if (!adapter?.subscribeChanged) {
    sendNotImplemented(context, 'scratchpad.subscribeChanged')
    return
  }

  context.response.writeHead(200, {
    ...corsHeaders(context.corsOrigin),
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  context.response.flushHeaders()
  context.response.write(': connected\n\n')

  const unsubscribe = adapter.subscribeChanged((payload: unknown) => {
    writeSse(context.response, 'scratchpad:changed', payload)
  }, context.requestContext)

  context.request.on('close', () => {
    unsubscribe()
  })
}

function handleTodoPlanEvents(context: RouteContext): void {
  const adapter = context.runtime.todoPlan
  if (!adapter?.subscribeChanged) {
    sendNotImplemented(context, 'todoPlan.subscribeChanged')
    return
  }

  context.response.writeHead(200, {
    ...corsHeaders(context.corsOrigin),
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  context.response.flushHeaders()
  context.response.write(': connected\n\n')

  const unsubscribe = adapter.subscribeChanged((payload: unknown) => {
    writeSse(context.response, 'todo-plan:changed', payload)
  }, context.requestContext)

  context.request.on('close', () => {
    unsubscribe()
  })
}

function handleMediaEvents(context: RouteContext): void {
  const adapter = context.runtime.media
  if (!adapter?.subscribeImageGenerated) {
    sendNotImplemented(context, 'media.subscribeImageGenerated')
    return
  }

  context.response.writeHead(200, {
    ...corsHeaders(context.corsOrigin),
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  context.response.flushHeaders()
  context.response.write(': connected\n\n')

  const unsubscribe = adapter.subscribeImageGenerated((payload: unknown) => {
    writeSse(context.response, 'media:image-generated', payload)
  }, context.requestContext)

  context.request.on('close', () => {
    unsubscribe()
  })
}

function handleWorkspaceFileEvents(context: RouteContext): void {
  const adapter = context.runtime.files
  if (!adapter?.subscribeWorkspaceFileChanged) {
    sendNotImplemented(context, 'files.subscribeWorkspaceFileChanged')
    return
  }

  context.response.writeHead(200, {
    ...corsHeaders(context.corsOrigin),
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  context.response.flushHeaders()
  context.response.write(': connected\n\n')

  const unsubscribe = adapter.subscribeWorkspaceFileChanged((payload: unknown) => {
    writeSse(context.response, 'workspace:file-changed', payload)
  }, context.requestContext)

  context.request.on('close', () => {
    unsubscribe()
  })
}

function handleUnsupported(context: RouteContext): void {
  sendNotImplemented(context, context.url.pathname)
}

function sendNotImplemented(context: RouteContext, capability: string): void {
  sendJson(context.response, 501, {
    success: false,
    error: `Server adapter has not implemented ${capability}.`,
  }, context.corsOrigin)
}

function readSessionId(context: RouteContext): string {
  return context.url.searchParams.get('sessionId') || ''
}

function readRequestId(context: RouteContext): string {
  return context.url.searchParams.get('requestId') || ''
}

function readMCPServerId(context: RouteContext): string {
  return context.url.searchParams.get('serverId') || ''
}

function readBackgroundJobId(context: RouteContext): string {
  return context.url.searchParams.get('jobId') || ''
}

function readThemeId(context: RouteContext): string {
  return context.url.searchParams.get('themeId') || ''
}

function readSkillId(context: RouteContext): string {
  return context.url.searchParams.get('skillId') || ''
}

function readMediaQuery(context: RouteContext): Record<string, unknown> {
  const query: Record<string, unknown> = {}
  const kind = context.url.searchParams.get('kind')
  const source = context.url.searchParams.get('source')
  const search = context.url.searchParams.get('search')
  const includeHidden = context.url.searchParams.get('includeHidden')
  if (kind) query.kind = kind
  if (source) query.source = source
  if (search) query.search = search
  if (includeHidden === 'true') query.includeHidden = true
  return query
}

function getRequestUrl(request: IncomingMessage): URL {
  return new URL(request.url || '/', 'http://127.0.0.1')
}

function getRuntimeRequestContext(
  request: IncomingMessage,
  options: OnethingHttpServerOptions,
): RuntimeRequestContext {
  // Identity headers select an owner scope; checkRequestAuthorization has already
  // rejected them unless the configured Bearer token was presented, so honoring
  // them here is safe only when a token is configured.
  const identityTrusted = Boolean(options.authToken)
  return {
    userId: (identityTrusted ? readHeader(request, 'x-onething-user-id') : undefined)
      || options.defaultUserId || 'local-user',
    workspaceId: (identityTrusted ? readHeader(request, 'x-onething-workspace-id') : undefined)
      || options.defaultWorkspaceId || 'default',
    authToken: readBearerToken(request),
    origin: readHeader(request, 'origin'),
  }
}

function checkRequestAuthorization(
  request: IncomingMessage,
  options: OnethingHttpServerOptions,
): string | undefined {
  if (options.authToken) {
    const bearer = readBearerToken(request)
    if (!bearer || !tokenMatches(bearer, options.authToken)) {
      return 'Unauthorized: this server requires a Bearer token (ONETHING_SERVER_TOKEN).'
    }
    return undefined
  }
  if (readHeader(request, 'x-onething-user-id') || readHeader(request, 'x-onething-workspace-id')) {
    return 'Unauthorized: identity headers are rejected unless the server has an auth token configured (ONETHING_SERVER_TOKEN).'
  }
  return undefined
}

function tokenMatches(provided: string, expected: string): boolean {
  // Hash both sides so the comparison is constant-time regardless of length.
  const providedDigest = createHash('sha256').update(provided).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}

function readHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function readBearerToken(request: IncomingMessage): string | undefined {
  const authorization = readHeader(request, 'authorization')
  if (!authorization?.startsWith('Bearer ')) return undefined
  return authorization.slice('Bearer '.length)
}

async function readJson<T = unknown>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) return undefined as T
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function sendOptions(response: ServerResponse, corsOrigin?: string): void {
  response.writeHead(204, corsHeaders(corsOrigin))
  response.end()
}

function sendJson(response: ServerResponse, status: number, body: unknown, corsOrigin?: string): void {
  response.writeHead(status, {
    ...corsHeaders(corsOrigin),
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(body))
}

function writeSse(response: ServerResponse, eventName: string, payload: unknown, id?: number): void {
  if (typeof id === 'number' && Number.isFinite(id)) response.write(`id: ${id}\n`)
  response.write(`event: ${eventName}\n`)
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function corsHeaders(origin?: string): Record<string, string> {
  if (!origin) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-onething-user-id,x-onething-workspace-id',
  }
}

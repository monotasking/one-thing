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
  if (method === 'GET' && pathname === '/api/plugins') return handleListPlugins
  if (method === 'POST' && pathname === '/api/plugins/enable') return handleEnablePlugin
  if (method === 'POST' && pathname === '/api/plugins/disable') return handleDisablePlugin
  if (method === 'POST' && pathname === '/api/plugins/refresh') return handleRefreshPlugins
  if (method === 'GET' && pathname === '/api/plugins/commands') return handlePluginCommands
  if (method === 'POST' && pathname === '/api/plugins/execute-command') return handleExecutePluginCommand
  // oauth 的六条数据面已迁到 `POST /api/rpc`(oauthRouter,P4c 第七批)。
  // 留下的是推送 —— router 今天没有推送面。
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
  if (method === 'GET' && pathname === '/api/todo-plan/events') return handleTodoPlanEvents
  if (method === 'GET' && pathname === '/api/scratchpad/events') return handleScratchpadEvents
  if (method === 'GET' && pathname === '/api/tools') return handleGetTools
  if (method === 'POST' && pathname === '/api/tools/execute') return handleExecuteTool
  if (method === 'POST' && pathname === '/api/tools/cancel') return handleCancelTool
  if (method === 'POST' && pathname === '/api/tools/update-call') return handleUpdateToolCall
  if (method === 'GET' && pathname === '/api/tools/background-jobs') return handleListBackgroundJobs
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
  // 聊天面的六条数据面已迁到通用 `POST /api/rpc`(P4c 第五批,`chatRouter`):
  // `/api/chat/history`、`/api/chat/title`、`/api/chat/update-thinking-time`、
  // `/api/streams/abort`、`/api/streams/active` 与
  // `/api/sessions/:id/system-prompt-snapshot` 一起消失。
  // 通用 RPC 单路由(主线 T0):所有 router 域走这一条,加域不再往本文件加路由。
  if (method === 'POST' && pathname === '/api/rpc') return handleRpc
  // 媒体域的数据面已迁到通用 `POST /api/rpc`(P4c 第三批,`mediaRouter` 十一条)。
  // 这里只剩两条**不是 RPC 形状**的:按文件名取字节的那条,和一条 SSE。
  if (method === 'GET' && pathname === '/api/media/events') return handleMediaEvents
  // 会话域的数据面已迁到通用 `POST /api/rpc`(P4c 第五批,`sessionsRouter` 26 条)。
  // 这里只剩**仍有真实客户端**的三条:`apps/mobile`(独立 RN 客户端,直接打 REST)
  // 用的会话列表 / 建会话 / 消息分页。它们是同一批域处理者之上的薄适配,不是第二份
  // 实现 —— 换句话说,mobile 换成 `/api/rpc` 的那天,这三行就跟着消失(拍板 #32)。
  if (method === 'GET' && pathname === '/api/sessions') return handleListSessions
  if (method === 'POST' && pathname === '/api/sessions') return handleCreateSession
  if (method === 'POST' && pathname === '/api/session-messages/page') return handleMessagePage
  if (method === 'GET' && pathname === '/api/events') return handleEvents
  // 停止的 REST 面为 `apps/mobile` 保留(独立 RN 客户端,直接打 REST)。它是
  // chat 域处理者之上的**薄适配**,不是第二份实现 —— mobile 换成 `/api/rpc` 的
  // 那天这一行就跟着消失(拍板 #32,与三条会话 REST 同一处理)。
  if (method === 'POST' && pathname === '/api/streams/abort') return handleAbortStream

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/)
  if (sessionMatch) {
    const action = sessionMatch[2]
    // 会话的读/改/删十二条已迁 `sessionsRouter`、提示词快照迁 `chatRouter`
    // (P4c 第五批)。剩下的两条各有理由:`max-tokens` 桌面侧从来没有处理者
    // (不是那 26 条之一);另一条不是 RPC 形状 —— 一条 SSE。
    if (method === 'POST' && action === 'max-tokens') return withSessionId(sessionMatch[1], handleUpdateSessionMaxTokens)
    if (method === 'GET' && action === 'events') return withSessionId(sessionMatch[1], handleEvents)
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

function withBackgroundJobId(encodedJobId: string, handler: RouteHandler): RouteHandler {
  return (context) => {
    context.url.searchParams.set('jobId', decodeURIComponent(encodedJobId))
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

/**
 * `POST /api/streams/abort` —— 为 `apps/mobile` 保留的薄适配(拍板 #32)。
 *
 * 它不再有自己的实现:请求原样折成 chat 域的信封,交给**同一个** RPC 处理者,
 * 再把 `data` 拆出来还原成旧的 body 形状。web 与桌面走的是 `POST /api/rpc`;
 * 这一行只为一个还没换信封的客户端存在。
 */
async function handleAbortStream(context: RouteContext): Promise<void> {
  const body = await readJson<{ sessionId?: string }>(context.request)
  const response = await dispatchRpc(
    { domain: 'chat', method: 'abortStream', payload: { sessionId: body?.sessionId } },
    context.rpcContext,
  )
  sendJson(
    context.response,
    200,
    response.ok ? response.data : { success: false, error: response.error.message },
    context.corsOrigin,
  )
}

async function handleMessagePage(context: RouteContext): Promise<void> {
  const adapter = context.runtime.messages
  if (!adapter) return sendNotImplemented(context, 'messages.page')
  sendJson(context.response, 200, await adapter.page(await readJson(context.request), context.requestContext), context.corsOrigin)
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

function readBackgroundJobId(context: RouteContext): string {
  return context.url.searchParams.get('jobId') || ''
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

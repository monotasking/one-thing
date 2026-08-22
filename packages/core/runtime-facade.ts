import type { JsonObject } from './json.js'

export type RuntimeUnsubscribe = () => void

export interface RuntimeMutationResult {
  success: boolean
  error?: string
}

export interface RuntimeEventEnvelope<TEvent = unknown> {
  sessionId: string
  sequence?: number
  event: TEvent
}

export interface RuntimeStreamPayload<TChunk = unknown> {
  sessionId: string
  chunk: TChunk
}

export interface RuntimeRequestContext {
  userId: string
  workspaceId: string
  roles?: string[]
  authToken?: string
  origin?: string
}

export interface RuntimeHostCapabilities {
  localFileSystem: boolean
  workspaceFileSystem: boolean
  nativeWindowControls: boolean
  shellTools: boolean
  clipboardWrite: boolean
  desktopWindows: boolean
  globalMenuEvents: boolean
}

export interface RuntimeEventSubscribeOptions {
  afterSeq?: number
  signal?: AbortSignal
}

export interface RuntimeCapabilitiesAdapter<TCapabilities = RuntimeHostCapabilities> {
  get(context?: RuntimeRequestContext): Promise<TCapabilities>
}

/**
 * 结构债 P4c 之后**没有实现者也没有读者**:app-state 域整只迁到了通用 RPC 通道
 * (`appStateRouter` + `app/rpc/domains/app-state.ts`),server 的两条 REST 路由与
 * 它们背后的 facade adapter 一起删了。这一格之所以留着,是因为 `TAppState` /
 * `TUIState` 是 `OnethingRuntimeFacade` 的**位置泛型参数** —— 摘掉它们会让所有
 * 调用点的位置实参整体错位,那是另一次收口(与 C5 的名册收口同批),不是这次搬家。
 */
export interface RuntimeAppStateAdapter<TAppState = unknown, TUIState = unknown> {
  get(context?: RuntimeRequestContext): Promise<TAppState>
  saveUIState?(uiState: TUIState, context?: RuntimeRequestContext): Promise<RuntimeMutationResult>
}

export interface RuntimeSessionsAdapter<
  TSessionList = unknown,
  TSession = unknown,
  TCreateSessionInput = string,
  TSessionPatch = JsonObject,
> {
  list(context?: RuntimeRequestContext): Promise<TSessionList>
  /**
   * `requestedSessionId` lets the client supply the session's id (renderer
   * drafts materialize under the id they were born with). Implementations
   * must validate the format and refuse ids that already exist.
   */
  create(input: TCreateSessionInput, context?: RuntimeRequestContext, requestedSessionId?: string): Promise<TSession>
  /**
   * 结构债 P4c 第五批:会话的读/改/删(get / activate / delete / rename /
   * createBranch)整批迁到 `sessions` RPC 域,对应的 REST 路由与这里的方法一起
   * 消失。`list` / `create` 留着是因为 `apps/mobile` 仍然直接打那两条 REST
   * (拍板 #32);`update` 留着是因为 `POST /api/sessions/:id/max-tokens` 从来就
   * 不在那 26 条里(桌面侧没有处理者)。
   */
  update?(sessionId: string, patch: TSessionPatch, context?: RuntimeRequestContext): Promise<RuntimeMutationResult>
}

/**
 * 结构债 P4c 第五批:`userMarkers` 迁到 `sessions` 域。`page` 留着是因为
 * `apps/mobile` 仍然直接打 `POST /api/session-messages/page`(拍板 #32)。
 * `TMarkersResponse` 是**位置泛型**,后面还排着十几个位置参数,抽掉一格等于把
 * 每个宿主的实参表整体错位 —— 留在原位不动(与 `TCommand` 同一处理)。
 */
export interface RuntimeMessagesAdapter<TPageRequest = unknown, TPageResponse = unknown, TMarkersResponse = unknown> {
  page(request: TPageRequest, context?: RuntimeRequestContext): Promise<TPageResponse>
}

/**
 * 结构债 P4c 第五批:这个 adapter 上属于**会话域**的六条
 * (getMessages / getTokenUsage / updateSessionPin / addSystemMessage /
 * removeSystemMarkerMessage / removeMessage)随 `/api/chat/*` 那批路由一起迁到
 * `sessions` RPC 域。剩下的三条是真正的「聊天」面,不属于会话域。
 * 两个位置泛型留在原位不动(理由同 `RuntimeMessagesAdapter`)。
 */
export interface RuntimeChatAdapter<
  TMessage = unknown,
  TSystemMessage = unknown,
> {
  getHistory?(sessionId: string, context?: RuntimeRequestContext): Promise<unknown>
  generateTitle?(message: string, context?: RuntimeRequestContext): Promise<unknown>
  updateMessageThinkingTime?(sessionId: string, messageId: string, thinkingTime: number, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
}

/**
 * 结构债 P4c 第四批:会话命令总线的入口整只迁到 `session-command` RPC 域
 * (`POST /api/sessions/:id/commands` 与这个 adapter 一起消失)。`TCommand` /
 * `TCommandResult` 两个**位置泛型**留着不动 —— 它们后面还排着十几个位置参数,
 * 抽掉一格等于把每个宿主的实参表整体错位(与 `RuntimeAppStateAdapter` 同一处理)。
 */

export interface RuntimeEventsAdapter<TEvent = unknown> {
  subscribe(
    sessionId: string,
    handler: (envelope: RuntimeEventEnvelope<TEvent>) => void,
    options?: RuntimeEventSubscribeOptions,
    context?: RuntimeRequestContext,
  ): RuntimeUnsubscribe
}

export interface RuntimeStreamsAdapter<TChunk = unknown> {
  subscribe(
    sessionId: string,
    handler: (payload: RuntimeStreamPayload<TChunk>) => void,
    options?: RuntimeEventSubscribeOptions,
    context?: RuntimeRequestContext,
  ): RuntimeUnsubscribe
  abort?(sessionId?: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult>
  active?(context?: RuntimeRequestContext): Promise<string[]>
}

export interface RuntimePermissionsAdapter<TPermissionResponse = unknown> {
  /**
   * 结构债 P4c:活询问的读/清(`getPending` / `clearSession`)已整只迁到
   * `permission` RPC 域,这里只剩应答 —— 它服务的是 `/api/permissions/:id/respond`,
   * 走命令总线,不是一次 RPC。
   */
  respond(requestId: string, response: TPermissionResponse, context?: RuntimeRequestContext): Promise<RuntimeMutationResult>
}

export interface RuntimeSettingsAdapter<TSettings = unknown, TSettingsUpdateResult = TSettings> {
  get(context?: RuntimeRequestContext): Promise<TSettings>
  update(settings: TSettings, context?: RuntimeRequestContext): Promise<TSettingsUpdateResult>
}

export interface RuntimeNetworkAdapter<TProxySettings = unknown, TTestProxyResponse = RuntimeMutationResult> {
  testProxy(proxy: TProxySettings, context?: RuntimeRequestContext): Promise<TTestProxyResponse>
}

export interface RuntimeSearchAdapter<TSearchRequest = unknown, TSearchResponse = unknown, TSearchActionResponse = RuntimeMutationResult> {
  query(request: TSearchRequest, context?: RuntimeRequestContext): Promise<TSearchResponse>
  executeAction(actionId: string, context?: RuntimeRequestContext): Promise<TSearchActionResponse>
}

export interface RuntimeThemesAdapter {
  getThemes(context?: RuntimeRequestContext): Promise<unknown>
  getTheme(themeId: string, context?: RuntimeRequestContext): Promise<unknown>
  applyTheme(themeId: string, mode: 'dark' | 'light', context?: RuntimeRequestContext): Promise<unknown>
  refreshThemes(projectPath?: string, context?: RuntimeRequestContext): Promise<unknown>
  openThemesFolder?(context?: RuntimeRequestContext): Promise<RuntimeMutationResult>
}

/**
 * 只剩系统提示词快照这一条:片段的增删改查已经走通用 RPC 通道(promptsRouter),
 * 三个宿主共用一份实现,facade 这一侧不再需要对应成员。
 */
export interface RuntimePromptsAdapter {
  getSystemPromptSnapshot(sessionId: string, context?: RuntimeRequestContext): Promise<unknown>
}

export interface RuntimeFilesAdapter {
  listFiles?(request: unknown, context?: RuntimeRequestContext): Promise<unknown>
  listDirs?(request: unknown, context?: RuntimeRequestContext): Promise<unknown>
  readContent?(path: string, maxSize?: number, context?: RuntimeRequestContext): Promise<unknown>
  saveContent?(path: string, content: string, expectedMtimeMs?: number, context?: RuntimeRequestContext): Promise<unknown>
  rollback?(request: unknown, context?: RuntimeRequestContext): Promise<unknown>
  listDirectory?(path: string, context?: RuntimeRequestContext): Promise<unknown>
  stat?(path: string, context?: RuntimeRequestContext): Promise<unknown>
  createFile?(path: string, content?: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  createDirectory?(path: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  renamePath?(oldPath: string, newPath: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  deletePath?(path: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  revealPath?(path: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  watchWorkspace?(root: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  unwatchWorkspace?(root: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  subscribeWorkspaceFileChanged?(
    handler: (payload: unknown) => void,
    context?: RuntimeRequestContext,
  ): RuntimeUnsubscribe
}

/**
 * 数据面(十一条)已迁到通用 RPC 通道(mediaRouter);留在 facade 上的两条都
 * **不是 RPC 形状**:一条按文件名交出字节,一条是事件下行的订阅(归主线 T2)。
 */
export interface RuntimeMediaAdapter {
  resolveFile?(fileName: string, context?: RuntimeRequestContext): Promise<{ success: boolean; path?: string; mimeType?: string; error?: string }>
  subscribeImageGenerated?(
    handler: (payload: unknown) => void,
    context?: RuntimeRequestContext,
  ): RuntimeUnsubscribe
}

/**
 * 数据面(读快照 / 增删改重命名 / 显示目录)已迁到通用 RPC 通道(todoPlanRouter);
 * 留在 facade 上的只有变更订阅 —— 它是事件下行,归主线 T2 收敛。
 */
export interface RuntimeTodoPlanAdapter<
  TChangedPayload = unknown,
> {
  subscribeChanged?(
    handler: (payload: TChangedPayload) => void,
    context?: RuntimeRequestContext,
  ): RuntimeUnsubscribe
}

/**
 * The per-session scratchpad (草稿纸). One markdown file per session, read and
 * written from the renderer and watched on disk (the AI edits it with the
 * ordinary file tools), so `subscribeChanged` is what keeps a browser client
 * in sync — the desktop host uses its own IPC broadcast instead.
 */
/**
 * 结构债 P4c:草稿纸的四条数据面(get / update / delete / adopt)已整只迁到
 * `scratchpad` RPC 域,这里只剩**推送面** —— `GET /api/scratchpad/events` 的 SSE 源。
 * router 今天没有推送面,所以这一格还得有个主。
 */
export interface RuntimeScratchpadAdapter<TChangedPayload = unknown> {
  subscribeChanged?(
    handler: (payload: TChangedPayload) => void,
    context?: RuntimeRequestContext,
  ): RuntimeUnsubscribe
}

export interface RuntimePluginsAdapter {
  list?(context?: RuntimeRequestContext): Promise<unknown>
  enable?(pluginId: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  disable?(pluginId: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  refresh?(context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  commands?(context?: RuntimeRequestContext): Promise<unknown>
  executeCommand?(request: unknown, context?: RuntimeRequestContext): Promise<unknown>
}

export interface RuntimeOAuthTokenEvent {
  type: 'oauth:token-refreshed' | 'oauth:token-expired'
  providerId: string
  error?: string
}

export interface RuntimeOAuthAdapter {
  start(providerId: string, context?: RuntimeRequestContext): Promise<unknown>
  callback(request: unknown, context?: RuntimeRequestContext): Promise<unknown>
  devicePoll(request: unknown, context?: RuntimeRequestContext): Promise<unknown>
  refresh(providerId: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  status(providerId: string, context?: RuntimeRequestContext): Promise<unknown>
  logout(providerId: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  subscribe?(handler: (event: RuntimeOAuthTokenEvent) => void, context?: RuntimeRequestContext): RuntimeUnsubscribe
}

export interface RuntimeGatewayAdapter {
  getStatus(context?: RuntimeRequestContext): Promise<unknown>
  start(request?: unknown, context?: RuntimeRequestContext): Promise<unknown>
  stop(context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  wechatLogout(request?: unknown, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  wechatAddAccount?(request?: unknown, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  wechatStopAccount?(request: unknown, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  wechatRemoveAccount?(request: unknown, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  wechatRenameAccount?(request: unknown, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
}

export interface RuntimeVoiceAdapter {
  getState(context?: RuntimeRequestContext): Promise<unknown>
  start(request?: unknown, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  stop(request?: unknown, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  submitUtterance(request: unknown, context?: RuntimeRequestContext): Promise<unknown>
  submitTranscript(request: unknown, context?: RuntimeRequestContext): Promise<unknown>
  synthesize(request: unknown, context?: RuntimeRequestContext): Promise<unknown>
  testASR(request: unknown, context?: RuntimeRequestContext): Promise<unknown>
  testTTS(request: unknown, context?: RuntimeRequestContext): Promise<unknown>
  getTTSModels(request?: unknown, context?: RuntimeRequestContext): Promise<unknown>
  runtimeReady(context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  runtimeEvent(event: unknown, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  subscribeEvents?(handler: (event: unknown) => void, context?: RuntimeRequestContext): RuntimeUnsubscribe
  subscribeRuntimeCommands?(handler: (command: unknown) => void, context?: RuntimeRequestContext): RuntimeUnsubscribe
}

export interface RuntimeACPAdapter {
  getAgents(context?: RuntimeRequestContext): Promise<unknown>
  addAgent(config: unknown, context?: RuntimeRequestContext): Promise<unknown>
  updateAgent(config: unknown, context?: RuntimeRequestContext): Promise<unknown>
  removeAgent(agentId: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  connectAgent(agentId: string, context?: RuntimeRequestContext): Promise<unknown>
  disconnectAgent(agentId: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult | unknown>
  refreshAgent(agentId: string, context?: RuntimeRequestContext): Promise<unknown>
  cancelSession(
    sessionId: string,
    agentId?: string,
    context?: RuntimeRequestContext,
  ): Promise<RuntimeMutationResult | unknown>
}

export interface RuntimeToolsAdapter<
  TTool = unknown,
  TExecuteArgs = JsonObject,
  TExecuteResult = RuntimeMutationResult,
  TBackgroundJob = unknown,
  TToolCallUpdate = unknown,
> {
  getTools(context?: RuntimeRequestContext): Promise<{ success: boolean; tools?: TTool[]; error?: string }>
  executeTool(
    toolId: string,
    args: TExecuteArgs,
    messageId: string,
    sessionId: string,
    context?: RuntimeRequestContext,
  ): Promise<TExecuteResult>
  cancelTool?(toolCallId: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult>
  updateToolCall?(
    sessionId: string,
    messageId: string,
    toolCallId: string,
    updates: TToolCallUpdate,
    context?: RuntimeRequestContext,
  ): Promise<RuntimeMutationResult>
  listBackgroundJobs?(options?: { includeInactive?: boolean }, context?: RuntimeRequestContext): Promise<{
    success: boolean
    jobs?: TBackgroundJob[]
    error?: string
  }>
  stopBackgroundJob?(jobId: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult>
}

export interface RuntimeMCPAdapter<
  TServerConfig = unknown,
  TServerState = unknown,
  TTool = unknown,
  TResource = unknown,
  TPrompt = unknown,
  TToolCallArgs = unknown,
  TToolCallResult = unknown,
  TResourceReadResult = unknown,
  TPromptResult = unknown,
  TConfigFileResult = unknown,
  TMutationResult = RuntimeMutationResult,
> {
  getServers(context?: RuntimeRequestContext): Promise<{ success: boolean; servers?: TServerState[]; error?: string }>
  addServer(config: TServerConfig, context?: RuntimeRequestContext): Promise<TMutationResult>
  updateServer(config: TServerConfig, context?: RuntimeRequestContext): Promise<TMutationResult>
  removeServer(serverId: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult>
  connectServer(serverId: string, context?: RuntimeRequestContext): Promise<TMutationResult>
  disconnectServer(serverId: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult>
  /** "重新授权": drop issuer-keyed OAuth credentials, then disconnect. */
  logoutServer?(serverId: string, context?: RuntimeRequestContext): Promise<RuntimeMutationResult>
  /** P2-2 preflight: dry-run a candidate config, report protocol/identity/capabilities. */
  probeServer?(config: TServerConfig, context?: RuntimeRequestContext): Promise<unknown>
  refreshServer(serverId: string, context?: RuntimeRequestContext): Promise<TMutationResult>
  getTools?(context?: RuntimeRequestContext): Promise<{ success: boolean; tools?: TTool[]; error?: string }>
  callTool?(serverId: string, toolName: string, args: TToolCallArgs, context?: RuntimeRequestContext): Promise<TToolCallResult>
  getResources?(context?: RuntimeRequestContext): Promise<{ success: boolean; resources?: TResource[]; error?: string }>
  readResource?(serverId: string, uri: string, context?: RuntimeRequestContext): Promise<TResourceReadResult>
  getPrompts?(context?: RuntimeRequestContext): Promise<{ success: boolean; prompts?: TPrompt[]; error?: string }>
  getPrompt?(serverId: string, name: string, args?: Record<string, string>, context?: RuntimeRequestContext): Promise<TPromptResult>
  readConfigFile?(filePath: string, context?: RuntimeRequestContext): Promise<TConfigFileResult>
}

export interface OnethingRuntimeFacadeOptions<
  TAppState = unknown,
  TUIState = unknown,
  TSessionList = unknown,
  TSession = unknown,
  TCreateSessionInput = string,
  TSessionPatch = JsonObject,
  TMessagePageRequest = unknown,
  TMessagePageResponse = unknown,
  TUserMarkersResponse = unknown,
  TCommand = unknown,
  TCommandResult = RuntimeMutationResult,
  TEvent = unknown,
  TChunk = unknown,
  TPermissionResponse = unknown,
  TSettings = unknown,
  TSettingsUpdateResult = TSettings,
  THostCapabilities = RuntimeHostCapabilities,
  TMCPServerConfig = unknown,
  TMCPServerState = unknown,
  TMCPTool = unknown,
  TMCPResource = unknown,
  TMCPPrompt = unknown,
  TMCPToolCallArgs = unknown,
  TMCPToolCallResult = unknown,
  TMCPResourceReadResult = unknown,
  TMCPPromptResult = unknown,
  TMCPConfigFileResult = unknown,
  TMCPMutationResult = RuntimeMutationResult,
  TTool = unknown,
  TToolExecuteArgs = JsonObject,
  TToolExecuteResult = RuntimeMutationResult,
  TBackgroundJob = unknown,
  TToolCallUpdate = unknown,
> {
  capabilities?: RuntimeCapabilitiesAdapter<THostCapabilities>
  appState?: RuntimeAppStateAdapter<TAppState, TUIState>
  sessions: RuntimeSessionsAdapter<TSessionList, TSession, TCreateSessionInput, TSessionPatch>
  messages?: RuntimeMessagesAdapter<TMessagePageRequest, TMessagePageResponse, TUserMarkersResponse>
  chat?: RuntimeChatAdapter
  events: RuntimeEventsAdapter<TEvent>
  streams?: RuntimeStreamsAdapter<TChunk>
  permissions?: RuntimePermissionsAdapter<TPermissionResponse>
  settings?: RuntimeSettingsAdapter<TSettings, TSettingsUpdateResult>
  network?: RuntimeNetworkAdapter
  search?: RuntimeSearchAdapter
  themes?: RuntimeThemesAdapter
  prompts?: RuntimePromptsAdapter
  files?: RuntimeFilesAdapter
  media?: RuntimeMediaAdapter
  todoPlan?: RuntimeTodoPlanAdapter
  scratchpad?: RuntimeScratchpadAdapter
  plugins?: RuntimePluginsAdapter
  oauth?: RuntimeOAuthAdapter
  gateway?: RuntimeGatewayAdapter
  voice?: RuntimeVoiceAdapter
  acp?: RuntimeACPAdapter
  tools?: RuntimeToolsAdapter<TTool, TToolExecuteArgs, TToolExecuteResult, TBackgroundJob, TToolCallUpdate>
  mcp?: RuntimeMCPAdapter<
    TMCPServerConfig,
    TMCPServerState,
    TMCPTool,
    TMCPResource,
    TMCPPrompt,
    TMCPToolCallArgs,
    TMCPToolCallResult,
    TMCPResourceReadResult,
    TMCPPromptResult,
    TMCPConfigFileResult,
    TMCPMutationResult
  >
  shutdown?: () => void | Promise<void>
}

export interface OnethingRuntimeFacade<
  TAppState = unknown,
  TUIState = unknown,
  TSessionList = unknown,
  TSession = unknown,
  TCreateSessionInput = string,
  TSessionPatch = JsonObject,
  TMessagePageRequest = unknown,
  TMessagePageResponse = unknown,
  TUserMarkersResponse = unknown,
  TCommand = unknown,
  TCommandResult = RuntimeMutationResult,
  TEvent = unknown,
  TChunk = unknown,
  TPermissionResponse = unknown,
  TSettings = unknown,
  TSettingsUpdateResult = TSettings,
  THostCapabilities = RuntimeHostCapabilities,
  TMCPServerConfig = unknown,
  TMCPServerState = unknown,
  TMCPTool = unknown,
  TMCPResource = unknown,
  TMCPPrompt = unknown,
  TMCPToolCallArgs = unknown,
  TMCPToolCallResult = unknown,
  TMCPResourceReadResult = unknown,
  TMCPPromptResult = unknown,
  TMCPConfigFileResult = unknown,
  TMCPMutationResult = RuntimeMutationResult,
  TTool = unknown,
  TToolExecuteArgs = JsonObject,
  TToolExecuteResult = RuntimeMutationResult,
  TBackgroundJob = unknown,
  TToolCallUpdate = unknown,
> {
  readonly capabilities?: RuntimeCapabilitiesAdapter<THostCapabilities>
  readonly appState?: RuntimeAppStateAdapter<TAppState, TUIState>
  readonly sessions: RuntimeSessionsAdapter<TSessionList, TSession, TCreateSessionInput, TSessionPatch>
  readonly messages?: RuntimeMessagesAdapter<TMessagePageRequest, TMessagePageResponse, TUserMarkersResponse>
  readonly chat?: RuntimeChatAdapter
  readonly events: RuntimeEventsAdapter<TEvent>
  readonly streams?: RuntimeStreamsAdapter<TChunk>
  readonly permissions?: RuntimePermissionsAdapter<TPermissionResponse>
  readonly settings?: RuntimeSettingsAdapter<TSettings, TSettingsUpdateResult>
  readonly network?: RuntimeNetworkAdapter
  readonly search?: RuntimeSearchAdapter
  readonly themes?: RuntimeThemesAdapter
  readonly prompts?: RuntimePromptsAdapter
  readonly files?: RuntimeFilesAdapter
  readonly media?: RuntimeMediaAdapter
  readonly todoPlan?: RuntimeTodoPlanAdapter
  readonly scratchpad?: RuntimeScratchpadAdapter
  readonly plugins?: RuntimePluginsAdapter
  readonly oauth?: RuntimeOAuthAdapter
  readonly gateway?: RuntimeGatewayAdapter
  readonly voice?: RuntimeVoiceAdapter
  readonly acp?: RuntimeACPAdapter
  readonly tools?: RuntimeToolsAdapter<TTool, TToolExecuteArgs, TToolExecuteResult, TBackgroundJob, TToolCallUpdate>
  readonly mcp?: RuntimeMCPAdapter<
    TMCPServerConfig,
    TMCPServerState,
    TMCPTool,
    TMCPResource,
    TMCPPrompt,
    TMCPToolCallArgs,
    TMCPToolCallResult,
    TMCPResourceReadResult,
    TMCPPromptResult,
    TMCPConfigFileResult,
    TMCPMutationResult
  >
  shutdown(): Promise<void>
}

export function createOnethingRuntimeFacade<
  TAppState = unknown,
  TUIState = unknown,
  TSessionList = unknown,
  TSession = unknown,
  TCreateSessionInput = string,
  TSessionPatch = JsonObject,
  TMessagePageRequest = unknown,
  TMessagePageResponse = unknown,
  TUserMarkersResponse = unknown,
  TCommand = unknown,
  TCommandResult = RuntimeMutationResult,
  TEvent = unknown,
  TChunk = unknown,
  TPermissionResponse = unknown,
  TSettings = unknown,
  TSettingsUpdateResult = TSettings,
  THostCapabilities = RuntimeHostCapabilities,
  TMCPServerConfig = unknown,
  TMCPServerState = unknown,
  TMCPTool = unknown,
  TMCPResource = unknown,
  TMCPPrompt = unknown,
  TMCPToolCallArgs = unknown,
  TMCPToolCallResult = unknown,
  TMCPResourceReadResult = unknown,
  TMCPPromptResult = unknown,
  TMCPConfigFileResult = unknown,
  TMCPMutationResult = RuntimeMutationResult,
  TTool = unknown,
  TToolExecuteArgs = JsonObject,
  TToolExecuteResult = RuntimeMutationResult,
  TBackgroundJob = unknown,
  TToolCallUpdate = unknown,
>(
  options: OnethingRuntimeFacadeOptions<
    TAppState,
    TUIState,
    TSessionList,
    TSession,
    TCreateSessionInput,
    TSessionPatch,
    TMessagePageRequest,
    TMessagePageResponse,
    TUserMarkersResponse,
    TCommand,
    TCommandResult,
    TEvent,
    TChunk,
    TPermissionResponse,
    TSettings,
    TSettingsUpdateResult,
    THostCapabilities,
    TMCPServerConfig,
    TMCPServerState,
    TMCPTool,
    TMCPResource,
    TMCPPrompt,
    TMCPToolCallArgs,
    TMCPToolCallResult,
    TMCPResourceReadResult,
    TMCPPromptResult,
    TMCPConfigFileResult,
    TMCPMutationResult,
    TTool,
    TToolExecuteArgs,
    TToolExecuteResult,
    TBackgroundJob,
    TToolCallUpdate
  >,
): OnethingRuntimeFacade<
  TAppState,
  TUIState,
  TSessionList,
  TSession,
  TCreateSessionInput,
  TSessionPatch,
  TMessagePageRequest,
  TMessagePageResponse,
  TUserMarkersResponse,
  TCommand,
  TCommandResult,
  TEvent,
  TChunk,
  TPermissionResponse,
  TSettings,
  TSettingsUpdateResult,
  THostCapabilities,
  TMCPServerConfig,
  TMCPServerState,
  TMCPTool,
  TMCPResource,
  TMCPPrompt,
  TMCPToolCallArgs,
  TMCPToolCallResult,
  TMCPResourceReadResult,
  TMCPPromptResult,
  TMCPConfigFileResult,
  TMCPMutationResult,
  TTool,
  TToolExecuteArgs,
  TToolExecuteResult,
  TBackgroundJob,
  TToolCallUpdate
> {
  return Object.freeze({
    capabilities: options.capabilities ? Object.freeze({ ...options.capabilities }) : undefined,
    appState: options.appState,
    sessions: Object.freeze({ ...options.sessions }),
    messages: options.messages ? Object.freeze({ ...options.messages }) : undefined,
    chat: options.chat ? Object.freeze({ ...options.chat }) : undefined,
    events: Object.freeze({ ...options.events }),
    streams: options.streams ? Object.freeze({ ...options.streams }) : undefined,
    permissions: options.permissions ? Object.freeze({ ...options.permissions }) : undefined,
    settings: options.settings ? Object.freeze({ ...options.settings }) : undefined,
    network: options.network ? Object.freeze({ ...options.network }) : undefined,
    search: options.search ? Object.freeze({ ...options.search }) : undefined,
    themes: options.themes ? Object.freeze({ ...options.themes }) : undefined,
    prompts: options.prompts ? Object.freeze({ ...options.prompts }) : undefined,
    files: options.files ? Object.freeze({ ...options.files }) : undefined,
    media: options.media ? Object.freeze({ ...options.media }) : undefined,
    todoPlan: options.todoPlan ? Object.freeze({ ...options.todoPlan }) : undefined,
    scratchpad: options.scratchpad ? Object.freeze({ ...options.scratchpad }) : undefined,
    plugins: options.plugins ? Object.freeze({ ...options.plugins }) : undefined,
    oauth: options.oauth ? Object.freeze({ ...options.oauth }) : undefined,
    gateway: options.gateway ? Object.freeze({ ...options.gateway }) : undefined,
    voice: options.voice ? Object.freeze({ ...options.voice }) : undefined,
    acp: options.acp ? Object.freeze({ ...options.acp }) : undefined,
    tools: options.tools ? Object.freeze({ ...options.tools }) : undefined,
    mcp: options.mcp ? Object.freeze({ ...options.mcp }) : undefined,
    async shutdown() {
      await options.shutdown?.()
    },
  })
}

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
 * 结构债 P4c 第五批:`RuntimeChatAdapter` 整只没了。属于**会话域**的六条
 * (getMessages / getTokenUsage / updateSessionPin / addSystemMessage /
 * removeSystemMarkerMessage / removeMessage)迁 `sessions` RPC 域,剩下的三条
 * 真正的聊天面(getHistory / generateTitle / updateMessageThinkingTime)迁
 * `chat` RPC 域 —— 两个宿主从此是同一条实现,facade 这一侧不再需要它。
 */

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
  // P4c 第五批:`abort` / `active` 迁 `chat` RPC 域(两个宿主同一条实现,
  // 停止走完整收尾、活流表读引擎自己那本)。这里只剩推送订阅。
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

/**
 * P4c 第七批:`RuntimeThemesAdapter` 整只没了 —— 五条全部随 `themesRouter`
 * 走通用 RPC,两个宿主读的是同一台主题运行时、同一份插件覆盖。
 */

/**
 * P4c 第五批:`RuntimePromptsAdapter` 整只没了 —— 最后一条(系统提示词快照)
 * 随 `chatRouter` 迁走,片段的增删改查更早就走了 `promptsRouter`。
 */

/**
 * P4c 第八批:十四条数据面(list / rollback / listDirs / readContent / saveContent /
 * listDirectory / stat / create / createDirectory / rename / delete / reveal /
 * watchStart / watchStop)已迁到通用 RPC 通道(`filesRouter`),**护栏跟着走** ——
 * 域处理者按 `RpcDispatchContext.transport` 逐方法夹紧 sandboxRoot。留在 facade
 * 上的只有变更订阅:`GET /api/files/watch/events` 那条 SSE 的货源,归主线 T2。
 */
export interface RuntimeFilesAdapter {
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

/**
 * P4c 第七批:六条数据面已迁到 `oauthRouter`,这里只剩**推送面** ——
 * `GET /api/oauth/events` 的 SSE 源,router 今天没有推送面。
 */
export interface RuntimeOAuthAdapter {
  subscribe(handler: (event: RuntimeOAuthTokenEvent) => void, context?: RuntimeRequestContext): RuntimeUnsubscribe
}

/**
 * P4c 第八批:`RuntimeGatewayAdapter` 整只没了 —— 八条随 `gatewayRouter` 走通用
 * RPC,由 `configureGatewayHost` 决定这台进程有没有网关能力(server / CLI 不注入
 * 即结构化降级)。**本域零推送**,所以 facade 上一格不留。
 */

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
  events: RuntimeEventsAdapter<TEvent>
  streams?: RuntimeStreamsAdapter<TChunk>
  permissions?: RuntimePermissionsAdapter<TPermissionResponse>
  settings?: RuntimeSettingsAdapter<TSettings, TSettingsUpdateResult>
  network?: RuntimeNetworkAdapter
  search?: RuntimeSearchAdapter
  files?: RuntimeFilesAdapter
  media?: RuntimeMediaAdapter
  todoPlan?: RuntimeTodoPlanAdapter
  scratchpad?: RuntimeScratchpadAdapter
  plugins?: RuntimePluginsAdapter
  oauth?: RuntimeOAuthAdapter
  voice?: RuntimeVoiceAdapter
  tools?: RuntimeToolsAdapter<TTool, TToolExecuteArgs, TToolExecuteResult, TBackgroundJob, TToolCallUpdate>
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
  readonly events: RuntimeEventsAdapter<TEvent>
  readonly streams?: RuntimeStreamsAdapter<TChunk>
  readonly permissions?: RuntimePermissionsAdapter<TPermissionResponse>
  readonly settings?: RuntimeSettingsAdapter<TSettings, TSettingsUpdateResult>
  readonly network?: RuntimeNetworkAdapter
  readonly search?: RuntimeSearchAdapter
  readonly files?: RuntimeFilesAdapter
  readonly media?: RuntimeMediaAdapter
  readonly todoPlan?: RuntimeTodoPlanAdapter
  readonly scratchpad?: RuntimeScratchpadAdapter
  readonly plugins?: RuntimePluginsAdapter
  readonly oauth?: RuntimeOAuthAdapter
  readonly voice?: RuntimeVoiceAdapter
  readonly tools?: RuntimeToolsAdapter<TTool, TToolExecuteArgs, TToolExecuteResult, TBackgroundJob, TToolCallUpdate>
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
    events: Object.freeze({ ...options.events }),
    streams: options.streams ? Object.freeze({ ...options.streams }) : undefined,
    permissions: options.permissions ? Object.freeze({ ...options.permissions }) : undefined,
    settings: options.settings ? Object.freeze({ ...options.settings }) : undefined,
    network: options.network ? Object.freeze({ ...options.network }) : undefined,
    search: options.search ? Object.freeze({ ...options.search }) : undefined,
    files: options.files ? Object.freeze({ ...options.files }) : undefined,
    media: options.media ? Object.freeze({ ...options.media }) : undefined,
    todoPlan: options.todoPlan ? Object.freeze({ ...options.todoPlan }) : undefined,
    scratchpad: options.scratchpad ? Object.freeze({ ...options.scratchpad }) : undefined,
    plugins: options.plugins ? Object.freeze({ ...options.plugins }) : undefined,
    oauth: options.oauth ? Object.freeze({ ...options.oauth }) : undefined,
    voice: options.voice ? Object.freeze({ ...options.voice }) : undefined,
    tools: options.tools ? Object.freeze({ ...options.tools }) : undefined,
    async shutdown() {
      await options.shutdown?.()
    },
  })
}

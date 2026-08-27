export interface StreamEngineStoreAdapter<TSettings = unknown, TSession = unknown, TMessage = unknown> {
  getSettings(): TSettings
  /**
   * 「这条会话该看哪一份 settings」。宿主可选注入 —— onething 的 provider 设置
   * 整套 per-space(C2),而标题模型这类**不经过 getEffectiveConfig 的**解析点
   * 手里只有 sessionId。缺席 = 与 `getSettings()` 同一份(引擎自己不知道空间
   * 是什么,也不该知道)。
   */
  getSettingsForSession?(sessionId: string): TSettings
  getSession(sessionId: string): TSession | undefined
  /**
   * 读门面(P0.2 area ①,C1)—— core 不许再从 session 上取 `messages`
   * (docs/design/session-commands-p0-2026-08.md §3)。宿主把它接到
   * `sessionReads.listMessages` / `getMessage` 上。
   *
   * 每次用的时候现取:命令面是 COW 的,任何跨 `await` 捏在手里的数组都可能过期。
   */
  listMessages(sessionId: string): readonly TMessage[]
  getMessage(sessionId: string, messageId: string): TMessage | undefined
  /**
   * 追加一条消息,**返回真正入库的那一条**(F4-a,§16.12)。
   *
   * 返回值不是便利,是**产地的取材口**:宿主在入库那一刻可能给消息盖章
   * (onething 的协作署名 `agentId` / `source`),而盖章是 COW 的 —— 调用方手里
   * 那条与入库的那条是两个对象。谁要拿"这条消息实际长什么样"去写别的账
   * (引擎入口把助手占位的时刻 / origin 带进宿主的 run 记录),就必须拿到入库
   * 那一份,否则只能事后回读一次,而回读是一个可以不存在的时序窗口。
   *
   * 宿主不盖章时原样返回入参 —— core 不知道也不该知道有没有盖章这件事。
   *
   * **这是 P0 端口形状冻结的唯一指名豁免**(§16.11 拍板 1 的注)。
   */
  addMessage(sessionId: string, message: TMessage): TMessage
  renameSession(sessionId: string, name: string): void
  updateMessageAndTruncate(
    sessionId: string,
    messageId: string,
    newContent: string,
    options?: { contentParts?: unknown[] | null }
  ): boolean
  deleteMessageAndTruncate(sessionId: string, messageId: string): boolean
  deleteMessage(sessionId: string, messageId: string): boolean
}

export interface StreamEngineIdAdapter {
  createId(): string
}

export interface StreamEngineClockAdapter {
  now(): number
}

export interface StreamEnginePermissionAdapter {
  clearSession(sessionId: string): void
}

export interface StreamEngineSkillsAdapter<TSkill = unknown> {
  getForSession(workingDirectory?: string, agentId?: string): TSkill[]
}

export interface StreamEnginePromptResolution<TContentPart = unknown> {
  modelContent: string
  displayContent: string
  contentParts?: TContentPart[]
}

export interface StreamEnginePromptAdapter<TSkill = unknown, TContentPart = unknown> {
  resolveReferences(
    content: string,
    options: { skills: TSkill[] }
  ): StreamEnginePromptResolution<TContentPart>
}

export interface StreamEngineMediaAdapter<TAttachment = unknown> {
  ingestMessageAttachments(
    sessionId: string,
    messageId: string,
    role: string,
    attachments: TAttachment[] | undefined
  ): unknown
}

export interface StreamEngineHistoryAdapter<TSession = unknown, TMessage = unknown, THistoryMessage = unknown> {
  buildMessages(messages: TMessage[], session?: TSession): THistoryMessage[]
  buildResumeAfterToolConfirmation(historyMessages: THistoryMessage[], assistantMessage: TMessage): THistoryMessage[]
}

export interface StreamEngineProviderAdapter<TSettings = unknown, TProviderConfig = unknown, TAuthContext = unknown> {
  getEffectiveConfig(
    settings: TSettings,
    sessionId: string,
    override?: { providerId?: string; model?: string; thinking?: boolean; thinkingEffort?: string } | null
  ): { providerId: string; providerConfig: TProviderConfig; model: string }
  resolveAuth(providerId: string, providerConfig: TProviderConfig): Promise<TAuthContext | null>
  /**
   * Optional: let the host re-scope a provider config it did not hand out
   * through `getEffectiveConfig` (title generation resolves the tool-call
   * model straight off settings). Absent = identity.
   */
  applySpaceCredentials?(
    sessionId: string,
    providerId: string,
    providerConfig: TProviderConfig,
  ): TProviderConfig
  /**
   * Optional: a host-supplied reason for why `resolveAuth` came back empty.
   * When it returns a string the engine surfaces that instead of the generic
   * "API Key not configured" / "Not logged in" lines — the host knows things
   * the engine cannot (which workspace this session belongs to, which
   * credential pool was consulted). Absent or undefined = unchanged behaviour.
   */
  describeMissingCredentials?(
    providerId: string,
    providerConfig: TProviderConfig,
    sessionId: string,
  ): string | undefined
  getApiType(settings: TSettings, providerId: string): unknown
  isSupported(providerId: string): boolean
  requiresOAuth(providerId: string): boolean
  generateTitle(
    providerId: string,
    providerConfig: Record<string, unknown>,
    content: string,
    options?: Record<string, unknown>
  ): Promise<string>
}

export interface StreamEngineModelRegistryAdapter {
  getModelContextLength(model: string, providerId: string): Promise<number>
  getModelMaxOutputTokens(model: string, providerId: string): Promise<number>
}

export interface StreamEngineStreamsAdapter<THistoryMessage = unknown, TStreamResult = unknown> {
  /**
   * 助手占位**入库的同一同步段**里,宿主把这条消息在它自己的账本上开张
   * (F4-c c4-d,`docs/design/session-event-sourcing-2026-08.md` §16.27)。
   *
   * 必须紧贴 `store.addMessage` 那一行,中间不许有 `await` —— 这一口的全部意义
   * 就是"入库与开账在同一个同步段",隔一个 await 就又有窗口了。
   *
   * **同步、无返回值、可缺席**:core 不知道宿主有没有账本(测试的 mock store
   * 就没有),缺席 = 宿主自己在别处开张,行为与 c4-d 之前逐字相同。
   */
  openAssistantRun?(options: Record<string, unknown>): void
  executeMessageStream(options: Record<string, unknown>): Promise<void>
  executeAgentLoopStreamGeneration(
    context: unknown,
    historyMessages: THistoryMessage[],
    sessionName?: string,
    options?: unknown
  ): Promise<TStreamResult>
}

export interface StreamEngineCompactionAdapter<TCompactOptions = unknown, TCompactResult = unknown> {
  compactSessionContext(options: TCompactOptions): Promise<TCompactResult>
  getContextCompactReason(options: unknown): string | null
  shouldSkipAutoCompactForProviderUsageMismatch(options: unknown): boolean
}

export interface StreamEngineRuntime<TSettings = unknown, TSession = unknown, TMessage = unknown> {
  store: StreamEngineStoreAdapter<TSettings, TSession, TMessage>
  ids: StreamEngineIdAdapter
  clock: StreamEngineClockAdapter
  permission: StreamEnginePermissionAdapter
}

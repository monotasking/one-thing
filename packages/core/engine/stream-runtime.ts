export interface StreamEngineStoreAdapter<TSettings = unknown, TSession = unknown, TMessage = unknown> {
  getSettings(): TSettings
  getSession(sessionId: string): TSession | undefined
  addMessage(sessionId: string, message: TMessage): void
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

export interface StreamEngineVariablesAdapter {
  /**
   * Text for the per-turn <context-update> block (turn-volatile context
   * variables). Attached to the user message at send time and persisted
   * there, so history rebuilds replay identical bytes (prompt-cache safe).
   */
  buildTurnContext(sessionId: string): Promise<string> | string
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

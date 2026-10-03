type MaybePromise<T> = T | Promise<T>

export interface OnethingTokenUsageLike {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs?: number
}

export interface OnethingLastTurnUsageLike {
  inputTokens: number
  outputTokens: number
}

export interface OnethingSessionTokenUsageLike {
  totalInputTokens?: number
  totalOutputTokens?: number
  totalTokens?: number
  lastInputTokens?: number
  contextSize?: number
}

export interface OnethingSessionTokenUsageForIpc {
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  maxTokens: number
  lastInputTokens: number
  contextSize: number
}

export interface UpdateOnethingSessionUsageOptions<TUsage extends OnethingTokenUsageLike = OnethingTokenUsageLike> {
  sessionId: string
  usage: TUsage
  lastTurnUsage?: OnethingLastTurnUsageLike
  updateSessionTokenUsage(
    sessionId: string,
    usage: TUsage,
    lastTurnUsage?: OnethingLastTurnUsageLike,
  ): MaybePromise<unknown>
}

export function normalizeOnethingSessionTokenUsage(
  usage: OnethingSessionTokenUsageLike | undefined | null,
  maxTokens = 128000,
): OnethingSessionTokenUsageForIpc {
  return {
    totalInputTokens: usage?.totalInputTokens ?? 0,
    totalOutputTokens: usage?.totalOutputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    maxTokens,
    lastInputTokens: usage?.lastInputTokens ?? 0,
    contextSize: usage?.contextSize ?? 0,
  }
}

export function updateOnethingSessionUsage<TUsage extends OnethingTokenUsageLike>(
  options: UpdateOnethingSessionUsageOptions<TUsage>,
): void {
  void options.updateSessionTokenUsage(options.sessionId, options.usage, options.lastTurnUsage)
}

export function getOnethingSessionUsage(
  options: {
    sessionId: string
    maxTokens?: number
    getSessionTokenUsage(sessionId: string): OnethingSessionTokenUsageLike | undefined | null
  },
): OnethingSessionTokenUsageForIpc {
  return normalizeOnethingSessionTokenUsage(
    options.getSessionTokenUsage(options.sessionId),
    options.maxTokens,
  )
}

export function clearOnethingSessionUsage(_sessionId: string): void {
  // No-op: deleting the session storage owns usage cleanup.
}

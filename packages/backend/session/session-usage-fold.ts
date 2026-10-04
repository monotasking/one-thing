// 会话用量折叠(从 `session-store-helpers.ts` 拆出,拆分批 1,D226):把每条消息带回来的 token 用量累进会话、
// 落账户用量、记上下文大小、取用量快照,以及删改消息时把它那份用量加回 / 减掉。纯函数,只改递进来的对象。
// 与 `session-usage.ts` 是两件事:那只是给界面读写用量的那一层(经适配器取会话、归一化成 IPC 形状)。
import type { CoreSessionMessage } from './session-meta.js'
import type { CoreSessionDetails } from './session-details.js'

export interface CoreSessionTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface CoreSessionLastTurnUsage {
  inputTokens: number
  outputTokens?: number
}

export interface CoreSessionUsageFields {
  totalInputTokens?: number
  totalOutputTokens?: number
  totalTokens?: number
  lastInputTokens?: number
  contextSize?: number
}

export interface CoreSessionUsageSnapshot {
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  lastInputTokens: number
  contextSize: number
}

export interface CoreSessionMessageWithUsage extends CoreSessionMessage {
  id: string
  usage?: CoreSessionTokenUsage
}

export function hasSessionUsageDetails(details: CoreSessionDetails): boolean {
  return details.contextSize !== undefined ||
    details.lastInputTokens !== undefined ||
    details.totalInputTokens !== undefined ||
    details.totalOutputTokens !== undefined ||
    details.totalTokens !== undefined
}

export function applySessionTokenUsage<TSession extends CoreSessionUsageFields>(
  session: TSession,
  usage: CoreSessionTokenUsage,
  lastTurnUsage?: CoreSessionLastTurnUsage,
): TSession {
  session.totalInputTokens = (session.totalInputTokens || 0) + usage.inputTokens
  session.totalOutputTokens = (session.totalOutputTokens || 0) + usage.outputTokens
  session.totalTokens = (session.totalTokens || 0) + usage.totalTokens

  if (lastTurnUsage) {
    session.lastInputTokens = Math.max(0, lastTurnUsage.inputTokens)
    session.contextSize = Math.max(0, lastTurnUsage.inputTokens)
  }
  return session
}

/**
 * **按账落格**(§17.7 #15 裁定 1):把会话账折出来的用量三格 + 上下文两格**盖**上去。
 *
 * 与 `applySessionTokenUsage` 的区别是**覆盖 vs 加法**:折叠账已经是"这条会话到此刻
 * 的总量",再加一次就是重复计数 —— 那正是收口前那个"容器 = 账本 × 2"的病根。
 * 产地是账本(`request/response.usage` 累加 / `session/compacted.retainedContextSize`),
 * 这里只是搬运。
 */
export function landSessionAccountUsage<TSession extends CoreSessionUsageFields>(
  session: TSession,
  snapshot: {
    totalInputTokens: number
    totalOutputTokens: number
    totalTokens: number
    contextSize?: number
    lastInputTokens?: number
  },
): TSession {
  session.totalInputTokens = Math.max(0, snapshot.totalInputTokens)
  session.totalOutputTokens = Math.max(0, snapshot.totalOutputTokens)
  session.totalTokens = Math.max(0, snapshot.totalTokens)
  if (snapshot.contextSize !== undefined) {
    session.contextSize = Math.max(0, snapshot.contextSize)
  }
  if (snapshot.lastInputTokens !== undefined) {
    session.lastInputTokens = Math.max(0, snapshot.lastInputTokens)
  }
  return session
}

export function applySessionContextSize<TSession extends CoreSessionUsageFields>(
  session: TSession,
  contextSize: number,
): TSession {
  const normalized = Math.max(0, contextSize)
  session.lastInputTokens = normalized
  session.contextSize = normalized
  return session
}

export function getSessionTokenUsageSnapshot(
  session: CoreSessionUsageFields,
): CoreSessionUsageSnapshot {
  return {
    totalInputTokens: session.totalInputTokens || 0,
    totalOutputTokens: session.totalOutputTokens || 0,
    totalTokens: session.totalTokens || 0,
    lastInputTokens: session.lastInputTokens || 0,
    contextSize: session.contextSize || 0,
  }
}

export function sumSessionMessageUsage<TMessage extends CoreSessionMessageWithUsage>(
  messages: TMessage[],
): CoreSessionTokenUsage {
  return messages.reduce<CoreSessionTokenUsage>((usage, message) => {
    if (!message.usage) return usage
    usage.inputTokens += message.usage.inputTokens
    usage.outputTokens += message.usage.outputTokens
    usage.totalTokens += message.usage.totalTokens
    return usage
  }, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  })
}

export function subtractSessionMessageUsage<
  TSession extends Pick<CoreSessionUsageFields, 'totalInputTokens' | 'totalOutputTokens' | 'totalTokens'>,
  TMessage extends CoreSessionMessageWithUsage,
>(
  session: TSession,
  messages: TMessage[],
): CoreSessionTokenUsage {
  const usage = sumSessionMessageUsage(messages)
  if (usage.totalTokens <= 0) return usage

  session.totalInputTokens = Math.max(0, (session.totalInputTokens || 0) - usage.inputTokens)
  session.totalOutputTokens = Math.max(0, (session.totalOutputTokens || 0) - usage.outputTokens)
  session.totalTokens = Math.max(0, (session.totalTokens || 0) - usage.totalTokens)
  return usage
}

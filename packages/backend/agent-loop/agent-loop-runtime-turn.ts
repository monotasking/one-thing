// 回合前后(从 `agent-loop-runtime.ts` 拆出,拆分批 1,D226):每一回合开始前要不要先压缩、把排队等着的消息
// 注进去、挂上瞬态尾块(只给这一回合看、不落进历史的那一块),回合结束后收尾。
import { type CoreAgentLoopCompactResultLike, type CoreAgentLoopCompactSessionLike, type CoreAgentLoopCompactionAdapters, type CoreAgentLoopCompactionContext, type CoreAgentLoopTurnCompactionAdapters, maybeCompactAgentLoopContextWithAdapters } from './agent-loop-runtime-compaction.js'
import type { CoreAgentLoopContextBudget } from './agent-loop-runtime-budget.js'

export interface CoreAgentLoopMessage {
  role: string
  content?: unknown
  toolCalls?: unknown[]
}

export interface CoreResolvedPendingAgentLoopMessage<TContentParts = unknown> {
  id: string
  modelContent: string
  timestamp: number
  contentParts?: TContentParts
  persisted?: boolean
  origin?: unknown
}

export interface CorePendingAgentLoopInputMessage {
  content: string
  timestamp: number
  source?: string
  id?: string
  modelContent?: string
  contentParts?: unknown
  persisted?: boolean
  origin?: unknown
}

export interface CorePendingAgentLoopPromptResolution<TContentParts = unknown> {
  modelContent: string
  contentParts?: TContentParts
}

export interface CorePendingAgentLoopRuntimeMessage {
  role: 'user'
  content: string
}

export interface CorePendingAgentLoopChatMessage<TContentParts = unknown> {
  id: string
  role: 'user'
  content: string
  timestamp: number
  contentParts?: TContentParts
  persisted?: boolean
  origin?: unknown
}

export interface CorePendingAgentLoopInjectionResult<
  TMessage extends CoreAgentLoopMessage = CoreAgentLoopMessage,
  TContentParts = unknown,
> {
  messages: Array<TMessage | CorePendingAgentLoopRuntimeMessage>
  chatMessages: Array<CorePendingAgentLoopChatMessage<TContentParts>>
}

export type CoreAgentLoopTurnMessages<TMessage extends CoreAgentLoopMessage = CoreAgentLoopMessage> =
  Array<TMessage | CorePendingAgentLoopRuntimeMessage>

export interface CoreAgentLoopBeforeTurnResult<
  TMessage extends CoreAgentLoopMessage = CoreAgentLoopMessage,
> {
  messages: CoreAgentLoopTurnMessages<TMessage>
  /**
   * A steering user message was injected before this turn: the caller must
   * surface it to the loop as a response boundary so the answer starts a
   * new assistant response instead of continuing the interrupted one.
   */
  startNewResponse: boolean
}

export interface CoreAgentLoopPendingMessageAdapters<TContentParts = unknown> {
  createPendingMessageId(): string
  resolvePromptReferences(content: string): CorePendingAgentLoopPromptResolution<TContentParts>
  persistInjectedChatMessage(message: CorePendingAgentLoopChatMessage<TContentParts>): void | Promise<void>
}

export interface CoreAgentLoopTurnQueueAdapters {
  drainSteeringMessages?: () => CorePendingAgentLoopInputMessage[]
  drainFollowUpMessages?: () => CorePendingAgentLoopInputMessage[]
}

/** 瞬态尾块的哨兵:一条 user 消息,正文以这个开头,就是上一轮挂的那一块。 */
export const CORE_EPHEMERAL_TAIL_SENTINEL = '<scratchpad '

export interface CoreAgentLoopEphemeralTail {
  /** 整块正文(自带哨兵开头)。 */
  text: string
  /** 内容版本;与在场那一块相同 = 原样保留,不重挂、不回调。 */
  version: number
}

/**
 * 每 turn 一块的**瞬态尾块** —— 进模型、不进聊天流、不持久化。
 *
 * 语义是**替换而非追加**:先按哨兵把上一块从数组里剥掉,再把新的一块 push 到
 * 尾巴。所以连跑 20 个 turn 也只有一块在场(token 不累积),而缓存前缀只从
 * 尾巴那里失效 —— 那里本来就是边界。
 *
 * 适配器缺席 = 一个字节都不变(整段跳过)。
 */
export interface CoreAgentLoopEphemeralTailAdapters {
  buildEphemeralTail?: (turn: number) => Promise<CoreAgentLoopEphemeralTail | undefined>
  onEphemeralTailInjected?: (info: { turn: number, version: number }) => void
}

export interface RunAgentLoopBeforeTurnWithAdaptersOptions<
  TSettings,
  TProviderConfig extends object,
  TSession extends CoreAgentLoopCompactSessionLike,
  TMessage extends CoreAgentLoopMessage,
  TContentParts = unknown,
  TCompactResult extends CoreAgentLoopCompactResultLike = CoreAgentLoopCompactResultLike,
> {
  ctx: CoreAgentLoopCompactionContext<TSettings, TProviderConfig>
  turn: number
  messages: TMessage[]
  budget: CoreAgentLoopContextBudget
  compactEnabled: boolean
  keepRecentTurns: number
  rebuildMessages(messages: CoreAgentLoopTurnMessages<TMessage>): Promise<TMessage[]>
  adapters:
    & CoreAgentLoopPendingMessageAdapters<TContentParts>
    & CoreAgentLoopTurnQueueAdapters
    & CoreAgentLoopEphemeralTailAdapters
    & CoreAgentLoopTurnCompactionAdapters<TSettings, TProviderConfig, TSession, TMessage, TCompactResult>
}

export interface RunAgentLoopAfterTurnWithAdaptersOptions<
  TMessage extends CoreAgentLoopMessage,
  TContentParts = unknown,
> {
  messages: TMessage[]
  adapters: CoreAgentLoopPendingMessageAdapters<TContentParts> & CoreAgentLoopTurnQueueAdapters
}

export function getAgentLoopTransientTail<TMessage extends CoreAgentLoopMessage>(messages: TMessage[]): TMessage[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      return messages.slice(index).map(item => ({ ...item }))
    }
  }
  return []
}

export function buildPendingAgentLoopMessageInjections<
  TMessage extends CoreAgentLoopMessage,
  TContentParts = unknown,
>(
  messages: TMessage[],
  pendingMessages: Array<CoreResolvedPendingAgentLoopMessage<TContentParts>>,
): CorePendingAgentLoopInjectionResult<TMessage, TContentParts> | undefined {
  if (pendingMessages.length === 0) return undefined

  const nextMessages: Array<TMessage | CorePendingAgentLoopRuntimeMessage> = messages.map(message => ({ ...message }))
  const chatMessages: Array<CorePendingAgentLoopChatMessage<TContentParts>> = []

  for (const pending of pendingMessages) {
    nextMessages.push({ role: 'user', content: pending.modelContent })
    chatMessages.push({
      id: pending.id,
      role: 'user',
      content: pending.modelContent,
      timestamp: pending.timestamp,
      contentParts: pending.contentParts,
      ...(pending.origin !== undefined ? { origin: pending.origin } : {}),
      ...(pending.persisted ? { persisted: true } : {}),
    })
  }

  return {
    messages: nextMessages,
    chatMessages,
  }
}

export async function injectPendingAgentLoopMessagesWithAdapters<
  TMessage extends CoreAgentLoopMessage,
  TContentParts = unknown,
>(options: {
  messages: TMessage[]
  pendingMessages: CorePendingAgentLoopInputMessage[]
  adapters: CoreAgentLoopPendingMessageAdapters<TContentParts>
}): Promise<CoreAgentLoopTurnMessages<TMessage> | undefined> {
  const resolvedPendingMessages = resolvePendingAgentLoopMessages<TContentParts>(
    options.pendingMessages,
    {
      createId: options.adapters.createPendingMessageId,
      resolvePromptReferences: options.adapters.resolvePromptReferences,
    },
  )
  const injection = buildPendingAgentLoopMessageInjections<TMessage, TContentParts>(
    options.messages,
    resolvedPendingMessages,
  )
  if (!injection) return undefined

  for (const chatMessage of injection.chatMessages) {
    if (chatMessage.persisted) continue
    await options.adapters.persistInjectedChatMessage({
      id: chatMessage.id,
      role: chatMessage.role,
      content: chatMessage.content,
      timestamp: chatMessage.timestamp,
      contentParts: chatMessage.contentParts,
      ...(chatMessage.origin !== undefined ? { origin: chatMessage.origin } : {}),
    })
  }

  return injection.messages
}

export function resolvePendingAgentLoopMessages<TContentParts = unknown>(
  pendingMessages: CorePendingAgentLoopInputMessage[],
  options: {
    resolvePromptReferences: (content: string) => CorePendingAgentLoopPromptResolution<TContentParts>
    createId: () => string
  },
): CoreResolvedPendingAgentLoopMessage<TContentParts>[] {
  return pendingMessages.map(pending => {
    if (typeof pending.modelContent === 'string') {
      return {
        id: pending.id ?? options.createId(),
        modelContent: pending.modelContent,
        timestamp: pending.timestamp,
        contentParts: pending.contentParts as TContentParts | undefined,
        ...(pending.origin !== undefined ? { origin: pending.origin } : {}),
        ...(pending.persisted ? { persisted: true } : {}),
      }
    }

    const resolvedPromptRefs = options.resolvePromptReferences(pending.content)
    return {
      id: pending.id ?? options.createId(),
      modelContent: resolvedPromptRefs.modelContent,
      timestamp: pending.timestamp,
      contentParts: resolvedPromptRefs.contentParts,
      ...(pending.origin !== undefined ? { origin: pending.origin } : {}),
      ...(pending.persisted ? { persisted: true } : {}),
    }
  })
}

function isEphemeralTailMessage(message: { role?: string, content?: unknown }): boolean {
  return message.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(CORE_EPHEMERAL_TAIL_SENTINEL)
}

/**
 * 把瞬态尾块换成新的一块。返回 undefined = 没有任何变化(数组原样,调用方不必
 * 重建)。
 *
 * 三种情况:
 *  - 没有适配器 / 适配器返回 undefined → 剥掉在场的旧块(纸被清空了就不该还挂着),
 *    没有旧块则原样返回 undefined。
 *  - 在场那块版本相同 → **原样保留**,不重挂也不发回调(逐字去重,免得同一
 *    版本在账上被消费两次)。
 *  - 其余 → 剥旧 + push 新 + 回调。
 */
export async function applyAgentLoopEphemeralTail<TMessage extends CoreAgentLoopMessage>(options: {
  messages: CoreAgentLoopTurnMessages<TMessage>
  turn: number
  adapters: CoreAgentLoopEphemeralTailAdapters
}): Promise<CoreAgentLoopTurnMessages<TMessage> | undefined> {
  const { messages, adapters } = options
  const existingIndex = messages.findIndex(isEphemeralTailMessage)
  const tail = adapters.buildEphemeralTail
    ? await adapters.buildEphemeralTail(options.turn)
    : undefined

  if (!tail) {
    if (existingIndex < 0) return undefined
    return messages.filter(message => !isEphemeralTailMessage(message))
  }

  if (existingIndex >= 0) {
    const existing = messages[existingIndex]
    if (typeof existing.content === 'string' && existing.content === tail.text) {
      // 已经在场且逐字相同 —— 什么都不做才是对的。
      return undefined
    }
  }

  const next: CoreAgentLoopTurnMessages<TMessage> = messages.filter(
    message => !isEphemeralTailMessage(message),
  )
  next.push({ role: 'user', content: tail.text })
  adapters.onEphemeralTailInjected?.({ turn: options.turn, version: tail.version })
  return next
}

export async function runAgentLoopBeforeTurnWithAdapters<
  TSettings,
  TProviderConfig extends object,
  TSession extends CoreAgentLoopCompactSessionLike,
  TMessage extends CoreAgentLoopMessage,
  TContentParts = unknown,
  TCompactResult extends CoreAgentLoopCompactResultLike = CoreAgentLoopCompactResultLike,
>(
  options: RunAgentLoopBeforeTurnWithAdaptersOptions<
    TSettings,
    TProviderConfig,
    TSession,
    TMessage,
    TContentParts,
    TCompactResult
  >,
): Promise<CoreAgentLoopBeforeTurnResult<TMessage> | undefined> {
  let nextMessages: CoreAgentLoopTurnMessages<TMessage> = options.messages
  // F9:「这一轮到底换没换消息」用显式标记记,不靠 `nextMessages === options.messages`
  // 比引用 —— COW 之后身份判断随时可能恒为假(上游换了数组,内容却一字未动),
  // 那样这条路会把"什么都没发生"报成"重开一条回复"。
  let changed = false
  const pendingSteeringMessages = options.adapters.drainSteeringMessages?.() ?? []
  const injectedMessages = await injectPendingAgentLoopMessagesWithAdapters({
    messages: nextMessages as TMessage[],
    pendingMessages: pendingSteeringMessages,
    adapters: options.adapters,
  })
  const startNewResponse = Boolean(injectedMessages)
  if (injectedMessages) {
    nextMessages = injectedMessages
    changed = true
  }

  const compactAdapters: CoreAgentLoopCompactionAdapters<
    TSettings,
    TProviderConfig,
    TSession,
    TMessage,
    TCompactResult
  > = {
    getSession: options.adapters.getSession,
    compactSessionContext: options.adapters.compactSessionContext,
    emitEvent: options.adapters.emitEvent,
    shouldSkipProviderUsageMismatch: options.adapters.shouldSkipProviderUsageMismatch,
    logger: options.adapters.logger,
    rebuildMessages: () => options.rebuildMessages(nextMessages),
  }
  const compactedMessages = await maybeCompactAgentLoopContextWithAdapters({
    ctx: options.ctx,
    turn: options.turn,
    messages: nextMessages as TMessage[],
    budget: options.budget,
    compactEnabled: options.compactEnabled,
    keepRecentTurns: options.keepRecentTurns,
    adapters: compactAdapters,
  })
  if (compactedMessages) {
    // 压缩 rebuild 是从会话历史重新拼的,天然不含尾块 —— 所以压完之后要重新挂,
    // 而不是"压缩后这一轮就没有草稿纸了"。
    const compactedWithTail = await applyAgentLoopEphemeralTail({
      messages: compactedMessages,
      turn: options.turn,
      adapters: options.adapters,
    })
    return { messages: compactedWithTail ?? compactedMessages, startNewResponse }
  }

  // 尾块最后挂:它是**瞬态**的,不该参与上面那两处按历史算的预算判定
  // (算进去等于让一块随时会消失的内容去触发压缩)。
  const withTail = await applyAgentLoopEphemeralTail({
    messages: nextMessages,
    turn: options.turn,
    adapters: options.adapters,
  })
  if (withTail) {
    nextMessages = withTail
    changed = true
  }

  return changed ? { messages: nextMessages, startNewResponse } : undefined
}

export async function runAgentLoopAfterTurnWithAdapters<
  TMessage extends CoreAgentLoopMessage,
  TContentParts = unknown,
>(
  options: RunAgentLoopAfterTurnWithAdaptersOptions<TMessage, TContentParts>,
): Promise<CoreAgentLoopTurnMessages<TMessage> | undefined> {
  const steeringMessages = options.adapters.drainSteeringMessages?.() ?? []
  if (steeringMessages.length > 0) {
    return injectPendingAgentLoopMessagesWithAdapters({
      messages: options.messages,
      pendingMessages: steeringMessages,
      adapters: options.adapters,
    })
  }

  const followUpMessages = options.adapters.drainFollowUpMessages?.() ?? []
  return injectPendingAgentLoopMessagesWithAdapters({
    messages: options.messages,
    pendingMessages: followUpMessages,
    adapters: options.adapters,
  })
}

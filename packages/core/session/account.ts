/**
 * **会话账的折叠器**(§17.7.1 批 2 / #8b-i;`docs/design/session-event-sourcing-2026-08.md`)。
 *
 * 老 reducer(`session/commands.ts`)剩下的唯一身份是**会话级派生的算法**:
 * `updatedAt` / `lastProvider` / `lastModel` / usage 总账的扣减 /
 * `contextSize`·`lastInputTokens`·`summary` 的失效。这个文件把同一本账改成
 * **事件的折叠产物** —— 定律①(事实一条流,状态即折叠)在会话级的兑现。
 *
 * ## 它不是消息投影的一部分
 *
 * 选型(批 2 勘察定案,§17.7.1 批 2 落地记录):**独立的 `SessionAccountState`,
 * 不挂进 `projection/reducer.ts` 的 state**。两条理由:
 *
 *  1. 会话账里唯一"要看整份消息列表"的那一格(截断触发的
 *     `computeSessionTimelineMetadataRepair`)如果住进消息归约器,就等于让**每一条**
 *     事件都背上一次可能的整会话物化 —— 而它一个会话一生只跑几次;
 *  2. 消息归约器是**移动语义 + 线性持有**的(节点就地改,`forWrite` 换 rev),
 *     会话账是**值语义**的小结构(每条事件返回新对象)。两种所有权约定放进同一个
 *     state 上,迟早有人拿旧引用读新账。
 *
 * 刷新点仍然同源:装配层把它挂在**同一个** F1 写入口观察者上
 * (`backend/session/projection-cache.ts`),与消息投影一起前进、一起重建。
 *
 * ## 产地表(逐格,与今天 reducer 的盖章面逐字对齐)
 *
 * | 账格 | 产地 |
 * |---|---|
 * | `updatedAt` | 账目事件的时刻。账目事件 = 今天那 6 条会盖章的命令写出来的那些:`user/message` / `system/message` / `message/imported` / `message/deleted` / `user/message-edited` / `session/cleared`,外加两条**带显式事实**的:`message/patched{via:'upsert'}` 与 `run/start{createdAssistantMessage}`。`patchMessage` 写出的 `message/patched`(无 `via`)**不盖** —— reducer 的 `patchMessage` 分支同样不盖 |
 * | `lastProvider` / `lastModel` | 三处:`run/start{createdAssistantMessage}` 的 `provider`/`model`(流式助手占位那一路)、`system/message` 里 role 为 assistant 的那条消息自带的两格、以及 `session/model-changed`(**用户手动挑模型**那一路 —— 容器上那一格由 `applySessionModel` 写、不经归约器,但事件产地是现成的;裁定 4 的口径是"对拍容器上此刻的值,无论谁写")。`message/imported`(replaceAll)与 `message/patched{via}`(upsert 命中支)**不盖**,与 reducer 逐字相同 |
 * | usage 三件 | `request/response.usage` 累加;截断事件按**折叠自己的消息列表**算扣减(与写门的 `subtractedUsageFromProjection` 同一把判定点) |
 * | `contextSize` / `lastInputTokens` | `request/response.usage.inputTokens`(最近一次请求);截断事件按 `computeSessionTimelineMetadataRepair` 重算 |
 * | `summary` 三件 | `session/compacted` 落,截断事件按同一个函数判失效 |
 *
 * **`tool/audit` 等旁录不盖任何一格** —— 它们不是账目事件。
 *
 * ## 两条纪律
 *
 * 1. **只读事件字段**。不读墙钟、不读进程态、不读 store。`reduceSessionAccount`
 *    对同一条事件序列折两次必须逐格相等(`__tests__/session-account.test.ts` 的
 *    确定性预检),否则 refold 那道门在批 3 扩栏之后会随机红。
 * 2. **缺席=不盖**(纪律 9,成对交付)。`createdAssistantMessage` / `via` 都是
 *    append-only 的可选格,老账本里没有 → 那条事件不盖章,与老账本当年的行为一致。
 */

import type { SessionLogEventRecord } from './events/types.js'
import type { CoreTimelineMessage } from './timeline.js'
import { computeSessionTimelineMetadataRepair } from './timeline.js'

/** 会话账的三格用量(与 `CoreSessionTokenUsage` 同形)。 */
export interface SessionAccountUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/**
 * 一次截断在会话账上留下的**补丁** —— 也就是老 reducer 的 `applyTruncate`
 * 在会话级写了什么。批 2 的影子拿它与 store 容器的前后差做逐格对拍;批 3 之后
 * 它就是那一格的唯一产地。
 */
export interface SessionAccountTruncationEffect {
  /** 这次截断从总账里扣掉的用量(没有可扣的三格都是 0)。 */
  subtracted: SessionAccountUsage
  /** `computeSessionTimelineMetadataRepair` 算出来的会话级改写(可能是空的)。 */
  patch: Record<string, unknown>
  /** 同一次修复要删掉的会话级字段(summary 三件)。 */
  deletes: string[]
}

export interface SessionAccountState {
  /** 这间会话最后一次变账的时刻。没有任何账目事件时缺席。 */
  updatedAt?: number
  lastProvider?: string
  lastModel?: string
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  contextSize?: number
  lastInputTokens?: number
  summary?: string
  summaryUpToMessageId?: string
  summaryCreatedAt?: number
  /**
   * 最近一次截断的补丁(见 `SessionAccountTruncationEffect`)。它是折叠产物,
   * 不是簿记:同一条事件序列折出来的永远是同一份。
   */
  lastTruncation?: SessionAccountTruncationEffect
}

/**
 * 折叠时装配层递进来的上下文。
 *
 * 只有**截断类**事件会用到它(一个会话一生几次),所以它是惰性的:折叠器在真的
 * 需要"这次截断之后还剩哪些消息"时才调,普通事件一次都不调。
 */
export interface SessionAccountFoldContext {
  /**
   * 这条事件**折进消息投影之后**的可见消息(物化产物即可,只读 `id`/`usage`/
   * `steps`/`role`)。缺席 = 这次不算 timeline 修复(与"投影不在手边"同义)。
   */
  messagesAfter?(event: SessionLogEventRecord): CoreTimelineMessage[] | undefined
  /** 会话 id,只用于 `computeSessionTimelineMetadataRepair` 的日志字段。 */
  sessionId?: string
}

export function createSessionAccountState(): SessionAccountState {
  return { totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 }
}

/**
 * 盖 `updatedAt` 的那一批事件 —— **不带条件的那几种**。
 *
 * `message/patched` 与 `run/start` 不在表里:它们是否算账目事件,取决于事件
 * 自己带的那一格显式事实(`via` / `createdAssistantMessage`),见 `stampsAccount`。
 */
const UNCONDITIONAL_ACCOUNT_EVENTS = new Set<string>([
  'user/message',
  'system/message',
  'message/imported',
  'message/deleted',
  'user/message-edited',
  'session/cleared',
])

/** 会把消息从 surface 上砍掉的那两种(截断的两支)。 */
const TRUNCATION_EVENTS = new Set<string>([
  'message/deleted',
  'user/message-edited',
  'session/cleared',
])

interface PatchedData { via?: string }
interface RunStartData {
  createdAssistantMessage?: boolean
  provider?: string
  model?: string
  timestamp?: number
}

/** 这条事件是不是"账目事件"(= 今天会让 reducer 盖 `updatedAt` 的那些命令写的)。 */
function stampsAccount(event: SessionLogEventRecord): boolean {
  if (UNCONDITIONAL_ACCOUNT_EVENTS.has(event.type)) return true
  if (event.type === 'message/patched') {
    return (event.data as PatchedData | undefined)?.via === 'upsert'
  }
  if (event.type === 'run/start') {
    return (event.data as RunStartData | undefined)?.createdAssistantMessage === true
  }
  return false
}

/**
 * 这条账目事件盖的是**哪个时刻**。
 *
 * 缺省是记录自己的 `time`(写门取一次刻双盖之后,它与 reducer 的 `now` 是同一个数)。
 * `run/start` 是唯一的例外:占位那一路的时刻在**创建点**就取过一次了,它同时是
 * 消息的 `timestamp`、`run/start.timestamp` 与写门递给 reducer 的那个数 ——
 * 所以折叠也认那一格,三处才是同一个数而不是三次读表。
 */
function stampTimeOf(event: SessionLogEventRecord): number {
  if (event.type === 'run/start') {
    const data = event.data as RunStartData | undefined
    if (typeof data?.timestamp === 'number') return data.timestamp
  }
  return event.time
}

function readUsage(value: unknown): SessionAccountUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown }
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
  const totalTokens = typeof usage.totalTokens === 'number'
    ? usage.totalTokens
    : inputTokens + outputTokens
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return undefined
  return { inputTokens, outputTokens, totalTokens }
}

function sumMessageUsage(messages: readonly CoreTimelineMessage[]): SessionAccountUsage {
  const total: SessionAccountUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  for (const message of messages) {
    const usage = readUsage((message as { usage?: unknown }).usage)
    if (!usage) continue
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    total.totalTokens += usage.totalTokens
  }
  return total
}

/**
 * 一条事件 → 新的会话账。**纯函数**:不改入参,没变就原样交回同一个对象
 * (引用比较即"这条事件动没动账")。
 */
export function reduceSessionAccount(
  account: SessionAccountState,
  event: SessionLogEventRecord,
  context: SessionAccountFoldContext = {},
): SessionAccountState {
  let next: SessionAccountState | undefined

  const mutate = (): SessionAccountState => {
    if (!next) next = { ...account }
    return next
  }

  if (stampsAccount(event)) {
    mutate().updatedAt = stampTimeOf(event)
  }

  if (event.type === 'run/start') {
    const data = event.data as RunStartData | undefined
    if (data?.createdAssistantMessage === true) {
      if (data.provider) mutate().lastProvider = data.provider
      if (data.model) mutate().lastModel = data.model
    }
  }

  // 用户**手动挑模型**那一路(§17.7.1 批 2 影子实测):容器上这两格由
  // `applySessionModel` 写(`store-helpers.ts`,不经归约器),而它的事件产地是
  // 现成的 —— `patchSession` 的 `session/model-changed`(三个产地共用一份构造)。
  // 裁定 4 的口径是"对拍容器上此刻的值,无论谁写",所以折叠也得认这一格,
  // 否则一条"只挑了模型还没开跑"的会话上两侧必然不等。
  if (event.type === 'session/model-changed') {
    const data = event.data as { to?: string; provider?: string } | undefined
    if (data?.to) mutate().lastModel = data.to
    if (data?.provider) mutate().lastProvider = data.provider
  }

  if (event.type === 'system/message') {
    const message = (event.data as { message?: Record<string, unknown> } | undefined)?.message
    if (message && message.role === 'assistant') {
      if (typeof message.provider === 'string' && message.provider) {
        mutate().lastProvider = message.provider
      }
      if (typeof message.model === 'string' && message.model) mutate().lastModel = message.model
    }
  }

  if (event.type === 'request/response') {
    const usage = readUsage((event.data as { usage?: unknown } | undefined)?.usage)
    if (usage) {
      const target = mutate()
      target.totalInputTokens = account.totalInputTokens + usage.inputTokens
      target.totalOutputTokens = account.totalOutputTokens + usage.outputTokens
      target.totalTokens = account.totalTokens + usage.totalTokens
      target.contextSize = usage.inputTokens
      target.lastInputTokens = usage.inputTokens
    }
  }

  if (event.type === 'session/compacted') {
    const data = event.data as {
      summary?: string
      messageId?: string
      compactedThroughMessageId?: string
      status?: string
      retainedContextSize?: number
    } | undefined
    if (data?.status !== 'failed' && typeof data?.summary === 'string' && data.summary.length > 0) {
      const target = mutate()
      target.summary = data.summary
      const anchor = data.compactedThroughMessageId ?? data.messageId
      if (anchor) target.summaryUpToMessageId = anchor
      target.summaryCreatedAt = event.time
    }
    // #15 裁定 2:压完还剩多少上下文由这条事件亲口说(写者当刻亲知)。
    // **缺席 = 不盖**(成对交付):老账本没有这一格,折叠维持原状 —— 那正是
    // 补产地之前的事实(要等下一次请求的 `request/response.usage` 才对上)。
    if (data?.status !== 'failed' && typeof data?.retainedContextSize === 'number') {
      const target = mutate()
      target.contextSize = Math.max(0, data.retainedContextSize)
      target.lastInputTokens = Math.max(0, data.retainedContextSize)
    }
  }

  if (TRUNCATION_EVENTS.has(event.type)) {
    const messages = context.messagesAfter?.(event)
    if (messages) {
      const before = next ?? account
      // 与写门的 `subtractedUsageFromProjection` 同一把判定点:被砍掉的那些消息
      // 的 usage 之和 = 会话总账减去**剩下这些**消息的 usage 之和。折叠侧手里
      // 只有"之后"那一份,所以用总账反推 —— 两边算的是同一批消息。
      const kept = sumMessageUsage(messages)
      const subtracted: SessionAccountUsage = {
        inputTokens: Math.max(0, before.totalInputTokens - kept.inputTokens),
        outputTokens: Math.max(0, before.totalOutputTokens - kept.outputTokens),
        totalTokens: Math.max(0, before.totalTokens - kept.totalTokens),
      }
      const repair = computeSessionTimelineMetadataRepair(
        {
          ...(context.sessionId ? { id: context.sessionId } : {}),
          ...(before.summary !== undefined ? { summary: before.summary } : {}),
          ...(before.summaryUpToMessageId !== undefined
            ? { summaryUpToMessageId: before.summaryUpToMessageId }
            : {}),
          ...(before.summaryCreatedAt !== undefined
            ? { summaryCreatedAt: before.summaryCreatedAt }
            : {}),
          ...(before.contextSize !== undefined ? { contextSize: before.contextSize } : {}),
          ...(before.lastInputTokens !== undefined
            ? { lastInputTokens: before.lastInputTokens }
            : {}),
        } as Parameters<typeof computeSessionTimelineMetadataRepair>[0],
        messages,
        { recomputeContextSize: true },
      )

      const target = mutate()
      if (subtracted.totalTokens > 0) {
        target.totalInputTokens = Math.max(0, before.totalInputTokens - subtracted.inputTokens)
        target.totalOutputTokens = Math.max(0, before.totalOutputTokens - subtracted.outputTokens)
        target.totalTokens = Math.max(0, before.totalTokens - subtracted.totalTokens)
      }
      if (typeof repair.patch.contextSize === 'number') target.contextSize = repair.patch.contextSize
      if (typeof repair.patch.lastInputTokens === 'number') {
        target.lastInputTokens = repair.patch.lastInputTokens
      }
      for (const key of repair.deletes) {
        delete (target as unknown as Record<string, unknown>)[key]
      }
      target.lastTruncation = {
        subtracted,
        patch: { ...repair.patch },
        deletes: [...repair.deletes],
      }
    }
  }

  return next ?? account
}

/** 整份事件流 → 会话账(建表 / 确定性预检 / 批 3 的 refold 扩栏用)。 */
export function foldSessionAccount(
  events: Iterable<SessionLogEventRecord>,
  context: SessionAccountFoldContext = {},
): SessionAccountState {
  let account = createSessionAccountState()
  for (const event of events) account = reduceSessionAccount(account, event, context)
  return account
}

/** 会话账里**对外的那几格**(影子对拍与批 3 的读面按它取值,不含 `lastTruncation`)。 */
export const SESSION_ACCOUNT_FIELDS = [
  'updatedAt',
  'lastProvider',
  'lastModel',
  'totalInputTokens',
  'totalOutputTokens',
  'totalTokens',
  'contextSize',
  'lastInputTokens',
  'summary',
  'summaryUpToMessageId',
  'summaryCreatedAt',
] as const

export type SessionAccountField = (typeof SESSION_ACCOUNT_FIELDS)[number]

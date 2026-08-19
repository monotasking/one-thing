/**
 * 会话消息命令面(纯函数层)—— docs/design/session-commands-p0-2026-08.md §1/§2。
 *
 * 这里是**唯一**知道"改一条会话消息意味着什么"的地方:
 *   - 语义:12 个命令(append/upsert/patch/…/repairOnLoad),外面不再有第二种写法;
 *   - COW:改哪条消息就新建哪条(以及 messages 数组本身),没改的原样复用引用 ——
 *     这样"谁变了"是可判定的(引用比较),而不是靠深比较猜;
 *   - 写计划:`SessionWritePlan`(后缀写 / 全量重写)与 lazy 档在这里**集中计算**,
 *     不再散在 22 个 mutator 里各写各的(那是 E2:5 处隐式 structural)。
 *
 * 纯度约定:`applySessionCommand` 不改入参 session、不改入参 messages/steps/toolCalls,
 * 也不落盘、不发事件。持久化/sqlite/index meta 由 `app/session/commands.ts` 接。
 * 唯一的例外是 `repairOnLoad` 里保留了原 `repairSessionTimelineMetadata` 的
 * console 输出(那几行日志是线上排障用的,搬走等于删),日志不改变返回值。
 */

import type { CoreSessionTokenUsage } from './store-helpers.js'
import type {
  CoreSessionRepairMessagePatch,
  CoreTimelineMessage,
  CoreTimelineStep,
  CoreToolCallState,
} from './timeline.js'
import { computeSessionRepairOnLoad, computeSessionTimelineMetadataRepair } from './timeline.js'

// ============ 形状 ============

/** 与 `sessions/storage-driver.ts` 的 `SessionWritePlan` 同形(core 不许依赖 runtime)。 */
export interface CoreSessionWritePlan {
  kind: 'meta' | 'message' | 'structural'
  /** kind === 'message' 时:最低脏消息的 seq(1 起);后缀重写从这里开始 */
  dirtySeq?: number
}

export const CORE_STRUCTURAL_WRITE_PLAN: CoreSessionWritePlan = { kind: 'structural' }

export interface CoreSessionCommandStep extends CoreTimelineStep {
  id: string
  toolCallId?: string
  childSteps?: CoreSessionCommandStep[]
}

export interface CoreSessionCommandMessage extends CoreTimelineMessage {
  contentParts?: unknown[]
  provider?: string
  model?: string
  usage?: CoreSessionTokenUsage
  steps?: CoreSessionCommandStep[]
}

export interface CoreSessionCommandSession<
  TMessage extends CoreSessionCommandMessage = CoreSessionCommandMessage,
> {
  id?: string
  messages: TMessage[]
  updatedAt: number
  lastProvider?: string
  lastModel?: string
  totalInputTokens?: number
  totalOutputTokens?: number
  totalTokens?: number
  lastInputTokens?: number
  contextSize?: number
  summary?: string
  summaryUpToMessageId?: string
  summaryCreatedAt?: number
}

// ============ 命令 ============

/**
 * `patchMessage` 的落盘档提示。
 *
 * `'stream'` = 逐 token 的高频路径,走 5s 的 lazy 档(与今天
 * `updateMessageContent/Reasoning/ContentParts/ThinkingTime` 的 `{lazy:true}` 一致);
 * `'settle'` = 收尾/元数据,走 300ms 常规档。**不给 hint 时**按 patch 的键推断:
 * 键集合完全落在 content/reasoning/contentParts/thinkingTime 里就算 stream 档 ——
 * 这条推断只是为了让老 mutator 的薄包装不必逐个改口径,显式 hint 永远优先。
 */
export type SessionCommandWriteHint = 'stream' | 'settle'

const LEGACY_LAZY_PATCH_KEYS = new Set(['content', 'reasoning', 'contentParts', 'thinkingTime'])

export type SessionCommand<TMessage extends CoreSessionCommandMessage = CoreSessionCommandMessage> =
  | { type: 'appendMessage'; message: TMessage; now?: number }
  | { type: 'upsertMessage'; message: TMessage; now?: number }
  | {
      type: 'patchMessage'
      messageId: string
      patch: Partial<TMessage>
      hint?: SessionCommandWriteHint
    }
  | { type: 'appendContentPart'; messageId: string; part: unknown }
  | { type: 'upsertStep'; messageId: string; step: CoreSessionCommandStep }
  | {
      type: 'patchStep'
      messageId: string
      stepId: string
      updates: Partial<CoreSessionCommandStep>
    }
  | { type: 'patchStepsUsageByTurn'; messageId: string; turnIndex: number; usage: unknown }
  | { type: 'setToolCalls'; messageId: string; toolCalls: CoreToolCallState[] }
  | {
      type: 'truncateFrom'
      messageId: string
      /** true = 连这条一起删(regenerate);false = 保留这条并按 newContent 改写(edit) */
      inclusive: boolean
      newContent?: unknown
      /** 只有显式带了 contentParts 键才动它(与今天的 `hasContentParts` 同义) */
      hasContentParts?: boolean
      contentParts?: unknown[] | null
      now?: number
    }
  | {
      type: 'deleteMessage'
      messageId?: string
      matchMarker?: (message: TMessage) => boolean
      now?: number
    }
  | {
      type: 'replaceAll'
      messages: TMessage[]
      reason: 'clear' | 'replaced' | 'normalize'
      now?: number
    }
  | { type: 'repairOnLoad'; policy: 'startup' | 'loaded'; now?: number }

// ============ 结果 ============

export interface SessionCommandRepairPatches<TMessage> {
  /** 逐条消息的改写(只列真的变了的) */
  messages: CoreSessionRepairMessagePatch<TMessage>[]
  /** 会话级字段的改写(contextSize / lastInputTokens 等) */
  session: Record<string, unknown>
  /** 会话级字段的删除(summary / summaryUpToMessageId / summaryCreatedAt) */
  sessionDeletes: string[]
}

export interface SessionCommandMeta<TMessage> {
  /** appendMessage / upsertMessage:落位后的消息 */
  message?: TMessage
  /** truncateFrom(inclusive:false):被改写的那条 */
  updatedMessage?: TMessage
  /** deleteMessage:被删的那条 */
  deletedMessage?: TMessage
  /** truncateFrom:被砍掉的那些 */
  deletedMessages?: TMessage[]
  /** truncateFrom:从会话总账里扣掉的 usage */
  subtractedUsage?: CoreSessionTokenUsage
  /** delete / truncate:命中的下标 */
  index?: number
  /** patchStepsUsageByTurn:实际被写了 usage 的 step id */
  updatedStepIds?: string[]
  /** repairOnLoad:这次修复应用了哪些 patch */
  repairPatches?: SessionCommandRepairPatches<TMessage>
  /** upsertMessage:是新增还是就地替换 */
  inserted?: boolean
}

export interface SessionCommandResult<TSession, TMessage> {
  /** 变了就是新 session 对象;没变就是入参本体 */
  session: TSession
  changed: boolean
  changedMessageIds: string[]
  writePlan: CoreSessionWritePlan
  /** true = 走 5s 的 lazy 落盘档 */
  lazy: boolean
  /** true = 调用方需要同步 sessions index 的 meta */
  indexMetaChanged: boolean
  meta?: SessionCommandMeta<TMessage>
}

// ============ 内部小工具 ============

type AnyRecord = Record<string, unknown>

function messagePlan(index: number): CoreSessionWritePlan {
  return index === -1 ? { kind: 'structural' } : { kind: 'message', dirtySeq: index + 1 }
}

function noChange<TSession, TMessage>(session: TSession): SessionCommandResult<TSession, TMessage> {
  return {
    session,
    changed: false,
    changedMessageIds: [],
    writePlan: CORE_STRUCTURAL_WRITE_PLAN,
    lazy: false,
    indexMetaChanged: false,
  }
}

/** COW:换掉 messages 数组(以及跟着变的会话级字段),session 本体也是新对象。 */
function withSession<TSession>(session: TSession, patch: AnyRecord, deletes: string[] = []): TSession {
  const next = { ...(session as AnyRecord), ...patch }
  for (const key of deletes) delete next[key]
  return next as TSession
}

function replaceAt<TMessage>(messages: TMessage[], index: number, message: TMessage): TMessage[] {
  const next = messages.slice()
  next[index] = message
  return next
}

function sumUsage<TMessage extends CoreSessionCommandMessage>(messages: TMessage[]): CoreSessionTokenUsage {
  return messages.reduce<CoreSessionTokenUsage>((usage, message) => {
    if (!message.usage) return usage
    usage.inputTokens += message.usage.inputTokens
    usage.outputTokens += message.usage.outputTokens
    usage.totalTokens += message.usage.totalTokens
    return usage
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
}

/**
 * 把命令结果**盖回原 session 容器**(会话对象身份不变)。
 *
 * 为什么不直接把 `result.session` 塞进 LRU:今天仍有调用点先 `getSession()` 拿到
 * 会话、之后再读它(`context-compact.ts` 是已知的一处),换掉对象它们就读到旧数据。
 * COW 的价值全在**消息**这一层 —— 消息对象与 messages 数组都是新的,容器复用不影响。
 * P0.2 调用点迁移完之后这个函数就可以退役,命令面直接返回新 session。
 */
export function adoptSessionCommandResult<TSession extends object, TMessage>(
  session: TSession,
  result: SessionCommandResult<TSession, TMessage>,
): boolean {
  if (!result.changed) return false
  const next = result.session as unknown as Record<string, unknown>
  const current = session as unknown as Record<string, unknown>
  if (next === current) return true
  for (const key of Object.keys(current)) {
    if (!(key in next)) delete current[key]
  }
  Object.assign(current, next)
  return true
}

// ============ 主 reducer ============

export function applySessionCommand<
  TSession extends CoreSessionCommandSession<TMessage>,
  TMessage extends CoreSessionCommandMessage,
>(session: TSession, command: SessionCommand<TMessage>): SessionCommandResult<TSession, TMessage> {
  switch (command.type) {
    case 'appendMessage':
      return applyAppend(session, command.message, command.now ?? Date.now())

    case 'upsertMessage': {
      const index = session.messages.findIndex(item => item.id === command.message.id)
      if (index === -1) {
        const result = applyAppend(session, command.message, command.now ?? Date.now())
        return { ...result, meta: { ...result.meta, inserted: true } }
      }
      const messages = replaceAt(session.messages, index, command.message)
      return {
        session: withSession(session, { messages, updatedAt: command.now ?? Date.now() }),
        changed: true,
        changedMessageIds: [command.message.id],
        writePlan: messagePlan(index),
        lazy: false,
        indexMetaChanged: false,
        meta: { message: command.message, index, inserted: false },
      }
    }

    case 'patchMessage': {
      const index = session.messages.findIndex(item => item.id === command.messageId)
      if (index === -1) return noChange(session)
      const next = { ...session.messages[index], ...command.patch } as TMessage
      return {
        session: withSession(session, { messages: replaceAt(session.messages, index, next) }),
        changed: true,
        changedMessageIds: [command.messageId],
        writePlan: messagePlan(index),
        lazy: resolveLazy(command.hint, command.patch),
        indexMetaChanged: false,
        meta: { message: next, index },
      }
    }

    case 'appendContentPart': {
      const index = session.messages.findIndex(item => item.id === command.messageId)
      if (index === -1) return noChange(session)
      const current = session.messages[index]
      const next = {
        ...current,
        contentParts: [...(current.contentParts ?? []), command.part],
      } as TMessage
      return {
        session: withSession(session, { messages: replaceAt(session.messages, index, next) }),
        changed: true,
        changedMessageIds: [command.messageId],
        writePlan: messagePlan(index),
        lazy: false,
        indexMetaChanged: false,
        meta: { message: next, index },
      }
    }

    case 'upsertStep': {
      const index = session.messages.findIndex(item => item.id === command.messageId)
      if (index === -1) return noChange(session)
      const current = session.messages[index]
      const steps = current.steps ?? []
      const existingIndex = steps.findIndex(existing =>
        Boolean(existing.toolCallId && existing.toolCallId === command.step.toolCallId),
      )
      const nextSteps = existingIndex >= 0
        ? replaceAt(steps, existingIndex, { ...steps[existingIndex], ...command.step })
        : [...steps, command.step]
      const next = { ...current, steps: nextSteps } as TMessage
      return {
        session: withSession(session, { messages: replaceAt(session.messages, index, next) }),
        changed: true,
        changedMessageIds: [command.messageId],
        writePlan: messagePlan(index),
        lazy: false,
        indexMetaChanged: false,
        meta: { message: next, index },
      }
    }

    case 'patchStep': {
      const index = session.messages.findIndex(item => item.id === command.messageId)
      if (index === -1) return noChange(session)
      const current = session.messages[index]
      const steps = current.steps
      if (!steps) return noChange(session)
      const stepIndex = steps.findIndex(step => step.id === command.stepId)
      if (stepIndex === -1) return noChange(session)
      const nextSteps = replaceAt(steps, stepIndex, { ...steps[stepIndex], ...command.updates })
      const next = { ...current, steps: nextSteps } as TMessage
      return {
        session: withSession(session, { messages: replaceAt(session.messages, index, next) }),
        changed: true,
        changedMessageIds: [command.messageId],
        writePlan: messagePlan(index),
        // step 存活期间的活跃计时/部分输出更新是高频的;完成态(status 变更)按边界立即调度。
        lazy: command.updates.status === undefined,
        indexMetaChanged: false,
        meta: { message: next, index },
      }
    }

    case 'patchStepsUsageByTurn': {
      const index = session.messages.findIndex(item => item.id === command.messageId)
      if (index === -1) return noChange(session)
      const current = session.messages[index]
      if (!current.steps) return { ...noChange<TSession, TMessage>(session), meta: { updatedStepIds: [] } }
      const updatedStepIds: string[] = []
      const nextSteps = current.steps.map(step => {
        if (step.turnIndex !== command.turnIndex) return step
        updatedStepIds.push(step.id)
        return { ...step, usage: command.usage }
      })
      if (updatedStepIds.length === 0) {
        return { ...noChange<TSession, TMessage>(session), meta: { updatedStepIds } }
      }
      const next = { ...current, steps: nextSteps } as TMessage
      return {
        session: withSession(session, { messages: replaceAt(session.messages, index, next) }),
        changed: true,
        changedMessageIds: [command.messageId],
        writePlan: messagePlan(index),
        lazy: false,
        indexMetaChanged: false,
        meta: { message: next, index, updatedStepIds },
      }
    }

    case 'setToolCalls': {
      const index = session.messages.findIndex(item => item.id === command.messageId)
      if (index === -1) return noChange(session)
      const next = { ...session.messages[index], toolCalls: command.toolCalls } as TMessage
      return {
        session: withSession(session, { messages: replaceAt(session.messages, index, next) }),
        changed: true,
        changedMessageIds: [command.messageId],
        writePlan: messagePlan(index),
        lazy: false,
        indexMetaChanged: false,
        meta: { message: next, index },
      }
    }

    case 'truncateFrom':
      return applyTruncate(session, command)

    case 'deleteMessage': {
      const index = command.messageId !== undefined
        ? session.messages.findIndex(item => item.id === command.messageId)
        : command.matchMarker
          ? session.messages.findIndex(item => command.matchMarker!(item))
          : -1
      if (index === -1) return noChange(session)
      const deletedMessage = session.messages[index]
      const messages = session.messages.slice(0, index).concat(session.messages.slice(index + 1))
      return {
        session: withSession(session, { messages, updatedAt: command.now ?? Date.now() }),
        changed: true,
        changedMessageIds: [deletedMessage.id],
        writePlan: CORE_STRUCTURAL_WRITE_PLAN,
        lazy: false,
        // E4:老的 applySessionDeleteMessageWithAdapters 忘了盖 index meta,
        // 会话列表因此显示过期的 updatedAt。命令面补上。
        indexMetaChanged: true,
        meta: { index, deletedMessage },
      }
    }

    case 'replaceAll': {
      return {
        session: withSession(session, {
          messages: command.messages,
          updatedAt: command.now ?? Date.now(),
        }),
        changed: true,
        changedMessageIds: command.messages.map(message => message.id),
        writePlan: CORE_STRUCTURAL_WRITE_PLAN,
        lazy: false,
        indexMetaChanged: true,
      }
    }

    case 'repairOnLoad':
      return applyRepairOnLoad(session, command.policy, command.now ?? Date.now())
  }
}

function resolveLazy(hint: SessionCommandWriteHint | undefined, patch: AnyRecord): boolean {
  if (hint === 'stream') return true
  if (hint === 'settle') return false
  const keys = Object.keys(patch)
  return keys.length > 0 && keys.every(key => LEGACY_LAZY_PATCH_KEYS.has(key))
}

function applyAppend<
  TSession extends CoreSessionCommandSession<TMessage>,
  TMessage extends CoreSessionCommandMessage,
>(session: TSession, message: TMessage, now: number): SessionCommandResult<TSession, TMessage> {
  const messages = [...session.messages, message]
  const patch: AnyRecord = { messages, updatedAt: now }
  if (message.role === 'assistant') {
    if (message.provider) patch.lastProvider = message.provider
    if (message.model) patch.lastModel = message.model
  }
  return {
    session: withSession(session, patch),
    changed: true,
    changedMessageIds: [message.id],
    // 追加 = 从新消息的 seq 起做后缀写
    writePlan: { kind: 'message', dirtySeq: messages.length },
    lazy: false,
    indexMetaChanged: true,
    meta: { message, index: messages.length - 1 },
  }
}

function applyTruncate<
  TSession extends CoreSessionCommandSession<TMessage>,
  TMessage extends CoreSessionCommandMessage,
>(
  session: TSession,
  command: Extract<SessionCommand<TMessage>, { type: 'truncateFrom' }>,
): SessionCommandResult<TSession, TMessage> {
  const index = session.messages.findIndex(item => item.id === command.messageId)
  if (index === -1) return noChange(session)

  const now = command.now ?? Date.now()
  const keepIndex = command.inclusive ? index : index + 1
  const deletedMessages = session.messages.slice(keepIndex)
  const subtractedUsage = sumUsage(deletedMessages)

  const kept = session.messages.slice(0, keepIndex)
  let updatedMessage: TMessage | undefined
  let messages = kept
  if (!command.inclusive) {
    const target = { ...session.messages[index] } as AnyRecord
    target.content = command.newContent
    if (command.hasContentParts) {
      if (command.contentParts && command.contentParts.length > 0) {
        target.contentParts = command.contentParts
      } else {
        delete target.contentParts
      }
    }
    target.timestamp = now
    updatedMessage = target as TMessage
    messages = replaceAt(kept, index, updatedMessage)
  }

  const patch: AnyRecord = { messages, updatedAt: now }
  if (subtractedUsage.totalTokens > 0) {
    patch.totalInputTokens = Math.max(0, (session.totalInputTokens || 0) - subtractedUsage.inputTokens)
    patch.totalOutputTokens = Math.max(0, (session.totalOutputTokens || 0) - subtractedUsage.outputTokens)
    patch.totalTokens = Math.max(0, (session.totalTokens || 0) - subtractedUsage.totalTokens)
  }

  const repair = computeSessionTimelineMetadataRepair(
    {
      id: session.id,
      summary: session.summary,
      summaryUpToMessageId: session.summaryUpToMessageId,
      summaryCreatedAt: session.summaryCreatedAt,
      contextSize: session.contextSize,
      lastInputTokens: session.lastInputTokens,
    },
    messages,
    { recomputeContextSize: true },
  )
  Object.assign(patch, repair.patch)

  return {
    session: withSession(session, patch, repair.deletes),
    changed: true,
    changedMessageIds: updatedMessage ? [updatedMessage.id] : [],
    // 截断语义:后缀写只会往后追,砍掉不在它的语义里
    writePlan: CORE_STRUCTURAL_WRITE_PLAN,
    lazy: false,
    indexMetaChanged: true,
    meta: { index, deletedMessages, subtractedUsage, updatedMessage },
  }
}

function applyRepairOnLoad<
  TSession extends CoreSessionCommandSession<TMessage>,
  TMessage extends CoreSessionCommandMessage,
>(session: TSession, policy: 'startup' | 'loaded', now: number): SessionCommandResult<TSession, TMessage> {
  const repair = computeSessionRepairOnLoad<TMessage>(session, session.messages, policy, now)
  const repairPatches: SessionCommandRepairPatches<TMessage> = {
    messages: repair.messagePatches,
    session: repair.sessionPatch,
    sessionDeletes: repair.sessionDeletes,
  }

  if (!repair.changed) {
    return { ...noChange<TSession, TMessage>(session), meta: { repairPatches } }
  }

  const patch: AnyRecord = { ...repair.sessionPatch }
  if (repair.messagesChanged) patch.messages = repair.messages

  return {
    session: withSession(session, patch, repair.sessionDeletes),
    changed: true,
    changedMessageIds: repair.messagePatches.map(entry => entry.messageId),
    writePlan: CORE_STRUCTURAL_WRITE_PLAN,
    lazy: false,
    indexMetaChanged: false,
    meta: { repairPatches },
  }
}

// ============ 冷加载 / 启动期修复(COW 入口) ============

/**
 * `repairOnLoad` 命令的两个具名入口 —— 旧的就地版 `sanitizeLoadedSession` /
 * `sanitizeSessionOnStartup` 的替身(P0.2 area ①,F4)。
 *
 * 语义一字不改(`'loaded'` = 只清 isStreaming + 元数据;`'startup'` = 再加中断的
 * step / toolCall / 卡死的 compact 消息),**但不再改入参**:变了就返回一个新的
 * 会话对象(消息数组与被改的那几条消息都是新的),没变返回 `undefined`。
 */
function runRepairOnLoad<
  TSession extends CoreSessionCommandSession<TMessage>,
  TMessage extends CoreSessionCommandMessage,
>(session: TSession, policy: 'startup' | 'loaded'): TSession | undefined {
  const result = applySessionCommand<TSession, TMessage>(session, { type: 'repairOnLoad', policy })
  return result.changed ? result.session : undefined
}

export function sanitizeLoadedSession<
  TSession extends CoreSessionCommandSession<TMessage>,
  TMessage extends CoreSessionCommandMessage = CoreSessionCommandMessage,
>(session: TSession): TSession | undefined {
  return runRepairOnLoad<TSession, TMessage>(session, 'loaded')
}

export function sanitizeSessionOnStartup<
  TSession extends CoreSessionCommandSession<TMessage>,
  TMessage extends CoreSessionCommandMessage = CoreSessionCommandMessage,
>(session: TSession): TSession | undefined {
  return runRepairOnLoad<TSession, TMessage>(session, 'startup')
}

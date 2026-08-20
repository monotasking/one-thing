import { getCoreLogger } from '../logging/index.js'
import {
  CORE_INTERRUPTED_PERMISSION_ERROR,
  CORE_INTERRUPTED_TOOL_ERROR,
  CORE_INTERRUPTED_TOOL_STATUS,
} from './interrupted.js'

const log = getCoreLogger('core.session')

export interface CoreTokenUsage {
  inputTokens: number
  outputTokens?: number
  totalTokens?: number
}

export interface CoreToolCallState {
  status?: string
  /** Set while a tool call is paused awaiting a permission response. */
  requiresConfirmation?: boolean
  error?: string
}

export interface CoreTimelineStep {
  status?: string
  error?: string
  title: string
  usage?: unknown
  turnIndex?: number
  timestamp?: number
  toolCall?: CoreToolCallState
  childSteps?: CoreTimelineStep[]
}

export interface CoreTimelineMessage {
  id: string
  role: string
  content?: string
  timestamp?: number
  isStreaming?: boolean
  usage?: CoreTokenUsage
  steps?: CoreTimelineStep[]
  toolCalls?: CoreToolCallState[]
}

export interface CoreTimelineSession<TMessage extends CoreTimelineMessage = CoreTimelineMessage> {
  id?: string
  messages: TMessage[]
  summary?: string
  summaryUpToMessageId?: string
  summaryCreatedAt?: number
  contextSize?: number
  lastInputTokens?: number
}

export interface TimelineMetadataRepairOptions {
  recomputeContextSize?: boolean
}

const STALE_CONTEXT_COMPACT_MS = 10 * 60 * 1000

export function isTokenUsage(value: unknown): value is CoreTokenUsage {
  if (!value || typeof value !== 'object') return false
  const usage = value as Partial<CoreTokenUsage>
  return Number.isFinite(usage.inputTokens) && usage.inputTokens! >= 0
}

export function getLatestStepUsage(message: CoreTimelineMessage): CoreTokenUsage | undefined {
  let latest:
    | {
        turnIndex: number
        timestamp: number
        usage: CoreTokenUsage
      }
    | undefined

  const visit = (steps: CoreTimelineStep[] | undefined): void => {
    if (!steps) return
    for (const step of steps) {
      if (isTokenUsage(step.usage)) {
        const candidate = {
          turnIndex: step.turnIndex ?? -1,
          timestamp: step.timestamp ?? 0,
          usage: step.usage,
        }
        if (
          !latest ||
          candidate.turnIndex > latest.turnIndex ||
          (candidate.turnIndex === latest.turnIndex && candidate.timestamp >= latest.timestamp)
        ) {
          latest = candidate
        }
      }

      if (Array.isArray(step.childSteps)) {
        visit(step.childSteps)
      }
    }
  }

  visit(message.steps)
  return latest?.usage
}

function hasToolActivity(message: CoreTimelineMessage): boolean {
  return Boolean(
    (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) ||
    (Array.isArray(message.steps) && message.steps.length > 0),
  )
}

/**
 * 消息数组是**显式入参**(不从 session 上取)—— 命令面之外谁都不许持有
 * `session.messages`,纯算法拿到的永远是调用方递进来的那份快照。
 */
function findLatestRetainedAssistant<TMessage extends CoreTimelineMessage>(
  messages: readonly TMessage[],
  summary: Pick<CoreTimelineSession, 'summary' | 'summaryUpToMessageId'>,
): TMessage | undefined {
  const summaryIndex = summary.summary && summary.summaryUpToMessageId
    ? messages.findIndex(message => message.id === summary.summaryUpToMessageId)
    : -1
  const startIndex = summaryIndex >= 0 ? summaryIndex + 1 : 0

  for (let index = messages.length - 1; index >= startIndex; index--) {
    const message = messages[index]
    if (message.role === 'assistant' && !message.isStreaming) return message
  }

  return undefined
}

function hasAccumulatedToolUsageContext<TMessage extends CoreTimelineMessage>(
  messages: readonly TMessage[],
  session: Pick<CoreTimelineSession, 'summary' | 'summaryUpToMessageId' | 'contextSize' | 'lastInputTokens'>,
): boolean {
  const latestAssistant = findLatestRetainedAssistant(messages, session)
  if (!latestAssistant || !isTokenUsage(latestAssistant.usage)) return false
  if (!hasToolActivity(latestAssistant)) return false
  if (getLatestStepUsage(latestAssistant)) return false

  const inputTokens = Math.max(0, latestAssistant.usage.inputTokens)
  return (session.contextSize ?? 0) === inputTokens || (session.lastInputTokens ?? 0) === inputTokens
}

export function deriveRetainedContextSize<TMessage extends CoreTimelineMessage>(
  messages: readonly TMessage[],
  session: Pick<CoreTimelineSession, 'summary' | 'summaryUpToMessageId'>,
): number {
  const message = findLatestRetainedAssistant(messages, session)
  if (!message) return 0

  const stepUsage = getLatestStepUsage(message)
  if (isTokenUsage(stepUsage)) {
    return Math.max(0, stepUsage.inputTokens)
  }

  if (isTokenUsage(message.usage)) {
    if (hasToolActivity(message)) return 0
    return Math.max(0, message.usage.inputTokens)
  }

  return 0
}

export interface CoreTimelineMetadataRepair {
  modified: boolean
  /** 要盖到会话上的字段 */
  patch: Record<string, unknown>
  /** 要从会话上删掉的字段 */
  deletes: string[]
}

/**
 * `repairSessionTimelineMetadata` 的**纯计算版**:只算该改什么,不改任何东西。
 *
 * 会话命令面(`session/commands.ts`)的 `truncateFrom` / `repairOnLoad` 走它,
 * 下面那个就地改的同名函数也走它 —— 两条路一份算法,不会再分叉。
 * 只动会话级字段(summary 三件套 / contextSize / lastInputTokens),不动消息。
 *
 * 日志留在这里:那几行是线上排障用的,搬走等于删。
 */
export function computeSessionTimelineMetadataRepair<TMessage extends CoreTimelineMessage>(
  session: Pick<
    CoreTimelineSession,
    'id' | 'summary' | 'summaryUpToMessageId' | 'summaryCreatedAt' | 'contextSize' | 'lastInputTokens'
  >,
  messages: TMessage[],
  options: TimelineMetadataRepairOptions = {},
): CoreTimelineMetadataRepair {
  const patch: Record<string, unknown> = {}
  const deletes: string[] = []
  let modified = false
  let clearedSummary = false

  const messageIds = new Set(messages.map(message => message.id))
  const hasSummary = typeof session.summary === 'string' && session.summary.length > 0
  const hasSummaryAnchor = typeof session.summaryUpToMessageId === 'string' && session.summaryUpToMessageId.length > 0
  const hasAnySummaryMetadata = hasSummary || hasSummaryAnchor || session.summaryCreatedAt !== undefined
  const summaryAnchorExists = hasSummaryAnchor ? messageIds.has(session.summaryUpToMessageId!) : false

  if (hasAnySummaryMetadata && (!hasSummary || !hasSummaryAnchor || !summaryAnchorExists)) {
    log.warn('cleared invalid summary metadata after timeline repair', {
      sessionId: session.id,
      summaryUpToMessageId: session.summaryUpToMessageId,
    })
    deletes.push('summary', 'summaryUpToMessageId', 'summaryCreatedAt')
    clearedSummary = true
    modified = true
  }

  const nextSummary = clearedSummary ? undefined : session.summary
  const nextSummaryAnchor = clearedSummary ? undefined : session.summaryUpToMessageId
  const repaired = {
    summary: nextSummary,
    summaryUpToMessageId: nextSummaryAnchor,
    contextSize: session.contextSize,
    lastInputTokens: session.lastInputTokens,
  }

  const repairAccumulatedToolUsageContext = hasAccumulatedToolUsageContext(messages, repaired)
  if (options.recomputeContextSize || clearedSummary || repairAccumulatedToolUsageContext) {
    const contextSize = deriveRetainedContextSize(messages, repaired)
    const beforeContextSize = session.contextSize ?? 0
    const beforeLastInputTokens = session.lastInputTokens ?? 0
    if (beforeContextSize !== contextSize || beforeLastInputTokens !== contextSize) {
      patch.contextSize = contextSize
      patch.lastInputTokens = contextSize
      log.debug('timeline metadata repaired context size', {
        sessionId: session.id,
        source: options.recomputeContextSize
          ? 'timeline-recompute'
          : repairAccumulatedToolUsageContext
            ? 'accumulated-tool-usage-repair'
            : 'summary-metadata-repair',
        summaryUpToMessageId: nextSummaryAnchor,
        beforeContextSize,
        beforeLastInputTokens,
        afterContextSize: contextSize,
        afterLastInputTokens: contextSize,
      })
      modified = true
    }
  }

  return { modified, patch, deletes }
}

/**
 * 把一次元数据修复**盖到一个新的会话对象**上(COW)。入参 session 不动。
 * 没有要改的东西时返回 `undefined` —— 调用方据此决定要不要落盘。
 */
export function applyTimelineRepair<TSession extends object>(
  session: TSession,
  repair: CoreTimelineMetadataRepair,
): TSession | undefined {
  if (!repair.modified) return undefined
  const next = { ...(session as Record<string, unknown>), ...repair.patch }
  for (const key of repair.deletes) delete next[key]
  return next as TSession
}

/**
 * COW 版:算 + 盖到新对象。消息数组是显式入参(P0.2 area ①,F4)。
 * 返回 `undefined` = 什么都没改,调用方不用落盘。
 */
export function repairSessionTimelineMetadata<
  TSession extends object,
  TMessage extends CoreTimelineMessage,
>(
  session: TSession & Pick<
    CoreTimelineSession,
    'id' | 'summary' | 'summaryUpToMessageId' | 'summaryCreatedAt' | 'contextSize' | 'lastInputTokens'
  >,
  messages: TMessage[],
  options: TimelineMetadataRepairOptions = {},
): TSession | undefined {
  return applyTimelineRepair(session, computeSessionTimelineMetadataRepair(session, messages, options))
}

export interface CoreSessionRepairMessagePatch<TMessage> {
  messageId: string
  /** 该消息修复后的完整新对象(COW 产物) */
  message: TMessage
}

export interface CoreSessionRepairResult<TMessage extends CoreTimelineMessage> {
  changed: boolean
  messagesChanged: boolean
  /** 修复后的消息数组;没有任何消息变动时与入参同一引用 */
  messages: TMessage[]
  messagePatches: CoreSessionRepairMessagePatch<TMessage>[]
  sessionPatch: Record<string, unknown>
  sessionDeletes: string[]
}

const INTERRUPTED_TOOL_CALL_STATUSES = new Set([
  'executing',
  'pending',
  'received',
  'queued',
  'input-streaming',
])

/**
 * 纯计算:返回修好的新 toolCall;undefined = 这个不用动。
 *
 * R-a(§13.6):口径以 `prepare` 为准 —— `cancelled` + `CORE_INTERRUPTED_TOOL_ERROR`。
 * 从前这里只改状态、不写 error,而账本侧合成的那条结局是带话的,于是投影上有
 * `error` 而消息上没有(四格打架里的一格)。
 */
export function computeInterruptedToolCallRepair<TToolCall extends CoreToolCallState>(
  toolCall: TToolCall,
): TToolCall | undefined {
  const interrupted = Boolean(toolCall.status && INTERRUPTED_TOOL_CALL_STATUSES.has(toolCall.status))
  // The permission ask lives only in the dead process's memory — a stale
  // flag here would render an approval card no click can ever satisfy.
  const stalePermission = Boolean(toolCall.requiresConfirmation)
  if (!interrupted && !stalePermission) return undefined
  return {
    ...toolCall,
    ...(interrupted ? { status: CORE_INTERRUPTED_TOOL_STATUS } : {}),
    ...(stalePermission
      ? {
          requiresConfirmation: false,
          error: toolCall.error || CORE_INTERRUPTED_PERMISSION_ERROR,
        }
      : { error: toolCall.error || CORE_INTERRUPTED_TOOL_ERROR }),
  }
}

/**
 * 纯计算:返回修好的新 step(含 childSteps 递归);undefined = 这个不用动。
 *
 * R-a(§13.6)改了三格,理由见 `interrupted.ts`:
 *  - `failed` → `cancelled`(它没有失败,是没跑完);
 *  - `Interrupted: app was closed` → `CORE_INTERRUPTED_TOOL_ERROR`(与 prepare 合成的
 *    那条结局逐字相同);
 *  - **标题不再改写**。那次改写在事件账本里没有任何来源 —— 投影重建不出来,
 *    于是每一条崩溃修复过的消息都必然与投影不等。占位标题原样留着。
 */
export function computeInterruptedStepRepair<TStep extends CoreTimelineStep>(
  step: TStep,
): TStep | undefined {
  const patch: Record<string, unknown> = {}
  let changed = false

  if (step.status === 'running' || step.status === 'pending') {
    patch.status = CORE_INTERRUPTED_TOOL_STATUS
    patch.error = step.error || CORE_INTERRUPTED_TOOL_ERROR
    changed = true
  }
  if (step.status === 'awaiting-confirmation') {
    patch.status = CORE_INTERRUPTED_TOOL_STATUS
    patch.error = step.error || CORE_INTERRUPTED_PERMISSION_ERROR
    changed = true
  }
  if (step.toolCall) {
    const repaired = computeInterruptedToolCallRepair(step.toolCall)
    if (repaired) {
      patch.toolCall = repaired
      changed = true
    }
  }
  if (step.childSteps?.length) {
    let childChanged = false
    const nextChildren = step.childSteps.map(child => {
      const repaired = computeInterruptedStepRepair(child)
      if (repaired) childChanged = true
      return repaired ?? child
    })
    if (childChanged) {
      patch.childSteps = nextChildren
      changed = true
    }
  }

  return changed ? ({ ...step, ...patch } as TStep) : undefined
}

/**
 * @deprecated 用 `computeInterruptedStepRepair`。COW 之后这个别名只是同一个函数
 * 的旧名字(返回新 step,不再就地改)。
 */
export const sanitizeInterruptedStepRecursive = computeInterruptedStepRepair

/** 纯计算:卡在 compacting 的系统消息在超时后改判 failed;undefined = 不用动。 */
export function computeStaleContextCompactContent(
  content: unknown,
  timestamp: number | undefined,
  now: number,
): string | undefined {
  if (typeof content !== 'string') return undefined
  if (!content.includes('"context-compact"') || !content.includes('"compacting"')) return undefined
  const stamp = typeof timestamp === 'number' ? timestamp : 0
  if (stamp > 0 && now - stamp < STALE_CONTEXT_COMPACT_MS) return undefined

  try {
    const parsed = JSON.parse(content) as {
      type?: string
      status?: string
      summary?: string
      compactedMessageCount?: number
      error?: string
    }
    if (parsed.type !== 'context-compact' || parsed.status !== 'compacting') return undefined
    return JSON.stringify({
      type: 'context-compact',
      status: 'failed',
      summary: parsed.summary ?? '',
      error: 'Context compact was interrupted before completion.',
      compactedMessageCount: parsed.compactedMessageCount ?? 0,
    })
  } catch {
    return undefined
  }
}

function computeMessageRepair<TMessage extends CoreTimelineMessage>(
  message: TMessage,
  policy: 'startup' | 'loaded',
  now: number,
): TMessage | undefined {
  const patch: Record<string, unknown> = {}
  let changed = false

  if (message.isStreaming) {
    patch.isStreaming = false
    changed = true
  }

  if (policy === 'startup') {
    if (message.steps) {
      let stepsChanged = false
      const nextSteps = message.steps.map(step => {
        const repaired = computeInterruptedStepRepair(step)
        if (repaired) stepsChanged = true
        return repaired ?? step
      })
      if (stepsChanged) {
        patch.steps = nextSteps
        changed = true
      }
    }

    if (message.toolCalls) {
      let toolCallsChanged = false
      const nextToolCalls = message.toolCalls.map(toolCall => {
        const repaired = computeInterruptedToolCallRepair(toolCall)
        if (repaired) toolCallsChanged = true
        return repaired ?? toolCall
      })
      if (toolCallsChanged) {
        patch.toolCalls = nextToolCalls
        changed = true
      }
    }

    if (message.role === 'system') {
      const nextContent = computeStaleContextCompactContent(message.content, message.timestamp, now)
      if (nextContent !== undefined) {
        patch.content = nextContent
        changed = true
      }
    }
  }

  return changed ? ({ ...message, ...patch } as TMessage) : undefined
}

/**
 * 冷加载/启动期修复的**纯计算版** —— `repairOnLoad` 命令的算法本体。
 *
 * `policy:'loaded'` = 只清 isStreaming + 元数据修复(旧 `sanitizeLoadedSession`);
 * `policy:'startup'` = 再加上中断的 step / toolCall / 卡死的 compact 消息
 * (旧 `sanitizeSessionOnStartup`)。
 */
export function computeSessionRepairOnLoad<TMessage extends CoreTimelineMessage>(
  session: Pick<
    CoreTimelineSession,
    'id' | 'summary' | 'summaryUpToMessageId' | 'summaryCreatedAt' | 'contextSize' | 'lastInputTokens'
  >,
  currentMessages: TMessage[],
  policy: 'startup' | 'loaded',
  now: number = Date.now(),
): CoreSessionRepairResult<TMessage> {
  const messagePatches: CoreSessionRepairMessagePatch<TMessage>[] = []
  let messagesChanged = false
  const mapped = currentMessages.map(message => {
    const repaired = computeMessageRepair(message, policy, now)
    if (!repaired) return message
    messagesChanged = true
    messagePatches.push({ messageId: message.id, message: repaired })
    return repaired
  })
  const messages = messagesChanged ? mapped : currentMessages

  const repair = computeSessionTimelineMetadataRepair(session, messages)

  return {
    changed: messagesChanged || repair.modified,
    messagesChanged,
    messages,
    messagePatches,
    sessionPatch: repair.patch,
    sessionDeletes: repair.deletes,
  }
}



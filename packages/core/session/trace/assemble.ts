/**
 * 会话轨迹的装配器(S3 只读查询面,§12 —— 设计见
 * `docs/design/logging-system-2026-08.md` §2.7.5)。
 *
 * **纯函数**:进来一串事件,出去一棵树。没有 fs、没有时钟、没有随机数 ——
 * 同一份 `events.jsonl` 在 CLI、HTTP、轨迹面板上装配出的树逐字节相同,因为
 * 三个出口调的是这一个函数。
 *
 * ## 树的形状
 *
 * ```
 * Session
 * └─ Run(runId, kind, agentId, 触发消息预览, provider/model, outcome, t0..t1)
 *    └─ Request #k(requestIndex, header 指纹, t_start/首 token/t_end,
 *       │            usage, finishReason, error/retry, response parts 指纹)
 *       └─ ToolCall(callId, name, argumentsRaw, result 预览/引用,
 *                   audit effects/decision/asked/outcome, 权限答复, t_call/t_result)
 * ```
 *
 * ## 四条纪律(与事件账本本身同源)
 *
 * 1. **只记时刻,时长现算**。树上一个 `durationMs` 都没有 —— 呈现层拿两个
 *    时刻相减。存下来的时长会和时刻打架,而打架的那一天没人知道信哪个。
 * 2. **正文不进树**。响应正文的唯一来源是 `assistant/chunks` 的 fold,按需
 *    materialize(`materializeTraceResponseText`),树上只有各 part 的
 *    `{kind, len, hash}`。一棵带正文的树在 CLI 上会把终端刷爆,在 HTTP 上会
 *    把一次列表请求变成几 MB。
 * 3. **没有账就是没有账**。拿不到的格子一律缺席(`undefined`),绝不用 0 /
 *    空串冒充"量到了但是零"。
 * 4. **老文件不编 runId**。只有七类事件的会话没有 `run/start`,这时按
 *    `request/start.messageId`(那正是助手那条消息的 id —— 一次执行的天然身份)
 *    合成分组,`synthetic: true` 如实标出,`runId` 留空。**不发明 runId**。
 */

import type {
  BlobRef,
  SessionAssistantPartKind,
  SessionLogEventRecord,
  SessionRequestEndUsage,
  SessionResponseUsage,
  SessionRunKind,
} from '../events/types.js'
import {
  createSessionProjectionState,
  reduceSessionProjection,
  type SessionProjectionState,
} from '../projection/reducer.js'

// ============ 树 ============

/** 一次工具调用:调用 + 结果 + 审计 + 权限答复,合成一格。 */
export interface SessionTraceToolCall {
  callId: string
  name: string
  /** 模型给的原始 arguments 串 —— 原样,包括它写坏的那次。 */
  argumentsRaw: string
  callSeq: number
  callTime: number
  /** G3:父调用。有它说明这次调用发生在另一次调用**内部**。 */
  parentCallId?: string
  resultSeq?: number
  resultTime?: number
  /** 给模型看的那段正文的预览(事件里存的就是预览,不是全文)。 */
  resultPreview?: string
  /** 结果走了 blob:树上只有引用。 */
  resultRef?: BlobRef
  isError?: boolean
  audit?: SessionTraceToolAudit
  permission?: SessionTracePermission
}

export interface SessionTraceToolAudit {
  toolId: string
  effects: string[]
  effectCount: number
  outcome: 'ok' | 'invalid' | 'denied' | 'aborted' | 'failed'
  decision?: 'allow' | 'deny'
  asked?: boolean
  previewTitle?: string
  intercepted?: { action: 'rewrite' | 'block'; by?: string[] }
  time: number
}

export interface SessionTracePermission {
  requestId: string
  askedTime?: number
  answeredTime?: number
  approved?: boolean
  scope?: string
  /** 拒绝理由 —— 模型看到的那句话。 */
  reason?: string
}

/** 响应各 part 的**指纹**。正文不在这里(纪律 2)。 */
export interface SessionTraceResponsePart {
  partIndex: number
  kind: SessionAssistantPartKind
  len: number
  hash?: string
  toolCallId?: string
}

export interface SessionTraceRequestError {
  seq: number
  time: number
  name?: string
  message: string
  status?: number
  willRetry: boolean
  attempt: number
}

export interface SessionTraceRequest {
  requestIndex: number
  /** `request/start` 的 seq —— 与轨迹面板的组 key 对齐的**连接键**。 */
  startSeq?: number
  provider?: string
  model?: string
  systemPromptHash?: string
  toolsHash?: string
  /** 当时目录里的工具数。拿不到就缺席(与面板的 `unavailable` 同一条纪律)。 */
  toolCount?: number
  /** `request/recipe` 里那次请求发出去的历史条数。 */
  recipeMessageCount?: number
  params?: Record<string, unknown>
  startTime?: number
  firstTokenTime?: number
  endTime?: number
  usage?: SessionResponseUsage | SessionRequestEndUsage
  finishReason?: string
  stopReason?: string
  responseModel?: string
  providerResponseId?: string
  parts: SessionTraceResponsePart[]
  errors: SessionTraceRequestError[]
  toolCalls: SessionTraceToolCall[]
}

export interface SessionTraceRun {
  /**
   * 这一组的**地址**。真 run 就是 runId;老文件的合成组是
   * `legacy:<assistantMessageId>` —— CLI 的 `--run` 与 HTTP 的 `?run=` 认它。
   */
  key: string
  /** 老文件没有 runId,这里留空串 —— **不发明**(纪律 4)。 */
  runId: string
  synthetic: boolean
  kind?: SessionRunKind
  agentId?: string
  assistantMessageId?: string
  provider?: string
  model?: string
  /** G5:这次执行激活的技能。 */
  skillUsed?: string
  trigger?: {
    messageId?: string
    eventSeq?: number
    /** 触发这次执行的那条用户消息的开头。截断的,不是全文。 */
    preview?: string
  }
  outcome?: 'completed' | 'aborted' | 'error' | 'interrupted'
  error?: { name?: string; message: string }
  /** run 的第一条事件的 seq —— 排序键,也是"这一组从哪开始"。 */
  firstSeq: number
  startTime?: number
  endTime?: number
  requests: SessionTraceRequest[]
}

/** 压缩:发生在 run 之外,所以它是会话级的一行,不挂在任何一棵 run 上。 */
export interface SessionTraceCompaction {
  seq: number
  time: number
  messageId: string
  compactedMessageCount: number
  status: 'completed' | 'failed'
  model?: string
  provider?: string
  error?: string
}

export interface SessionTrace {
  sessionId?: string
  /** 日志里有 `run/start` 吗。false = 老文件,下面的 run 全是合成的。 */
  hasRunEvents: boolean
  eventCount: number
  createdAt?: number
  sessionKind?: string
  agentId?: string
  /** 会话里**一共**有多少组(过滤之前)。`runs.length` 是过滤之后的。 */
  totalRuns: number
  runs: SessionTraceRun[]
  compactions: SessionTraceCompaction[]
}

export interface AssembleSessionTraceOptions {
  sessionId?: string
  /** 只要这一组(`SessionTraceRun.key`,真 runId 也认)。 */
  run?: string
  /** 只要最后 N 组。与 `run` 同时给时 `run` 优先。 */
  last?: number
  /** 触发消息预览的长度上限。 */
  previewLimit?: number
}

const DEFAULT_PREVIEW_LIMIT = 120

// ============ 装配 ============

interface MutableRun extends Omit<SessionTraceRun, 'requests'> {
  requests: Map<number, SessionTraceRequest>
  requestOrder: number[]
  /** 当前开着的 requestIndex —— 工具调用挂到它上面。 */
  openRequestIndex?: number
  callsById: Map<string, SessionTraceToolCall[]>
  callBySeq: Map<number, SessionTraceToolCall>
}

/**
 * 事件 → 轨迹树。
 *
 * 分组的判据只有三档,**按可靠性排**:
 *  1. `data.runId`(v2:执行入口生成,贯穿整条链);
 *  2. `data.messageId` —— 助手那条消息的 id 就是一次执行的身份。先查
 *     `run/start` 建的那张 `assistantMessageId → runId` 表(**采集点并不齐**:
 *     真机上 `tool/audit` 就没有 runId,只有 messageId;不查表就会为它凭空开一个
 *     空的第二组);查不到才落进 `legacy:<mid>`;
 *  3. "当时开着的那一组"(`request/header` / `request/end` 这类两样都没有的事件)。
 *
 * 二档里的两条路不混:同一个会话里既有老事件又有新事件时(迁移当天那条会话),
 * 老的那批 messageId 不在表里,于是落进自己的 `legacy:<mid>` —— 把它们缝进某个
 * run 要靠猜,而猜出来的树看上去和真的一模一样。
 */
export function assembleSessionTrace(
  events: readonly SessionLogEventRecord[],
  options: AssembleSessionTraceOptions = {},
): SessionTrace {
  const previewLimit = options.previewLimit ?? DEFAULT_PREVIEW_LIMIT
  const ordered = [...events].sort((a, b) => a.seq - b.seq)

  // 预扫一遍 `run/start`:助手消息 id → runId。第二档判据要它(见函数头)。
  const runIdByAssistantMessageId = new Map<string, string>()
  for (const event of ordered) {
    if (event.type !== 'run/start') continue
    if (event.data.assistantMessageId) {
      runIdByAssistantMessageId.set(event.data.assistantMessageId, event.data.runId)
    }
  }

  const previewByMessageId = new Map<string, string>()
  const previewBySeq = new Map<number, string>()
  const runs = new Map<string, MutableRun>()
  const compactions: SessionTraceCompaction[] = []
  const permissionCallByRequestId = new Map<string, { runKey: string; callId: string }>()
  /** 权限事件常常**早于** `tool/call` 落账,先攒着,调用一到就取走。 */
  const pendingPermissions = new Map<string, SessionTracePermission>()

  let hasRunEvents = false
  let createdAt: number | undefined
  let sessionKind: string | undefined
  let sessionAgentId: string | undefined
  let currentKey: string | undefined
  let lastHeader: {
    provider: string
    model: string
    systemPromptHash: string
    toolsHash: string
  } | undefined
  let lastToolCount: number | undefined

  const ensureRun = (key: string, seq: number, synthetic: boolean): MutableRun => {
    let run = runs.get(key)
    if (!run) {
      run = {
        key,
        runId: synthetic ? '' : key,
        synthetic,
        firstSeq: seq,
        requests: new Map(),
        requestOrder: [],
        callsById: new Map(),
        callBySeq: new Map(),
      }
      runs.set(key, run)
    }
    currentKey = key
    return run
  }

  /** 事件 → 它所属的那一组(三档判据,见函数头)。 */
  const runOf = (event: SessionLogEventRecord): MutableRun | undefined => {
    const data = event.data as { runId?: unknown; messageId?: unknown }
    if (typeof data?.runId === 'string' && data.runId) {
      return ensureRun(data.runId, event.seq, false)
    }
    if (typeof data?.messageId === 'string' && data.messageId) {
      const known = runIdByAssistantMessageId.get(data.messageId)
      if (known) return ensureRun(known, event.seq, false)
      return ensureRun(`legacy:${data.messageId}`, event.seq, true)
    }
    if (currentKey) return runs.get(currentKey)
    return undefined
  }

  const ensureRequest = (run: MutableRun, requestIndex: number): SessionTraceRequest => {
    let request = run.requests.get(requestIndex)
    if (!request) {
      request = { requestIndex, parts: [], errors: [], toolCalls: [] }
      run.requests.set(requestIndex, request)
      run.requestOrder.push(requestIndex)
    }
    run.openRequestIndex = requestIndex
    return request
  }

  /**
   * 工具调用挂在哪次请求上:当时开着的那一次。一次都没开过(崩溃残留 / 老日志
   * 缺 `request/start`)就开一个 `requestIndex: 0` 的**未记账请求**收下它 ——
   * 悄悄丢掉一次真的发生过的工具调用比多一格假请求糟得多。
   */
  const openRequest = (run: MutableRun): SessionTraceRequest => {
    if (run.openRequestIndex !== undefined) {
      const existing = run.requests.get(run.openRequestIndex)
      if (existing) return existing
    }
    return ensureRequest(run, 0)
  }

  for (const event of ordered) {
    switch (event.type) {
      case 'session/created': {
        createdAt = event.time
        sessionKind = event.data.kind
        sessionAgentId = event.data.agentId
        break
      }

      case 'user/message':
      case 'system/message':
      case 'message/imported': {
        const message = event.data.message
        const preview = previewOf(message.content, previewLimit)
        if (typeof message.id === 'string' && message.id) previewByMessageId.set(message.id, preview)
        previewBySeq.set(event.seq, preview)
        break
      }

      case 'user/message-edited': {
        const preview = previewOf(event.data.message.content, previewLimit)
        previewByMessageId.set(event.data.messageId, preview)
        previewBySeq.set(event.seq, preview)
        break
      }

      case 'session/compacted': {
        compactions.push({
          seq: event.seq,
          time: event.time,
          messageId: event.data.messageId,
          compactedMessageCount: event.data.compactedMessageCount,
          status: event.data.status ?? 'completed',
          ...(event.data.model !== undefined ? { model: event.data.model } : {}),
          ...(event.data.provider !== undefined ? { provider: event.data.provider } : {}),
          ...(event.data.error !== undefined ? { error: event.data.error } : {}),
        })
        break
      }

      case 'run/start': {
        hasRunEvents = true
        const run = ensureRun(event.data.runId, event.seq, false)
        run.kind = event.data.kind
        run.startTime = event.time
        if (event.data.agentId !== undefined) run.agentId = event.data.agentId
        if (event.data.provider !== undefined) run.provider = event.data.provider
        if (event.data.model !== undefined) run.model = event.data.model
        run.assistantMessageId = event.data.assistantMessageId
        const trigger: NonNullable<SessionTraceRun['trigger']> = {}
        if (event.data.triggerMessageId !== undefined) trigger.messageId = event.data.triggerMessageId
        if (event.data.triggerEventSeq !== undefined) trigger.eventSeq = event.data.triggerEventSeq
        const preview = event.data.triggerMessageId
          ? previewByMessageId.get(event.data.triggerMessageId)
          : event.data.triggerEventSeq !== undefined
            ? previewBySeq.get(event.data.triggerEventSeq)
            : undefined
        if (preview) trigger.preview = preview
        if (Object.keys(trigger).length > 0) run.trigger = trigger
        break
      }

      case 'run/end': {
        const run = ensureRun(event.data.runId, event.seq, false)
        run.outcome = event.data.outcome
        run.endTime = event.time
        if (event.data.error) run.error = event.data.error
        break
      }

      case 'request/tools': {
        lastToolCount = event.data.tools.length
        break
      }

      case 'request/header': {
        lastHeader = {
          provider: event.data.provider,
          model: event.data.model,
          systemPromptHash: event.data.systemPromptHash,
          toolsHash: event.data.toolsHash,
        }
        break
      }

      case 'request/recipe': {
        const run = ensureRun(event.data.runId, event.seq, false)
        const request = ensureRequest(run, event.data.requestIndex)
        request.systemPromptHash = event.data.systemPromptHash
        request.toolsHash = event.data.toolsHash
        request.recipeMessageCount = event.data.messages.length
        if (event.data.params) request.params = event.data.params
        break
      }

      case 'request/start': {
        const run = runOf(event)
        if (!run) break
        const request = ensureRequest(run, event.data.requestIndex)
        request.startSeq = event.seq
        request.startTime = event.time
        // 信封与目录是**分别**往回找的两条游标(轨迹面板同一口径):两种事件
        // 只在自己变化时追加,所以一次请求"当时看到的世界"永远在它之前。
        if (lastHeader) {
          request.provider ??= lastHeader.provider
          request.model ??= lastHeader.model
          request.systemPromptHash ??= lastHeader.systemPromptHash
          request.toolsHash ??= lastHeader.toolsHash
        }
        if (lastToolCount !== undefined) request.toolCount ??= lastToolCount
        run.provider ??= request.provider
        run.model ??= request.model
        if (run.synthetic) run.assistantMessageId ??= event.data.messageId
        break
      }

      case 'assistant/first-token': {
        const run = runOf(event)
        if (!run) break
        const request = ensureRequest(run, event.data.requestIndex)
        request.firstTokenTime ??= event.time
        break
      }

      case 'assistant/part-end': {
        // parts 的正身来自 `request/response`;它缺席时(崩在中途)才用 part-end
        // 补一格 —— 两者说的是同一件事,只是后者一条一条来。
        const run = ensureRun(event.data.runId, event.seq, false)
        const request = ensureRequest(run, event.data.requestIndex)
        if (!request.parts.some(part => part.partIndex === event.data.partIndex)) {
          request.parts.push({
            partIndex: event.data.partIndex,
            kind: event.data.kind,
            len: event.data.len,
            ...(event.data.hash !== undefined ? { hash: event.data.hash } : {}),
            ...(event.data.toolCallId !== undefined ? { toolCallId: event.data.toolCallId } : {}),
          })
        }
        break
      }

      case 'request/response': {
        const run = ensureRun(event.data.runId, event.seq, false)
        const request = ensureRequest(run, event.data.requestIndex)
        if (event.data.finishReason !== undefined) request.finishReason = event.data.finishReason
        if (event.data.usage) request.usage = event.data.usage
        if (event.data.responseModel !== undefined) request.responseModel = event.data.responseModel
        if (event.data.providerResponseId !== undefined) {
          request.providerResponseId = event.data.providerResponseId
        }
        if (event.data.parts?.length) {
          request.parts = event.data.parts.map(part => ({
            partIndex: part.partIndex,
            kind: part.kind,
            len: part.len,
            ...(part.hash !== undefined ? { hash: part.hash } : {}),
          }))
        }
        break
      }

      case 'request/error': {
        const run = ensureRun(event.data.runId, event.seq, false)
        const request = ensureRequest(run, event.data.requestIndex)
        request.errors.push({
          seq: event.seq,
          time: event.time,
          ...(event.data.error.name !== undefined ? { name: event.data.error.name } : {}),
          message: event.data.error.message,
          ...(event.data.error.status !== undefined ? { status: event.data.error.status } : {}),
          willRetry: event.data.willRetry,
          attempt: event.data.attempt,
        })
        break
      }

      case 'request/end': {
        const run = runOf(event)
        if (!run) break
        const request = ensureRequest(run, event.data.requestIndex)
        request.endTime = event.time
        if (event.data.stopReason !== undefined) request.stopReason = event.data.stopReason
        // `request/response` 的那份 usage 更全(多了总数与推理 token),不覆盖它。
        if (event.data.usage && !request.usage) request.usage = event.data.usage
        break
      }

      case 'tool/call': {
        const run = runOf(event)
        if (!run) break
        const request = openRequest(run)
        const call: SessionTraceToolCall = {
          callId: event.data.callId,
          name: event.data.name,
          argumentsRaw: event.data.argumentsRaw,
          callSeq: event.seq,
          callTime: event.time,
          ...(event.data.parentCallId !== undefined ? { parentCallId: event.data.parentCallId } : {}),
        }
        const pending = pendingPermissions.get(event.data.callId)
        if (pending) {
          call.permission = pending
          pendingPermissions.delete(event.data.callId)
        }
        request.toolCalls.push(call)
        const bucket = run.callsById.get(event.data.callId)
        if (bucket) bucket.push(call)
        else run.callsById.set(event.data.callId, [call])
        run.callBySeq.set(event.seq, call)
        break
      }

      case 'tool/result': {
        const run = runOf(event) ?? findRunByCallId(runs, event.data.callId)
        if (!run) break
        const call = typeof event.data.sourceSeq === 'number'
          ? run.callBySeq.get(event.data.sourceSeq)
          : takeUnresolvedCall(run, event.data.callId)
        if (!call) break
        call.resultSeq = event.seq
        call.resultTime = event.time
        call.resultPreview = event.data.resultPreview
        call.isError = event.data.isError
        const result = event.data.result
        if (result && 'blob' in result) call.resultRef = result.blob
        break
      }

      case 'tool/audit': {
        const run = runOf(event) ?? findRunByCallId(runs, event.data.callId)
        if (!run) break
        const call = lastCallOf(run, event.data.callId)
        if (!call) break
        call.audit = {
          toolId: event.data.toolId,
          effects: event.data.effects,
          effectCount: event.data.effectCount,
          outcome: event.data.outcome,
          ...(event.data.decision !== undefined ? { decision: event.data.decision } : {}),
          ...(event.data.asked !== undefined ? { asked: event.data.asked } : {}),
          ...(event.data.previewTitle !== undefined ? { previewTitle: event.data.previewTitle } : {}),
          ...(event.data.intercepted !== undefined ? { intercepted: event.data.intercepted } : {}),
          time: event.time,
        }
        break
      }

      case 'permission/asked': {
        const callId = event.data.toolCallId
        const permission: SessionTracePermission = {
          requestId: event.data.requestId,
          askedTime: event.time,
        }
        if (!callId) break
        const run = runOf(event)
        if (run) permissionCallByRequestId.set(event.data.requestId, { runKey: run.key, callId })
        const call = run ? lastCallOf(run, callId) : undefined
        if (call) call.permission = { ...call.permission, ...permission }
        else pendingPermissions.set(callId, permission)
        break
      }

      case 'permission/answered': {
        const callId = event.data.toolCallId
          ?? permissionCallByRequestId.get(event.data.requestId)?.callId
        if (!callId) break
        const run = runOf(event)
          ?? (permissionCallByRequestId.has(event.data.requestId)
            ? runs.get(permissionCallByRequestId.get(event.data.requestId)!.runKey)
            : undefined)
        const patch: SessionTracePermission = {
          requestId: event.data.requestId,
          answeredTime: event.time,
          approved: event.data.approved,
          ...(event.data.scope !== undefined ? { scope: event.data.scope } : {}),
          ...(event.data.reason !== undefined ? { reason: event.data.reason } : {}),
        }
        const call = run ? lastCallOf(run, callId) : undefined
        if (call) call.permission = { ...call.permission, ...patch }
        else pendingPermissions.set(callId, { ...pendingPermissions.get(callId), ...patch })
        break
      }

      case 'skill/activated': {
        const run = runOf(event)
        if (run) run.skillUsed = event.data.skill
        break
      }

      default:
        break
    }
  }

  const allRuns = [...runs.values()]
    .sort((a, b) => a.firstSeq - b.firstSeq)
    .map(finalizeRun)

  let selected = allRuns
  if (options.run) {
    selected = allRuns.filter(run => run.key === options.run || run.runId === options.run)
  } else if (options.last !== undefined && options.last > 0) {
    selected = allRuns.slice(Math.max(0, allRuns.length - Math.floor(options.last)))
  }

  return {
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    hasRunEvents,
    eventCount: ordered.length,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(sessionKind !== undefined ? { sessionKind } : {}),
    ...(sessionAgentId !== undefined ? { agentId: sessionAgentId } : {}),
    totalRuns: allRuns.length,
    runs: selected,
    compactions,
  }
}

function finalizeRun(run: MutableRun): SessionTraceRun {
  const requests = run.requestOrder
    .map(index => run.requests.get(index)!)
    .sort((a, b) => (a.startSeq ?? Number.MAX_SAFE_INTEGER) - (b.startSeq ?? Number.MAX_SAFE_INTEGER))
  const {
    requests: _requests,
    requestOrder: _order,
    openRequestIndex: _open,
    callsById: _calls,
    callBySeq: _bySeq,
    ...rest
  } = run
  return { ...rest, requests }
}

/** 同一个 callId 还没配到结果的那一次(同 callId 多次调用时各认各的)。 */
function takeUnresolvedCall(run: MutableRun, callId: string): SessionTraceToolCall | undefined {
  const bucket = run.callsById.get(callId)
  if (!bucket) return undefined
  return bucket.find(call => call.resultSeq === undefined) ?? bucket[bucket.length - 1]
}

function lastCallOf(run: MutableRun, callId: string): SessionTraceToolCall | undefined {
  const bucket = run.callsById.get(callId)
  return bucket?.[bucket.length - 1]
}

function findRunByCallId(runs: Map<string, MutableRun>, callId: string): MutableRun | undefined {
  for (const run of runs.values()) {
    if (run.callsById.has(callId)) return run
  }
  return undefined
}

function previewOf(content: unknown, limit: number): string {
  if (typeof content !== 'string') return ''
  const collapsed = content.replace(/\s+/g, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`
}

// ============ 响应正文(按需 materialize) ============

export interface SessionTraceResponseText {
  text: string
  reasoning: string
  /** 折出这段正文的 delta 条数 —— 空正文与"没有这次请求"由它分开。 */
  partCount: number
}

const EMPTY_RESPONSE_TEXT: SessionTraceResponseText = { text: '', reasoning: '', partCount: 0 }

/**
 * 从**活投影**里取一次请求的响应正文。
 *
 * 折 chunks 的逻辑不在这里重写一遍:`reduceSessionProjection` 已经把
 * `assistant/chunks` 折进了每个 run 的 parts(它是聊天区读的同一条路),这里
 * 只是按 `requestIndex` 把该请求那几段挑出来拼上。多一份 fold 就是多一份
 * 可能说谎的正文。
 *
 * `requestIndex` 缺席 = 整个 run 的正文。
 */
export function traceResponseTextFromProjection(
  state: SessionProjectionState,
  runId: string,
  requestIndex?: number,
): SessionTraceResponseText {
  const run = state.runs.get(runId)
  if (!run) return EMPTY_RESPONSE_TEXT
  let text = ''
  let reasoning = ''
  let partCount = 0
  for (const partIndex of [...run.partOrder].sort((a, b) => a - b)) {
    const part = run.parts.get(partIndex)
    if (!part) continue
    if (requestIndex !== undefined && part.requestIndex !== requestIndex) continue
    if (part.kind === 'text') {
      text += part.text
      partCount += 1
    } else if (part.kind === 'reasoning') {
      reasoning += part.text
      partCount += 1
    }
  }
  return { text, reasoning, partCount }
}

/** 从事件折一遍再取正文(没有活投影时的那条路)。 */
export function materializeTraceResponseText(
  events: readonly SessionLogEventRecord[],
  runId: string,
  requestIndex?: number,
): SessionTraceResponseText {
  let state = createSessionProjectionState()
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    state = reduceSessionProjection(state, event)
  }
  return traceResponseTextFromProjection(state, runId, requestIndex)
}

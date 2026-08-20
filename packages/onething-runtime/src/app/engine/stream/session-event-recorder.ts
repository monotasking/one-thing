/**
 * 采集点:把 agent-loop 的事件流翻译成会话事件日志。
 *
 * 挂在 `AgentLoopOptions.onEvent` 上,而不是挂在 executor 消费的 chunk 流上。
 * 理由是**记账必须在执行前**:core agent-loop 的 runner 在 `collectEvent` 里先
 * 同步调 `request.onEvent?.(event)`,再把工具执行 enqueue 进调度器。所以
 * onEvent 看到 `tool-call-done` 的那一刻,工具一定还没跑。而 chunk 流要过一层
 * 异步队列(agent-loop bridge 的 AgentEventQueue),等它到达 executor 时工具
 * 可能早跑完了 —— 挂在那里的 `tool/call` 就成了事后补记,失去了"崩溃时留下
 * 开了头没收尾"的全部价值。
 *
 * ## S1a 补齐的那半份账(§10.2 第三行)
 *
 * E0 只记**信封与时刻**(七类)。S1a 把"这次请求发了什么、模型答了什么"补上,
 * 但严格守住"正文只有一个来源"这条:
 *
 * | 事件 | 记什么 | 不记什么 |
 * |---|---|---|
 * | `request/recipe` | 系统提示词 / 工具目录指纹 + 这次发出去的每条消息的 `{messageId, contentHash}` | 消息正文(它在 `user/message` 那一份账里) |
 * | `assistant/chunks` | **每一条 delta 的原文与到达时刻**,攒批成一行 | —— 这就是响应正文的唯一来源 |
 * | `assistant/part-end` | part 的 len + hash | 正文(fold delta 得到) |
 * | `request/response` | finish / usage / providerResponseId / responseModel + 各 part 的指纹 | 第二份文本 |
 * | `request/error` | 错误 + `willRetry` / `attempt` | —— |
 * | `skill/activated` | 这一轮激活了哪个技能 | —— |
 *
 * ### 攒批的四个触发点(§3 助手行)
 *
 * 2 秒 / 64 条 / part 边界 / 请求结束,先到者触发。一条 delta 一行会把 events.jsonl
 * 撑爆(一次响应几千条),而完全不记 delta 是量级退化(崩溃丢整个未收齐的
 * part)。攒批之后崩溃最多丢最后一批(≤2s),而 token 级回放与 TTFT/tps 全都
 * 还在。
 *
 * 本模块的所有异常自吞:记账坏了绝不能影响聊天。
 */

import type {
  AgentLoopOptions,
  AgentStreamEvent,
  AgentTool,
} from '@onething/core/agent-loop'
import type {
  BlobRef,
  SessionAssistantPartKind,
  SessionResponseUsage,
} from '@onething/core/session'
import {
  hashSessionEventContent,
  hashSessionEventSystemPrompt,
  hashSessionEventTools,
  isSameRequestHeaderEnvelope,
  truncateSessionEventPreview,
  type SessionEventToolSchema,
  type SessionRequestHeaderEventData,
} from '@onething/runtime/sessions/session-events'
import {
  appendSessionLogEvent,
  findLastSessionEventSync,
  flushSessionEventLog,
  nextSessionRequestIndex,
} from '../../session/event-log.js'
import { textOrBlobForEvent } from '../../session/blob-store.js'
import {
  currentSessionRunId,
  nextSessionRunPartIndex,
  setSessionRunRequestIndex,
} from '../../session/runs.js'
import { getLogger } from '../../logging/index.js'

const log = getLogger('sessions.events')


/** 攒批的三条闸(第四条是"请求结束",由 turn-end 触发)。 */
export const SESSION_CHUNK_BATCH_INTERVAL_MS = 2000
export const SESSION_CHUNK_BATCH_SIZE = 64

/** 这次请求发出去的历史里的一条(G10:身份 + 指纹,不是正文)。 */
export interface SessionRecipeMessage {
  messageId: string
  contentHash: string
}

export interface SessionEventRecorderContext {
  sessionId: string
  providerId: string
  model: string
  /** 当次请求的 system prompt 全文;只用来算指纹,不落盘。 */
  systemPrompt?: string
  /** 当次请求模型看到的工具目录。 */
  tools?: readonly AgentTool[]
  /** 助手消息 id 现取现用 —— 一个 run 里它会随 response-boundary 换锚点。 */
  getMessageId: () => string
  /**
   * G10:这次请求发出去的**历史输入**。
   *
   * 采集点必须是 history builder 的**输入**(带 id 的那一份 `ChatMessage[]`),
   * 而不是 provider 收到的 `AgentMessage[]` —— 后者没有消息 id,配对只能靠数
   * 下标,而工具消息会把下标错开。缺省不给就不写 recipe 的 messages 那一格
   * (少一格账,好过一格猜出来的账)。
   *
   * `eventSeq` 要到 S2 才填得上(id→seq 索引在那一期建),所以这里只有
   * `{messageId, contentHash}`,与 §10.1 G10 的裁定一致。
   */
  getHistoryInput?: () => readonly { id: string; role: string; content?: string }[]
  /** 请求参数快照(温度 / maxTokens / thinking …),原样进 recipe。 */
  getRequestParams?: () => Record<string, unknown> | undefined
  /**
   * 配方写下去的那一刻(= 这次请求真正发出之前)的旁听口。
   *
   * S1b 的历史影子断言挂在这里(`history-shadow.ts`)。留一个回调而不是就地
   * import:那条断言要用 `buildHistoryMessages` 与读门面,而它们身后是整棵
   * store 树 —— recorder 只该依赖会话事件那一层。
   */
  onRequestRecipe?: (runId: string, requestIndex: number) => void
}

/**
 * 工具结局的结构化那一份 → 事件行。
 *
 * `AgentToolResult.data` 就是引擎写进 `ToolCall.result` 的那个对象
 * (`tool-orchestration.ts` 的 `toJsonValue(result.data)`),所以这里存的与那边
 * 存的是同一份。序列化失败不写 —— 少一格账,好过一格坏掉的账。
 *
 * **字符串结局分两种**(§10.14):成功时它与 `result.text` 是同一个东西,不必
 * 存两遍;**失败**时 `result.text` 装的是那句错误话,而 `ToolCall.result` 装的
 * 仍是 data —— 两者不是同一个东西,不写就等于把它丢了(矩阵在
 * `tool-args-truncated` 那一格抓到:参数 JSON 断在半路,data 是空串)。
 */
function structuredResultForEvent(
  sessionId: string,
  data: unknown,
  isError = false,
): { resultData: { text: string } | { blob: BlobRef } } | Record<string, never> {
  if (data === undefined || data === null) return {}
  if (typeof data !== 'object' && !isError) return {}
  let text: string
  try {
    text = JSON.stringify(data)
  } catch {
    return {}
  }
  if (!text) return {}
  return { resultData: textOrBlobForEvent(sessionId, text) }
}

function toToolSchemas(tools: readonly AgentTool[] | undefined): SessionEventToolSchema[] {
  if (!tools?.length) return []
  return tools.map(tool => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters ? { parameters: tool.parameters } : {}),
  }))
}

/** 一段还在攒的 delta 批次。 */
interface ChunkBatch {
  partIndex: number
  kind: Exclude<SessionAssistantPartKind, 'image'>
  requestIndex: number
  messageId: string
  toolCallId?: string
  toolName?: string
  time0: number
  dt: number[]
  text: string[]
  timer: ReturnType<typeof setTimeout> | null
}

/** 一个 part 的累计状态(part-end 的 len/hash 从这里来)。 */
interface PartState {
  partIndex: number
  kind: Exclude<SessionAssistantPartKind, 'image'>
  requestIndex: number
  messageId: string
  toolCallId?: string
  /**
   * `tool-input` 段的工具名(`tool-call-start` 那一格)。孤儿参数流永远等不到
   * `tool/call`,没有这一格就说不出"被打断的那次调用是谁"(§10.14 第 7 类)。
   */
  toolName?: string
  text: string
}

interface RecorderState {
  requestIndex?: number
  firstTokenWritten: boolean
  /** 上一条已写入的 header 信封;首次从文件恢复(跨重启也不重复写)。 */
  lastHeader?: SessionRequestHeaderEventData
  lastHeaderLoaded: boolean
  /**
   * 上一条已写入的工具目录指纹;首次从文件恢复 —— 跨重启也不会把那 40KB
   * 再写一遍。恢复读的是 `request/tools.toolsHash` 字段,不重算大数组。
   */
  lastToolsHash?: string
  lastToolsHashLoaded: boolean
  callSeqByCallId: Map<string, number>
  /**
   * callId → 工具自报的**最后一个**标题(`tool-metadata` 里带 title 的那几条)。
   *
   * 与引擎同一条规则:`applyAgentLoopToolMetadata` 只在 `update.title` 是非空
   * 字符串时覆盖 step 标题,收尾时只带 metadata 的那条 annotate 不清空标题。
   */
  reportedTitleByCallId: Map<string, string>
  /** 正在攒的批(每个 part 至多一个)。 */
  batches: Map<number, ChunkBatch>
  /** 还没收齐的 part。 */
  openParts: Map<number, PartState>
  /** 正文 / 推理各自当前那一段的 partIndex(换 kind 就换段)。 */
  currentTextPart?: number
  currentReasoningPart?: number
  /** toolCallId → 它的参数流那一段。 */
  toolInputPartByCallId: Map<string, number>
  /** 这次请求收齐的 part(request/response 的 parts 指纹表)。 */
  finishedParts: Array<{ partIndex: number; kind: SessionAssistantPartKind; len: number; hash: string }>
  /** 这次请求产出的工具调用 id。 */
  toolCallIds: string[]
  /** provider 自报的响应 id / 模型(有些 provider 在 provider-data 里带)。 */
  providerResponseId?: string
  responseModel?: string
  /** 这次请求的自动重试次数(`auto-retry` 累加)。 */
  attempt: number
}

export interface SessionEventRecorder {
  handle(event: AgentStreamEvent): void
  /**
   * 请求**最终**失败(重试用光 / 不可重试)。`auto-retry` 记的是
   * `willRetry:true` 的那几次,这一条记的是收场 —— 由执行器的 catch 调。
   */
  recordRequestError(error: unknown): void
  /** 把还在攒的批全部落盘(执行器收尾时调,防止最后一批被丢)。 */
  flush(): void
}

export function createSessionEventRecorder(
  ctx: SessionEventRecorderContext,
): SessionEventRecorder {
  const state: RecorderState = {
    firstTokenWritten: false,
    lastHeaderLoaded: false,
    lastToolsHashLoaded: false,
    callSeqByCallId: new Map(),
    reportedTitleByCallId: new Map(),
    batches: new Map(),
    openParts: new Map(),
    toolInputPartByCallId: new Map(),
    finishedParts: [],
    toolCallIds: [],
    attempt: 0,
  }

  const runId = (): string | undefined => currentSessionRunId(ctx.sessionId)

  /**
   * 工具目录在这个记录器的整个生命周期内是恒定的(`ctx.tools` 在 attach 时就
   * 定好了),所以 schema 数组与指纹各算一次就够 —— 每回合重算 40KB 的
   * JSON.stringify 是纯浪费。
   */
  let catalog: { tools: SessionEventToolSchema[]; hash: string } | undefined
  function toolCatalog(): { tools: SessionEventToolSchema[]; hash: string } {
    if (!catalog) {
      const tools = toToolSchemas(ctx.tools)
      catalog = { tools, hash: hashSessionEventTools(tools) }
    }
    return catalog
  }

  /**
   * 目录变了才写那 40KB。返回本次生效的指纹,交给 header 引用。
   *
   * 与 header 的去重**互相独立**:system prompt 会话内会变(变量/上下文注入),
   * 目录不会;合在一条里的话每次 system 一变就陪葬一份没变的目录。
   */
  function maybeWriteTools(requestIndex: number): string {
    const { tools, hash } = toolCatalog()
    if (!state.lastToolsHashLoaded) {
      state.lastToolsHash = findLastSessionEventSync(ctx.sessionId, 'request/tools')?.data.toolsHash
      state.lastToolsHashLoaded = true
    }
    if (state.lastToolsHash === hash) return hash
    appendSessionLogEvent(ctx.sessionId, 'request/tools', {
      requestIndex,
      toolsHash: hash,
      tools,
      ...withRunId(),
    })
    state.lastToolsHash = hash
    return hash
  }

  function withRunId(): { runId?: string } {
    const id = runId()
    return id ? { runId: id } : {}
  }

  function envelope(requestIndex: number, toolsHash: string): SessionRequestHeaderEventData {
    return {
      requestIndex,
      provider: ctx.providerId,
      model: ctx.model,
      systemPromptHash: hashSessionEventSystemPrompt(ctx.systemPrompt ?? ''),
      toolsHash,
      reason: 'initial',
    }
  }

  function maybeWriteHeader(requestIndex: number, toolsHash: string): void {
    if (!state.lastHeaderLoaded) {
      state.lastHeader = findLastSessionEventSync(ctx.sessionId, 'request/header')?.data
      state.lastHeaderLoaded = true
    }
    const next = envelope(requestIndex, toolsHash)
    if (isSameRequestHeaderEnvelope(state.lastHeader, next)) return
    next.reason = state.lastHeader ? 'change' : 'initial'
    appendSessionLogEvent(ctx.sessionId, 'request/header', { ...next, ...withRunId() })
    state.lastHeader = next
  }

  /** G10:这次请求究竟发了哪些消息 —— 身份 + 指纹的自证账。 */
  function writeRecipe(requestIndex: number, toolsHash: string): void {
    const id = runId()
    if (!id) return
    const input = ctx.getHistoryInput?.()
    const messages: SessionRecipeMessage[] = (input ?? []).map(message => ({
      messageId: message.id,
      contentHash: hashSessionEventContent(`${message.role}\n${message.content ?? ''}`),
    }))
    const params = ctx.getRequestParams?.()
    appendSessionLogEvent(ctx.sessionId, 'request/recipe', {
      runId: id,
      requestIndex,
      systemPromptHash: hashSessionEventSystemPrompt(ctx.systemPrompt ?? ''),
      toolsHash,
      // `eventSeq` 在 S2 由 id→seq 索引解析(§10.1 G10);S1 只有身份与指纹。
      messages: messages as unknown as { eventSeq: number; contentHash: string }[],
      ...(params ? { params } : {}),
    })
    // S1b:配方写下去的同一刻比一次历史 —— 比的就是这次要发出去的那一份。
    try {
      ctx.onRequestRecipe?.(id, requestIndex)
    } catch (error) {
      log.warn('request recipe hook failed', { sessionId: ctx.sessionId }, error)
    }
  }

  // ---- delta 攒批 ----

  function openPart(
    kind: Exclude<SessionAssistantPartKind, 'image'>,
    toolCallId?: string,
    toolName?: string,
  ): number | undefined {
    const requestIndex = state.requestIndex
    if (requestIndex === undefined) return undefined
    const partIndex = nextSessionRunPartIndex(ctx.sessionId)
    if (partIndex === undefined) return undefined
    state.openParts.set(partIndex, {
      partIndex,
      kind,
      requestIndex,
      messageId: ctx.getMessageId(),
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName } : {}),
      text: '',
    })
    return partIndex
  }

  function flushBatch(partIndex: number): void {
    const batch = state.batches.get(partIndex)
    if (!batch) return
    state.batches.delete(partIndex)
    if (batch.timer) clearTimeout(batch.timer)
    if (batch.text.length === 0) return
    const id = runId()
    if (!id) return
    appendSessionLogEvent(ctx.sessionId, 'assistant/chunks', {
      runId: id,
      requestIndex: batch.requestIndex,
      messageId: batch.messageId,
      partIndex: batch.partIndex,
      kind: batch.kind,
      ...(batch.toolCallId ? { toolCallId: batch.toolCallId } : {}),
      ...(batch.toolName ? { toolName: batch.toolName } : {}),
      time0: batch.time0,
      dt: batch.dt,
      text: batch.text,
    })
  }

  function flushAllBatches(): void {
    for (const partIndex of [...state.batches.keys()]) flushBatch(partIndex)
  }

  function pushDelta(partIndex: number, delta: string): void {
    const part = state.openParts.get(partIndex)
    if (!part || !delta) return
    part.text += delta

    const now = Date.now()
    let batch = state.batches.get(partIndex)
    if (!batch) {
      batch = {
        partIndex,
        kind: part.kind,
        requestIndex: part.requestIndex,
        messageId: part.messageId,
        ...(part.toolCallId ? { toolCallId: part.toolCallId } : {}),
        ...(part.toolName ? { toolName: part.toolName } : {}),
        time0: now,
        dt: [],
        text: [],
        timer: null,
      }
      state.batches.set(partIndex, batch)
      // 2 秒闸:一段慢吞吞吐字的响应也要按时落账(崩溃最多丢这 2 秒)。
      const timer = setTimeout(() => flushBatch(partIndex), SESSION_CHUNK_BATCH_INTERVAL_MS)
      const unref = (timer as unknown as { unref?: () => void }).unref
      if (typeof unref === 'function') unref.call(timer)
      batch.timer = timer
    }
    batch.dt.push(now - batch.time0)
    batch.text.push(delta)
    // 64 条闸。
    if (batch.text.length >= SESSION_CHUNK_BATCH_SIZE) flushBatch(partIndex)
  }

  /** part 边界闸:先把批落了,再记这一段的 len/hash。 */
  function endPart(partIndex: number | undefined): void {
    if (partIndex === undefined) return
    flushBatch(partIndex)
    const part = state.openParts.get(partIndex)
    if (!part) return
    state.openParts.delete(partIndex)
    const id = runId()
    const hash = hashSessionEventContent(part.text)
    state.finishedParts.push({ partIndex, kind: part.kind, len: part.text.length, hash })
    if (!id) return
    appendSessionLogEvent(ctx.sessionId, 'assistant/part-end', {
      runId: id,
      requestIndex: part.requestIndex,
      messageId: part.messageId,
      partIndex,
      kind: part.kind,
      len: part.text.length,
      hash,
      ...(part.toolCallId ? { toolCallId: part.toolCallId } : {}),
      ...(part.toolName ? { toolName: part.toolName } : {}),
    })
  }

  function endAllOpenParts(): void {
    for (const partIndex of [...state.openParts.keys()]) endPart(partIndex)
    state.currentTextPart = undefined
    state.currentReasoningPart = undefined
    state.toolInputPartByCallId.clear()
  }

  /** 换 kind 就换段:一段 text 与一段 reasoning 不能共用一个 partIndex。 */
  function deltaInto(kind: 'text' | 'reasoning', delta: string): void {
    const slot = kind === 'text' ? 'currentTextPart' : 'currentReasoningPart'
    const other = kind === 'text' ? 'currentReasoningPart' : 'currentTextPart'
    if (state[other] !== undefined) {
      endPart(state[other])
      state[other] = undefined
    }
    if (state[slot] === undefined) state[slot] = openPart(kind)
    const partIndex = state[slot]
    if (partIndex === undefined) return
    pushDelta(partIndex, delta)
  }

  function normalizeUsage(usage: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  } | undefined): SessionResponseUsage | undefined {
    if (!usage) return undefined
    return {
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    }
  }

  function handle(event: AgentStreamEvent): void {
    switch (event.type) {
      case 'turn-start': {
        const requestIndex = nextSessionRequestIndex(ctx.sessionId)
        if (requestIndex === undefined) return
        state.requestIndex = requestIndex
        setSessionRunRequestIndex(ctx.sessionId, requestIndex)
        state.firstTokenWritten = false
        state.finishedParts = []
        state.toolCallIds = []
        state.attempt = 0
        state.providerResponseId = undefined
        state.responseModel = undefined
        // 先目录后信封:header 引用的 toolsHash 在日志里一定已经有了对应的
        // request/tools。读侧不依赖这个顺序,但顺序对的日志人也能顺着读。
        const toolsHash = maybeWriteTools(requestIndex)
        maybeWriteHeader(requestIndex, toolsHash)
        writeRecipe(requestIndex, toolsHash)
        appendSessionLogEvent(ctx.sessionId, 'request/start', {
          requestIndex,
          messageId: ctx.getMessageId(),
          ...withRunId(),
        })
        // 语义检查点:调模型之前,这次请求的配方必须已经在盘上(§10.3 ③)。
        void flushSessionEventLog(ctx.sessionId)
        return
      }
      case 'response-boundary': {
        // steering 打断:当前响应到此为止。part 全部收齐,新响应从
        // `createNextAssistantWriter` 那边换 run(见 agent-loop-executor)。
        endAllOpenParts()
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        if (!event.delta) return
        if (state.requestIndex === undefined) return
        if (!state.firstTokenWritten) {
          state.firstTokenWritten = true
          appendSessionLogEvent(ctx.sessionId, 'assistant/first-token', {
            requestIndex: state.requestIndex,
            messageId: ctx.getMessageId(),
            ...withRunId(),
          })
        }
        deltaInto(event.type === 'text-delta' ? 'text' : 'reasoning', event.delta)
        return
      }
      case 'tool-call-start': {
        const partIndex = openPart('tool-input', event.toolCallId, event.toolName)
        if (partIndex !== undefined) state.toolInputPartByCallId.set(event.toolCallId, partIndex)
        return
      }
      case 'tool-call-delta': {
        const partIndex = state.toolInputPartByCallId.get(event.toolCallId)
        if (partIndex !== undefined) pushDelta(partIndex, event.argumentsDelta)
        return
      }
      case 'tool-call-done': {
        // 参数流**先**收齐(part-end),`tool/call` 才落账 —— 铁律 2 的顺序:
        // 记的是"参数定稿了,还没执行"。
        const partIndex = state.toolInputPartByCallId.get(event.toolCall.id)
        if (partIndex !== undefined) {
          endPart(partIndex)
          state.toolInputPartByCallId.delete(event.toolCall.id)
        }
        // S3.1(§10.11):`skill/activated` **不在这里认**。记录器认一遍、引擎再认
        // 一遍 = 两个判定点,真机上就出现过"账本有 skill/activated 而消息上没有
        // skillUsed"。现在唯一的判定点在引擎(`startAgentLoopToolExecution` /
        // `executeCoreToolAndUpdate`),这条事件由那一次宣告经 emitter 落账
        // (`app/events/event-only-emitter.ts`)—— 记录器只记引擎宣告过的事。
        const seq = appendSessionLogEvent(ctx.sessionId, 'tool/call', {
          callId: event.toolCall.id,
          name: event.toolCall.name,
          argumentsRaw: event.toolCall.arguments,
          messageId: ctx.getMessageId(),
          ...withRunId(),
        })
        if (seq !== undefined) state.callSeqByCallId.set(event.toolCall.id, seq)
        state.toolCallIds.push(event.toolCall.id)
        // 语义检查点:调工具之前(§10.3 ③)。
        void flushSessionEventLog(ctx.sessionId)
        return
      }
      case 'tool-metadata': {
        // 工具自报的标题(`annotate{title}`)。引擎拿它**当场**盖掉 step 标题
        // (`applyAgentLoopToolMetadata`),而结局对象里只有成功时才抄了一份 ——
        // 失败的调用没有结局对象,标题就只剩这一条路能记下来(§10.12 第 6 类)。
        const title = event.update.title
        if (typeof title === 'string' && title) {
          state.reportedTitleByCallId.set(event.toolCall.id, title)
        }
        return
      }
      case 'provider-data': {
        // provider 自报的响应身份。名字各家不同,认得的就记,认不得的不猜。
        const data = event.providerData as Record<string, unknown>
        const responseId = data.responseId ?? data.id
        if (typeof responseId === 'string') state.providerResponseId = responseId
        if (typeof data.model === 'string') state.responseModel = data.model
        return
      }
      case 'auto-retry': {
        state.attempt = event.attempt
        const id = runId()
        if (!id || state.requestIndex === undefined) return
        appendSessionLogEvent(ctx.sessionId, 'request/error', {
          runId: id,
          requestIndex: state.requestIndex,
          error: { message: event.error },
          willRetry: true,
          attempt: event.attempt,
        })
        return
      }
      case 'tool-result': {
        const isError = Boolean(event.result.error)
        const preview = event.result.error ?? event.result.content ?? ''
        const sourceSeq = state.callSeqByCallId.get(event.toolCall.id)
        state.callSeqByCallId.delete(event.toolCall.id)
        const reportedTitle = state.reportedTitleByCallId.get(event.toolCall.id)
        state.reportedTitleByCallId.delete(event.toolCall.id)
        appendSessionLogEvent(ctx.sessionId, 'tool/result', {
          callId: event.toolCall.id,
          isError,
          // 预览**保留**:老文件只有它,轨迹面板也只读它。
          resultPreview: truncateSessionEventPreview(preview),
          // 正文补上:64KB 以内进事件行,超过走 blob(§9.1)。
          result: textOrBlobForEvent(ctx.sessionId, preview),
          // S1b:**结构化**结局(`ToolCall.result` 的正身)。工具卡渲染的是它,
          // 只记正文的话 S2 切读之后每张卡都退化成一段纯文本(diff hunks、
          // 退出码、文件路径全在 metadata 里)。**成功**时字符串结局不写 ——
          // 那时它与上面那一格是同一个东西;失败时两者不是同一个东西(见函数注释)。
          // 取的是引擎那一行的**同一个表达式**:`toJsonValue(result.data ?? result.content)`
          // (`settleAgentLoopToolResult`)。只记 `data` 的话,一次 `data` 缺席、
          // `content` 是空串的失败(参数 JSON 断在半路)在账上就少一格 `result`。
          ...structuredResultForEvent(ctx.sessionId, event.result.data ?? event.result.content, isError),
          // 工具自报的标题:引擎的 step 标题就是它。成功时它同时在
          // `resultData.title` 里,失败时那里没有 —— 所以这一格是独立的一份账。
          ...(reportedTitle ? { reportedTitle } : {}),
          ...(sourceSeq !== undefined ? { sourceSeq } : {}),
          ...withRunId(),
        })
        return
      }
      case 'turn-end': {
        if (state.requestIndex === undefined) return
        // 请求结束闸:所有还开着的 part 收齐,所有攒着的批落盘。
        endAllOpenParts()
        const usage = normalizeUsage(event.usage)
        const id = runId()
        if (id) {
          appendSessionLogEvent(ctx.sessionId, 'request/response', {
            runId: id,
            requestIndex: state.requestIndex,
            messageId: ctx.getMessageId(),
            ...(state.providerResponseId ? { providerResponseId: state.providerResponseId } : {}),
            ...(state.responseModel ? { responseModel: state.responseModel } : {}),
            ...(event.finishReason ? { finishReason: event.finishReason } : {}),
            ...(usage ? { usage } : {}),
            ...(state.finishedParts.length > 0 ? { parts: [...state.finishedParts] } : {}),
            ...(state.toolCallIds.length > 0 ? { toolCallIds: [...state.toolCallIds] } : {}),
          })
        }
        appendSessionLogEvent(ctx.sessionId, 'request/end', {
          requestIndex: state.requestIndex,
          ...(event.finishReason ? { stopReason: event.finishReason } : {}),
          ...(event.usage
            ? {
                usage: {
                  ...(event.usage.inputTokens !== undefined ? { inputTokens: event.usage.inputTokens } : {}),
                  ...(event.usage.outputTokens !== undefined ? { outputTokens: event.usage.outputTokens } : {}),
                  ...(event.usage.cacheReadTokens !== undefined
                    ? { cacheReadTokens: event.usage.cacheReadTokens }
                    : {}),
                  ...(event.usage.cacheWriteTokens !== undefined
                    ? { cacheWriteTokens: event.usage.cacheWriteTokens }
                    : {}),
                },
              }
            : {}),
          ...withRunId(),
        })
        // 语义检查点:响应收齐(§10.3 ③)。
        void flushSessionEventLog(ctx.sessionId)
        return
      }
      default:
        return
    }
  }

  return {
    handle(event) {
      try {
        handle(event)
      } catch (error) {
        // 记账绝不打断聊天。
        log.warn('event recorder failed', { sessionId: ctx.sessionId }, error)
      }
    },
    recordRequestError(error) {
      try {
        endAllOpenParts()
        const id = runId()
        if (!id || state.requestIndex === undefined) return
        const normalized = error instanceof Error
          ? {
              ...(error.name ? { name: error.name } : {}),
              message: error.message,
              ...(typeof (error as unknown as { status?: unknown }).status === 'number'
                ? { status: (error as unknown as { status: number }).status }
                : {}),
            }
          : { message: String(error) }
        appendSessionLogEvent(ctx.sessionId, 'request/error', {
          runId: id,
          requestIndex: state.requestIndex,
          error: normalized,
          willRetry: false,
          attempt: state.attempt,
        })
      } catch (cause) {
        log.warn('event recorder error record failed', { sessionId: ctx.sessionId }, cause)
      }
    },
    flush() {
      try {
        endAllOpenParts()
        flushAllBatches()
      } catch (error) {
        log.warn('event recorder flush failed', { sessionId: ctx.sessionId }, error)
      }
    },
  }
}

/**
 * 把记录器接到一份 agent-loop runtime 上。
 *
 * 返回 `{ runtime, recorder }`:执行器需要 recorder 本体才能在**错误与收尾**
 * 两条路上记账(那两条路不经过 `onEvent`)。已有的 onEvent 原样保留并在记账
 * 之后调用。
 */
export function attachSessionEventRecorder(
  runtime: AgentLoopOptions,
  ctx: Omit<SessionEventRecorderContext, 'tools'> & { tools?: readonly AgentTool[] },
): { runtime: AgentLoopOptions; recorder: SessionEventRecorder } {
  // runner 会先按 toolPolicy 过滤工具目录;policy 关掉时模型看到的是空目录,
  // header 就该照实记空 —— 记录"当时模型看到的世界",不记装配时的意图。
  const tools = runtime.toolPolicy?.enabled === false
    ? []
    : (ctx.tools ?? runtime.tools)
  const recorder = createSessionEventRecorder({ ...ctx, tools })
  const existing = runtime.onEvent
  return {
    recorder,
    runtime: {
      ...runtime,
      onEvent(event) {
        recorder.handle(event)
        existing?.(event)
      },
    },
  }
}

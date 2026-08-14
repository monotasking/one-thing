/**
 * 采集点:把 agent-loop 的事件流翻译成会话事件日志(主线 E0)。
 *
 * 挂在 `AgentLoopOptions.onEvent` 上,而不是挂在 executor 消费的 chunk 流上。
 * 理由是**记账必须在执行前**:core agent-loop 的 runner 在 `collectEvent` 里先
 * 同步调 `request.onEvent?.(event)`,再把工具执行 enqueue 进调度器。所以
 * onEvent 看到 `tool-call-done` 的那一刻,工具一定还没跑。而 chunk 流要过一层
 * 异步队列(agent-loop bridge 的 AgentEventQueue),等它到达 executor 时工具
 * 可能早跑完了 —— 挂在那里的
 * `tool/call` 就成了事后补记,失去了"崩溃时留下开了头没收尾"的全部价值。
 *
 * 与既有 provider-requests dump 的关系:那份 dump 记的是**请求正文**(整个
 * message 数组、system 全文,gzip 落在 `~/.onething/log/provider-requests/`,
 * 按时间戳命名,与会话无从属关系),是排障用的一次性证物;这里记的是**时刻与
 * 信封**(谁、什么模型、什么 schema 目录、什么时候),按会话归档、可重放、
 * 供 E1 面板做第二投影。两者不重叠,也不互相替代。
 *
 * 本模块的所有异常自吞:记账坏了绝不能影响聊天。
 */

import type {
  AgentLoopOptions,
  AgentStreamEvent,
  AgentTool,
} from '@onething/core/agent-loop'
import {
  hashSessionEventSystemPrompt,
  hashSessionEventTools,
  isSameRequestHeaderEnvelope,
  truncateSessionEventPreview,
  type SessionEventToolSchema,
  type SessionRequestHeaderEventData,
} from '@onething/runtime/sessions/session-events'
import {
  appendSessionEvent,
  findLastSessionEventSync,
  nextSessionRequestIndex,
} from '../../session/event-log.js'

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
}

function toToolSchemas(tools: readonly AgentTool[] | undefined): SessionEventToolSchema[] {
  if (!tools?.length) return []
  return tools.map(tool => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters ? { parameters: tool.parameters } : {}),
  }))
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
}

export interface SessionEventRecorder {
  handle(event: AgentStreamEvent): void
}

export function createSessionEventRecorder(
  ctx: SessionEventRecorderContext,
): SessionEventRecorder {
  const state: RecorderState = {
    firstTokenWritten: false,
    lastHeaderLoaded: false,
    lastToolsHashLoaded: false,
    callSeqByCallId: new Map(),
  }

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
    appendSessionEvent(ctx.sessionId, 'request/tools', { requestIndex, toolsHash: hash, tools })
    state.lastToolsHash = hash
    return hash
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
    appendSessionEvent(ctx.sessionId, 'request/header', next)
    state.lastHeader = next
  }

  function handle(event: AgentStreamEvent): void {
    switch (event.type) {
      case 'turn-start': {
        const requestIndex = nextSessionRequestIndex(ctx.sessionId)
        if (requestIndex === undefined) return
        state.requestIndex = requestIndex
        state.firstTokenWritten = false
        // 先目录后信封:header 引用的 toolsHash 在日志里一定已经有了对应的
        // request/tools。读侧不依赖这个顺序,但顺序对的日志人也能顺着读。
        const toolsHash = maybeWriteTools(requestIndex)
        maybeWriteHeader(requestIndex, toolsHash)
        appendSessionEvent(ctx.sessionId, 'request/start', {
          requestIndex,
          messageId: ctx.getMessageId(),
        })
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        if (state.firstTokenWritten || !event.delta) return
        if (state.requestIndex === undefined) return
        state.firstTokenWritten = true
        appendSessionEvent(ctx.sessionId, 'assistant/first-token', {
          requestIndex: state.requestIndex,
          messageId: ctx.getMessageId(),
        })
        return
      }
      case 'tool-call-done': {
        const seq = appendSessionEvent(ctx.sessionId, 'tool/call', {
          callId: event.toolCall.id,
          name: event.toolCall.name,
          argumentsRaw: event.toolCall.arguments,
          messageId: ctx.getMessageId(),
        })
        if (seq !== undefined) state.callSeqByCallId.set(event.toolCall.id, seq)
        return
      }
      case 'tool-result': {
        const isError = Boolean(event.result.error)
        const preview = event.result.error ?? event.result.content ?? ''
        const sourceSeq = state.callSeqByCallId.get(event.toolCall.id)
        state.callSeqByCallId.delete(event.toolCall.id)
        appendSessionEvent(ctx.sessionId, 'tool/result', {
          callId: event.toolCall.id,
          isError,
          resultPreview: truncateSessionEventPreview(preview),
          ...(sourceSeq !== undefined ? { sourceSeq } : {}),
        })
        return
      }
      case 'turn-end': {
        if (state.requestIndex === undefined) return
        const usage = event.usage
        appendSessionEvent(ctx.sessionId, 'request/end', {
          requestIndex: state.requestIndex,
          ...(event.finishReason ? { stopReason: event.finishReason } : {}),
          ...(usage
            ? {
                usage: {
                  ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
                  ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
                  ...(usage.cacheReadTokens !== undefined
                    ? { cacheReadTokens: usage.cacheReadTokens }
                    : {}),
                  ...(usage.cacheWriteTokens !== undefined
                    ? { cacheWriteTokens: usage.cacheWriteTokens }
                    : {}),
                },
              }
            : {}),
        })
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
        console.warn('[SessionEvents] recorder failed:', error)
      }
    },
  }
}

/**
 * 把记录器接到一份 agent-loop runtime 上,返回新的 options(不改原对象)。
 * 已有的 onEvent 原样保留并在记账之后调用。
 */
export function attachSessionEventRecorder(
  runtime: AgentLoopOptions,
  ctx: Omit<SessionEventRecorderContext, 'tools'> & { tools?: readonly AgentTool[] },
): AgentLoopOptions {
  // runner 会先按 toolPolicy 过滤工具目录;policy 关掉时模型看到的是空目录,
  // header 就该照实记空 —— 记录"当时模型看到的世界",不记装配时的意图。
  const tools = runtime.toolPolicy?.enabled === false
    ? []
    : (ctx.tools ?? runtime.tools)
  const recorder = createSessionEventRecorder({ ...ctx, tools })
  const existing = runtime.onEvent
  return {
    ...runtime,
    onEvent(event) {
      recorder.handle(event)
      existing?.(event)
    },
  }
}

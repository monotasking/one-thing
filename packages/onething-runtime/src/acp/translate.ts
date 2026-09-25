import type {
  AgentFinishReason,
  AgentToolCall,
  AgentToolResult,
  AgentToolResultContentPart,
  AgentTurnStreamEvent,
} from '@onething/core/agent-loop'

/**
 * ACP 流事件 → 引擎回合事件的翻译(A0-3 从 `agent-loop/providers/acp.ts` 搬来)。
 *
 * 这里只收「一条 `session/prompt` 的在飞事件怎么变成 `AgentTurnStreamEvent`」这一件事:
 * 纯函数、不认识 `ACPManager`、不认识连接。连接器(`external-agents/acp-connector.ts`)
 * 负责把会话开起来、把事件流递进来。翻译的**输出**本单一字不改,改它是 A2 的事。
 *
 * 入参用结构化子集而不是 SDK 的类型:测试夹具与回放文件可以直接写字面量,
 * SDK 的判别联合换版时这一层也不跟着抖。
 */

export interface ACPWireContentPart {
  type: string
  text?: string
}

/**
 * Structural subset of ACP `ToolCallContent`: either an embedded content
 * block (`type: 'content'`) or a diff (`type: 'diff'`). Terminal refs are
 * ignored.
 */
export interface ACPWireToolCallContentPart {
  type: string
  content?: ACPWireContentPart | null
  text?: string
  path?: string | null
  oldText?: string | null
  newText?: string | null
}

/**
 * Structural subset of the ACP `tool_call` / `tool_call_update` session
 * update payloads (@agentclientprotocol/sdk ToolCall / ToolCallUpdate).
 */
export interface ACPWireSessionUpdate {
  sessionUpdate: string
  /**
   * Message/thought chunks carry a single content block; tool_call and
   * tool_call_update carry an array of ToolCallContent — same wire field.
   */
  content?: ACPWireContentPart | ACPWireToolCallContentPart[] | null
  toolCallId?: string
  title?: string | null
  kind?: string | null
  status?: string | null
  rawInput?: unknown
  rawOutput?: unknown
}

export type ACPWireStreamEvent =
  | { type: 'warning'; message: string }
  | { type: 'finish'; stopReason: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }
  | {
      type: 'update'
      notification: {
        update: ACPWireSessionUpdate
      }
    }

export function mapACPFinishReason(stopReason: string): AgentFinishReason {
  if (stopReason === 'end_turn') return 'stop'
  if (stopReason === 'max_tokens') return 'length'
  if (stopReason === 'refusal') return 'content_filter'
  return 'unknown'
}

function textFromACPContent(
  content: ACPWireContentPart | ACPWireToolCallContentPart[] | null | undefined,
): string | undefined {
  if (!content || Array.isArray(content)) return undefined
  return content.type === 'text' ? content.text : undefined
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function acpToolContentToParts(
  content: ACPWireToolCallContentPart[] | null | undefined,
): AgentToolResultContentPart[] {
  const parts: AgentToolResultContentPart[] = []
  for (const item of content ?? []) {
    if (item.type === 'content') {
      const text = item.content?.type === 'text' ? item.content.text : item.text
      if (text) parts.push({ type: 'text', text })
      continue
    }
    if (item.type === 'diff') {
      const path = item.path ?? ''
      parts.push({ type: 'text', text: `[diff] ${path}`.trim(), path: item.path ?? undefined })
    }
  }
  return parts
}

interface ACPToolCallState {
  toolCall: AgentToolCall
  settled: boolean
  resultParts: AgentToolResultContentPart[]
}

/** Per-stream tracker mapping ACP tool_call notifications onto structured
 * externally-executed agent tool events. */
function createACPToolCallTracker(turn: number) {
  const states = new Map<string, ACPToolCallState>()

  const start = (update: ACPWireSessionUpdate): AgentTurnStreamEvent[] => {
    const id = update.toolCallId
    if (!id) return []
    const existing = states.get(id)
    if (existing) return progress(update)
    const toolCall: AgentToolCall = {
      id,
      name: update.kind || 'tool',
      arguments: safeStringify(update.rawInput ?? {}) || '{}',
      externallyExecuted: true,
    }
    const state: ACPToolCallState = { toolCall, settled: false, resultParts: [] }
    states.set(id, state)
    const events: AgentTurnStreamEvent[] = [
      { type: 'tool-call-start', turn, toolCallId: id, toolName: toolCall.name },
      { type: 'tool-call-done', turn, toolCall },
    ]
    if (update.title) {
      events.push({ type: 'tool-metadata', turn, toolCall, update: { title: update.title } })
    }
    events.push(...progressEvents(state, update))
    return events
  }

  const progress = (update: ACPWireSessionUpdate): AgentTurnStreamEvent[] => {
    const id = update.toolCallId
    if (!id) return []
    const state = states.get(id)
    // Defensive: some agents emit tool_call_update before tool_call.
    if (!state) return start({ ...update, sessionUpdate: 'tool_call' })
    if (state.settled) return []
    const events: AgentTurnStreamEvent[] = []
    if (update.title) {
      events.push({
        type: 'tool-metadata',
        turn,
        toolCall: state.toolCall,
        update: { title: update.title },
      })
    }
    events.push(...progressEvents(state, update))
    return events
  }

  const progressEvents = (
    state: ACPToolCallState,
    update: ACPWireSessionUpdate,
  ): AgentTurnStreamEvent[] => {
    const events: AgentTurnStreamEvent[] = []
    const parts = acpToolContentToParts(Array.isArray(update.content) ? update.content : undefined)
    if (parts.length > 0) {
      state.resultParts.push(...parts)
      events.push({
        type: 'tool-partial-result',
        turn,
        toolCall: state.toolCall,
        update: { content: parts },
      })
    }
    if (update.status === 'completed' || update.status === 'failed') {
      events.push(settleEvent(state, {
        failed: update.status === 'failed',
        rawOutput: update.rawOutput,
      }))
    }
    return events
  }

  const settleEvent = (
    state: ACPToolCallState,
    outcome: { failed?: boolean; aborted?: boolean; rawOutput?: unknown },
  ): AgentTurnStreamEvent => {
    state.settled = true
    const content = safeStringify(outcome.rawOutput)
      || state.resultParts.map(part => part.text ?? '').filter(Boolean).join('\n')
    const result: AgentToolResult = {
      content,
      ...(outcome.failed ? { error: content || 'Tool call failed' } : {}),
      ...(outcome.aborted ? { aborted: true, error: content || 'Tool call cancelled' } : {}),
    }
    return { type: 'tool-result', turn, toolCall: state.toolCall, result }
  }

  /** The stream is ending; every unsettled call must still reach a terminal
   * state so downstream step state machines never hang on "running". */
  const settleRemaining = (options: { aborted: boolean }): AgentTurnStreamEvent[] => {
    const events: AgentTurnStreamEvent[] = []
    for (const state of states.values()) {
      if (state.settled) continue
      events.push(settleEvent(state, { aborted: options.aborted }))
    }
    return events
  }

  return { start, progress, settleRemaining }
}

/**
 * 一条 prompt 的事件流 → 引擎回合事件。工具调用跟踪器是这一轮的局部量,
 * 流收场时把没收尾的调用一律结算掉,下游的步骤状态机才不会永远挂在「运行中」。
 */
export async function* translateACPPromptStream(
  events: AsyncIterable<ACPWireStreamEvent>,
  turn: number,
): AsyncGenerator<AgentTurnStreamEvent, void, void> {
  const tracker = createACPToolCallTracker(turn)

  for await (const event of events) {
    if (event.type === 'warning') {
      yield { type: 'reasoning-delta', turn, delta: event.message }
      continue
    }

    if (event.type === 'finish') {
      yield* tracker.settleRemaining({ aborted: event.stopReason === 'cancelled' })
      yield {
        type: 'finish',
        turn,
        finishReason: mapACPFinishReason(event.stopReason),
        usage: event.usage,
      }
      continue
    }

    const update = event.notification.update
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        {
          const text = textFromACPContent(update.content)
          if (text) yield { type: 'text-delta', turn, delta: text }
        }
        break
      case 'agent_thought_chunk':
        {
          const text = textFromACPContent(update.content)
          if (text) yield { type: 'reasoning-delta', turn, delta: text }
        }
        break
      case 'plan':
        yield { type: 'reasoning-delta', turn, delta: 'ACP plan updated.' }
        break
      case 'tool_call':
        yield* tracker.start(update)
        break
      case 'tool_call_update':
        yield* tracker.progress(update)
        break
      default:
        break
    }
  }
}

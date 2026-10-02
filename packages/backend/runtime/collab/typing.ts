/**
 * W19 真实 typing — the pure half (docs/design/multi-agent-collab-im.md §4 W19).
 *
 * 用户点题:"这种模式下,typing 应该可以改为真正的了吧"。
 *
 * Before W19 the indicator was a simulation: the queue lit it the moment an
 * activation was enqueued, so it burned through the whole thinking phase and
 * said nothing about whether words were actually being produced. Since W14b an
 * utterance IS a `say` tool call, and the streamed-tool-arguments plumbing
 * gives that call a physical duration — **the window in which `say`'s arguments
 * stream is the window in which the agent is literally typing**. That is the
 * signal this tracker turns into `collab:typing` pulses:
 *
 *   tool:input-start(say)          → true   (the first line starts arriving)
 *   tool:input-end(that call)      → false  (that line is complete)
 *   …another say…                  → true / false again (IM 短句连发 = 多脉冲)
 *   thinking / board               → nothing at all (真人思考时你也看不到 typing)
 *
 * **谁的房**(collab-send-channel-and-wake.md §4):`send_message` 合并了 `dm`
 * 之后,私聊档的调用也顶着这个工具名 —— 而打字灯挂在"这一轮在答的那间房"上。
 * 一条发给某个人的私聊在群里点亮「正在输入」,是一句关于这间房的假话。所以
 * tracker 现在**看参数**:有 `to`(私聊档)、或 `room` 显式指向别的房的调用,
 * 不在这间房亮灯。
 *
 * 参数什么时候看得见,是这件事的物理边界:`tool:input-start` 发生在参数开始流
 * 的那一刻,那时 args 还是空的。所以判据在**每一个能看见参数的时刻**生效
 * (input-start 自带参数的非流式形状、input-end、execution-start),而流式
 * provider 的私聊档仍会在参数流的那几秒里亮一下、随即熄灭 —— 与 W19 §2 已经
 * 接受的「显式 room 指向别的房」同一种残留,不是新的一类。
 *
 * Deliberately NOT here:
 *  - **timers / TTL** — the renderer already expires stale trues after 60s.
 *
 * Providers that do not stream tool arguments at all emit no input-start, so
 * their turns simply stay quiet: a missing signal degrades to the old silence,
 * never to a stuck light.
 */
import { SESSION_STREAM_TERMINAL_EVENTS } from '@shared/events/session-events.js'
import {
  isCollabSendCall,
  isCollabSendIntoRoom,
  type CollabSendArgsLike,
  type CollabTurnToolCallLike,
} from './say.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

/** Structural view of the session events the tracker reads — the fields of
 *  `tool:input-start` / `tool:input-end` / stream terminals it actually needs. */
export interface CollabTypingSignal {
  type?: string
  toolCallId?: string
  /** `tool:input-start` carries the resolved display name here. */
  toolName?: string
  /** `tool:execution-start` carries the settled arguments here. */
  args?: CollabSendArgsLike
  toolCall?: (CollabTurnToolCallLike & { id?: string; arguments?: CollabSendArgsLike }) | undefined
}

export interface CollabTypingTrackerOptions {
  /**
   * 这盏灯挂在哪间房。用来判断一次调用是不是发进**这间**房 —— 缺省(不传)时
   * 只挡得住私聊档,显式跨房的调用照亮,与合并前的行为一致。
   */
  roomSessionId?: string
}


/** Every shape a tool name can take across the event/persisted forms. */
function toolNameOf(signal: CollabTypingSignal): string | undefined {
  return signal.toolName
    || signal.toolCall?.toolName
    || signal.toolCall?.toolId
    || signal.toolCall?.name
    || undefined
}

function toolCallIdOf(signal: CollabTypingSignal): string | undefined {
  return signal.toolCallId || signal.toolCall?.id || undefined
}

/** 这一刻看得见的参数,或 undefined(参数还在流)。 */
function argsOf(signal: CollabTypingSignal): CollabSendArgsLike | undefined {
  const args = signal.args ?? signal.toolCall?.arguments
  if (!args || typeof args !== 'object') return undefined
  // 空对象 = 参数还没到(input-start 的 toolCall 就是这个形状),不是"没有 to"。
  return Object.keys(args).length > 0 ? args : undefined
}

/** Stream terminals extinguish unconditionally: no stream, nobody typing. A
 *  turn that dies mid-arguments never sends input-end, and without this the
 *  light would ride to the end of the activation window. */
const TERMINAL_TYPES: ReadonlySet<string> = new Set(SESSION_STREAM_TERMINAL_EVENTS)

export function createCollabTypingTracker(
  options: CollabTypingTrackerOptions = {},
): {
  /**
   * Feed one session event. Returns the value to emit, or `null` when this
   * event changes nothing — a second concurrent `say` does not re-light an
   * already-lit indicator, and finishing one of two does not put it out.
   */
  observe(signal: CollabTypingSignal | null | undefined): boolean | null
  /** Window closed (turn settled, observer detached). Returns `false` when the
   *  light is still on — the 兜底 that guarantees no name stays stuck typing. */
  finish(): boolean | null
  /** Is the indicator currently lit? (test/introspection) */
  readonly lit: boolean
} {
  /** Say calls whose arguments are still streaming, by toolCallId. A Set (not a
   *  boolean) because providers may stream two tool calls at once — the light
   *  belongs to the union of them, and flickering between the two would read as
   *  a stutter rather than as two messages. */
  const streaming = new Set<string>()
  let lit = false

  return {
    get lit() {
      return lit
    },

    observe(signal) {
      if (!signal?.type) return null

      if (signal.type === SESSION_EVENT_TYPES.TOOL_INPUT_START) {
        // 现名 + 退役名(`isCollabSendCall`):事件流带的是模型吐出来的原始名,
        // 一次照着旧转录写的 `say` 调用照样会把消息发出去,那盏灯就该跟着亮。
        if (!isCollabSendCall(toolNameOf(signal))) return null
        const toolCallId = toolCallIdOf(signal)
        if (!toolCallId) return null
        // 参数已经看得见(非流式 provider 的形状)且这一发不是发进这间房 ——
        // 连亮都不该亮,而不是亮完再灭。
        const args = argsOf(signal)
        if (args && !isCollabSendIntoRoom(args, options.roomSessionId)) return null
        streaming.add(toolCallId)
        if (lit) return null
        lit = true
        return true
      }

      // Arguments complete — the authoritative receive moment (input-end) or,
      // for a provider that skips it, the execution that necessarily follows.
      if (signal.type === SESSION_EVENT_TYPES.TOOL_INPUT_END || signal.type === SESSION_EVENT_TYPES.TOOL_EXECUTION_START) {
        const toolCallId = toolCallIdOf(signal)
        if (!toolCallId || !streaming.delete(toolCallId)) return null
        if (streaming.size > 0 || !lit) return null
        lit = false
        return false
      }

      if (TERMINAL_TYPES.has(signal.type)) {
        streaming.clear()
        if (!lit) return null
        lit = false
        return false
      }

      return null
    },

    finish() {
      streaming.clear()
      if (!lit) return null
      lit = false
      return false
    },
  }
}

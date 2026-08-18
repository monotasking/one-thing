/**
 * Event Envelopes
 *
 * Every event is wrapped in an envelope that adds:
 * - sessionId  — which session this event belongs to
 * - sequence   — monotonically increasing per-session counter (for replay)
 * - timestamp  — when the event was committed to the ring buffer
 *
 * The envelope is what gets stored and replayed — the inner event
 * is the domain payload.
 */

import type { SessionBusMessage } from './session-events.js'
import type { GlobalEvent } from './global-events.js'

/**
 * 载荷是 `SessionBusMessage` 而不是 `SessionEvent`,因为**只有一种信封**:
 * 总线提交的这个对象,就是 IPCBridge / SSE 原样转给渲染层的那个对象,也是
 * `?after=` 重放吐出来的那个对象。命令与事件走同一条 `emit()`,没有任何一处
 * 按 `command:` 前缀分流,所以渲染层拿到的 `envelope.event` 里确实可能是一条
 * 命令 —— 类型如实说出来,消费者才会去处理这件事,而不是被一个更窄的标注骗过。
 */
export interface SessionEventEnvelope {
  sessionId: string
  sequence: number
  timestamp: number
  event: SessionBusMessage
}

export interface GlobalEventEnvelope {
  sequence: number
  timestamp: number
  event: GlobalEvent
}

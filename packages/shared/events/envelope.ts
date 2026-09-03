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
import type { StreamChunk } from './stream-chunks.js'

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

/**
 * `session:stream` 那条推送的载荷 —— **推送面的契约,不是渲染层的私有形状**
 * (C0,`docs/design/client-sdk-2026-09.md` §4.2)。
 *
 * 底座是 `StreamChunk`,`messageId` 不在分片自己的契约里 —— 它是发出前由
 * `SessionStreamCoalescer` 盖的号(装配层的 `OutgoingStreamChunk`),老的重放
 * 数据里可能没有,所以是可选的。
 *
 * 它住在这里而不是某个壳的 `types/` 里,理由和隔壁 `SessionEventEnvelope` 一样:
 * IPCBridge 与 `GET /api/events` 的 SSE 送出去的是**同一个**对象,而现在有不止
 * 一个客户端要认它(`@onething/client` 的 `TransportEvents` 表、React 壳、Vue
 * renderer)。C2 之前 `packages/renderer/types/index.ts` 里那份同形声明还在,
 * 退役时改成从这里再导出(方案 §5.2 / §9 留账)。
 */
export type SessionStreamPayload = {
  sessionId: string
  chunk: StreamChunk & { messageId?: string }
}

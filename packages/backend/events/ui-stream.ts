/**
 * UI 事件流的**发射闸**(U0,`docs/design/ui-event-stream-2026-08.md` §3 U0 行)。
 *
 * U0 只做一件事:让 UI 侧收到的东西**与 events.jsonl 同一套词汇**,并且与旧的
 * 裸 delta 流**并行双发**。谁也不删、谁也不换管:小批走的还是那条
 * `session:stream`(桌面 IPC)/ SSE,消费者(ipc-bridge / SSE)一行不改 ——
 * 新开手写通道会当场碰红 `transport:gate`。
 *
 * ## 开关
 *
 * `ONETHING_UI_STREAM = legacy(默认)| events`
 *
 * - `legacy`:UI 事件**一条都不出生**(renderer 零感知,IPC 流量不变);
 * - `events`:双发 —— 旧 chunk 照旧,外加同名同形的 `assistant/delta` →
 *   coalescer 合成 `assistant/chunks` + `assistant/part-end`。
 *
 * 每次读环境变量而不是启动时定死:与 `ONETHING_SESSION_SHADOW` 同一条路数,
 * 测试可以就地改档,不必重开进程。
 */

import type { UiAssistantDeltaChunk, UiAssistantPartEndChunk } from '@onething/core/events'
import { getStreamChannel } from './index.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('engine.stream.ui')

export type OnethingUiStreamMode = 'legacy' | 'events'

export function onethingUiStreamMode(): OnethingUiStreamMode {
  return process.env.ONETHING_UI_STREAM === 'events' ? 'events' : 'legacy'
}

export function isUiEventStreamEnabled(): boolean {
  return onethingUiStreamMode() === 'events'
}

/** UI 事件流上的**源头**那两条(小批由 coalescer 合)。 */
export type SessionUiStreamSourceEvent = UiAssistantDeltaChunk | UiAssistantPartEndChunk

/**
 * 把一条已盖章的 UI 事件推上流管。
 *
 * 与采集点同一条纪律:**发不出去绝不打断聊天**。事件系统没初始化(测试)、
 * 通道抛异常,都只留一行 debug。
 */
export function pushSessionUiStreamEvent(
  sessionId: string,
  event: SessionUiStreamSourceEvent,
): void {
  if (!isUiEventStreamEnabled()) return
  try {
    getStreamChannel().push(sessionId, event)
  } catch (error) {
    log.debug('ui stream push failed', { sessionId, type: event.type }, error)
  }
}

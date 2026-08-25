/**
 * Stream Chunk Types
 *
 * High-frequency, low-latency chunks that flow through StreamChannel.
 * These are the hot-path data: text and reasoning deltas that arrive
 * many times per second during streaming.
 *
 * Separated from session events because they need different delivery
 * semantics: StreamChannel provides fan-out, while EventBus provides
 * ordered, replayable delivery.
 */

import type { StreamChunkBase } from './types.js'

export interface TextDeltaChunk extends StreamChunkBase {
  type: 'text-delta'
  text: string
  turnIndex?: number
  voiceSpeakText?: string
}

export type ReasoningPlacement = 'top' | 'inline'

export interface ReasoningDeltaChunk extends StreamChunkBase {
  type: 'reasoning-delta'
  reasoning: string
  turnIndex?: number
  placement?: ReasoningPlacement
}

export interface ToolInputDeltaChunk extends StreamChunkBase {
  type: 'tool-input-delta'
  toolCallId: string
  argsTextDelta: string
}

// ── U0:UI 事件流(`docs/design/ui-event-stream-2026-08.md`)────────────────
//
// 与 `events.jsonl` **同名同形**的那套词汇(拍板 U-a),只是投递节奏不同
// (16ms 小批 vs 2s 攒批)。它与上面那三条裸 delta **并行双发**,由
// `ONETHING_UI_STREAM=legacy(默认)|events` 决定发不发 —— U2 之前 renderer
// 一格都不读,默认档下这几条根本不出生。
//
// 为什么走 StreamChunk 这条管而不是新开一条:管子不变、消费者(ipc-bridge /
// SSE)不变是 U0 的硬约束(§2 表最后一行),新开手写通道会当场碰红
// `transport:gate`。

/** 段身份的三格(与 `SessionAssistantDeltaPartKind` 同一张表)。 */
export type UiAssistantPartKind = 'text' | 'reasoning' | 'tool-input'

/** 一条**已盖章**的 delta:段身份在源头判定一次(core part-boundary 状态机)。 */
export interface UiAssistantDeltaChunk extends StreamChunkBase {
  type: 'assistant/delta'
  runId: string
  requestIndex: number
  messageId: string
  partIndex: number
  kind: UiAssistantPartKind
  toolCallId?: string
  toolName?: string
  turnIndex?: number
  text: string
}

/** coalescer 16ms 合出来的小批(落盘那条是 2s/64,同名同形)。 */
export interface UiAssistantChunksChunk extends StreamChunkBase {
  type: 'assistant/chunks'
  runId: string
  requestIndex: number
  messageId: string
  partIndex: number
  kind: UiAssistantPartKind
  toolCallId?: string
  toolName?: string
  turnIndex?: number
  text: string[]
}

/** 一段收齐了(边界与落盘那份逐一致 —— 同一台状态机判的)。 */
export interface UiAssistantPartEndChunk extends StreamChunkBase {
  type: 'assistant/part-end'
  runId: string
  requestIndex: number
  messageId: string
  partIndex: number
  kind: UiAssistantPartKind
  toolCallId?: string
  toolName?: string
  turnIndex?: number
  len: number
  hash: string
}

/** UI 事件流上跑的那几条(源头 `assistant/delta`,合帧后 `assistant/chunks`)。 */
export type UiStreamChunk =
  | UiAssistantDeltaChunk
  | UiAssistantChunksChunk
  | UiAssistantPartEndChunk

export type StreamChunk =
  | TextDeltaChunk
  | ReasoningDeltaChunk
  | ToolInputDeltaChunk
  | UiStreamChunk

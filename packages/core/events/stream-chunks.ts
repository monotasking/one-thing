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

/**
 * 一条裸 delta 的**账本身份章**(R 线 R1,`apps/desktop-react/docs/stream-render-2026-09.md`)。
 *
 * ── 它是什么 ──────────────────────────────────────────────────────────
 * 「这条 delta 是**账本哪一段的第几个字符起**的那一截」。有了它,活流与账本不再是
 * 两份需要对账的内容,而是**同一个字符串的两个前缀**(前缀定律),渲染长度 =
 * `max(账本长度, 活水位)`——「同一截只画一次」「只长不缩」从**结构**上恒成立,
 * 不再靠壳侧那套会漂的记账(六轮事故的宿主)。
 *
 * ── 唯一产地(审查条 2)────────────────────────────────────────────────
 * 章由**引擎侧给打包行编 partIndex 的那同一台机器**铸:
 * `session/events/chunk-codec.ts` 的段边界状态机 + 编码器的 `onDelta` 回吐口,
 * `charOffset` 取的正是 part-end 的 `len` 所用的那份累计。**两处各编一套 = 把
 * 「对不上」搬到后端重演**,所以合批器只搬运、不编号。
 *
 * ── 字段 ──────────────────────────────────────────────────────────────
 * `charOffset` 按 **UTF-16 码元**数(与 `String.length` / part-end 的 `len` 同一把尺;
 * 渲染边界向字素边界收一格是消费侧的事,见审查条 6)。
 * `gen` 是换代号(审查条 1:追加是常态,改写是换代)——**R1 恒 0**,占位,
 * 语义在 R2 之后接上。
 */
export interface StreamDeltaStamp {
  messageId: string
  runId: string
  requestIndex: number
  partIndex: number
  kind: UiAssistantPartKind
  /** 这条 delta 的第一个字符在这一段里的偏移(UTF-16 码元)。 */
  charOffset: number
  /** 换代号。R1 恒 0。 */
  gen: number
}

export interface TextDeltaChunk extends StreamChunkBase {
  type: 'text-delta'
  text: string
  turnIndex?: number
  voiceSpeakText?: string
  /** 账本身份章(R1 加性字段;老消费者不读,行为逐字不变)。 */
  stamp?: StreamDeltaStamp
}

export type ReasoningPlacement = 'top' | 'inline'

export interface ReasoningDeltaChunk extends StreamChunkBase {
  type: 'reasoning-delta'
  reasoning: string
  turnIndex?: number
  placement?: ReasoningPlacement
  /** 账本身份章(R1 加性字段)。 */
  stamp?: StreamDeltaStamp
}

export interface ToolInputDeltaChunk extends StreamChunkBase {
  type: 'tool-input-delta'
  toolCallId: string
  argsTextDelta: string
  /** 账本身份章(R1 加性字段)。 */
  stamp?: StreamDeltaStamp
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

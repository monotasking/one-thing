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
  /**
   * 开这一段时引擎的**回合号**(`CoreAgentLoopExecutorState.turnIndex` 的镜像)。
   *
   * ── 为什么不能用上面那个 `requestIndex` 代替(09-02 真机回归的根因)────────
   * 两个是**不同的计数器**:`requestIndex` 在 `turn-start` 上发号(一次请求一个),
   * 而引擎的回合号还会在每一条 tool-calls finish 上 +1。工具锚点
   * (`data-steps{turnIndex}`)排的是**回合号**,所以壳拿 `requestIndex` 排不出来。
   *
   * 少了这一格的后果不是「排得不够准」,是**排反**:壳把活水位那一段插进
   * contentParts 时说不出它属于哪一回合,`partTurn` 按 `?? 0` 兜底,
   * `insertDataStepsByTurn` 于是判定「所有锚点的回合都大于这一段」,把整批工具
   * **挂到了它后面** —— 屏幕上就是「新推理在上、已经做完的工具在下」。
   * 真机读数(无正文的多请求素材,6 字/帧):新推理 321/383 帧排在所有工具之前,
   * 直到账本物化才跳回正确位置。
   *
   * 可选是**加性字段**的纪律(R1):没盖这一格的旧路 / 旁路照旧,壳拿不到就退回
   * 从前的行为(账本的座位说了算)。
   */
  turnIndex?: number
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

/**
 * **工具进度活流**(C2-b,`apps/desktop-react/docs/workbench-2026-09.md` §6.2 表
 * 「执行中」列 / §6.3 / §6.6)。一次调用**执行中**的过程读数:输出尾行、比例、
 * 一句话。
 *
 * ── 只走 StreamChannel,无账本投影 ──────────────────────────────────────
 * 这条 chunk **不进 `events.jsonl`**,也不进 `session.messages`:账本记的是会话的
 * **事实**(这次调用发生了、参数是什么、结局如何),而进度是**过程读数** ——
 * 重开会话时只该看见结局,不该看见「当时跑到第 7 行」。三定律因此一格不动:
 * 账本仍是唯一真相,投影从账本折出来,而这条 chunk 从不参与折叠
 * (`Session.applyChunk` 里显式写着一条什么都不做的 `case`,不是漏了)。
 *
 * ── 快照,不是追加 ─────────────────────────────────────────────────────
 * 同一个 `toolCallId` 后来的一条**整条替换**前一条(last-wins),所以它不进 16ms
 * 合批器那个按追加语义攒的缓冲,走直送。产地自己带节拍(bash 的输出快照 100ms
 * 一次),不靠合批器省流量。
 *
 * ── 字段 ───────────────────────────────────────────────────────────────
 * 三格全是可选:工具报得出哪格就报哪格,一格都报不出就别发这条
 * (`ratio` ∈ [0,1],不知道**别编** —— 假进度条比没有更糟)。
 */
export interface ToolProgressChunk extends StreamChunkBase {
  type: 'tool-progress'
  toolCallId: string
  /** 一句话:此刻在干什么(bash 是命令、web_open 是「正在打开 …」)。 */
  message?: string
  /** 已完成比例 ∈ [0,1]。算不出就缺席。 */
  ratio?: number
  /** 此刻最后几行给人看的输出(整段替换,不追加)。 */
  outputTail?: string
}

export type StreamChunk =
  | TextDeltaChunk
  | ReasoningDeltaChunk
  | ToolInputDeltaChunk
  | ToolProgressChunk
  | UiStreamChunk

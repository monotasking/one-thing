import type { StreamDeltaStamp } from '@shared/events/index.js'

/**
 * **账本身份章的交接台**(R 线 R1,`apps/desktop-react/docs/stream-render-2026-09.md`)。
 *
 * ── 为什么需要一张台子 ────────────────────────────────────────────────
 * 章的唯一产地是**引擎侧给打包行编号的那台机器**(`chunk-codec` 的段边界状态机 +
 * 编码器的 `onDelta`),而裸 delta 是**另一条出口**发的(`event-only-emitter` 的
 * `sendTextChunk` 等)。审查条 2 定死了「两处各编一套 = 把对不上搬到后端重演」,
 * 所以裸 delta 那条路**不许自己编号**,只能来取。
 *
 * ── 凭什么取得到:那是一个同步点,不是时序 hack ────────────────────────
 * `attachSessionEventRecorder` 把 runtime 的 `onEvent` 包成
 * 「**先** `recorder.handle(event)`、**再** 原来的 `onEvent(event)`」——
 * 同一条 agent-loop 事件,记录器先铸章、执行器后发裸 delta,中间**没有 await、
 * 没有别的事件**。这条次序是那个包装器自己立的规矩,不是巧合,所以台面上放的
 * 永远是「刚刚这一条」。
 *
 * ── 拿错了怎么办:对不上就不给 ────────────────────────────────────────
 * 台子按 `(kind, 这条 delta 的原文)` 认领。没走过记录器的正文(重放、生图这类
 * 旁路直接调 `sendTextChunk`)认领不到,拿到 `undefined` —— 老行为逐字不变。
 * **宁可缺一枚章,不肯盖一枚错的**:错章会让水位表把一段正文写到别的段里去,
 * 那正是 R 线要根除的那一类事故。
 *
 * ── 按会话持有(审查条 4)──────────────────────────────────────────────
 * 一个进程同时跑多条会话是常态(多开 / Dock 活预览 / 后台子代理),台子因此按
 * `sessionId` 分格。取走即清:一枚章只认领一次。
 */

interface StampSlot {
  kind: 'text' | 'reasoning' | 'tool-input'
  text: string
  toolCallId?: string
  stamp: StreamDeltaStamp
}

const slots = new Map<string, StampSlot>()

/** 记录器铸好一枚章,放上台面(下一条裸 delta 来取)。 */
export function offerDeltaStamp(sessionId: string, slot: StampSlot): void {
  slots.set(sessionId, slot)
}

/**
 * 裸 delta 来认领。**对得上才给,给完就清**。
 *
 * `toolCallId` 只在 `tool-input` 那一路参与比对:另两路没有这一格。
 */
export function claimDeltaStamp(
  sessionId: string,
  kind: 'text' | 'reasoning' | 'tool-input',
  text: string,
  toolCallId?: string,
): StreamDeltaStamp | undefined {
  const slot = slots.get(sessionId)
  if (!slot) return undefined
  if (slot.kind !== kind || slot.text !== text) return undefined
  if (kind === 'tool-input' && slot.toolCallId !== toolCallId) return undefined
  slots.delete(sessionId)
  return slot.stamp
}

/** 会话散场:把台面收了(测试与会话结束都用它)。 */
export function clearDeltaStamps(sessionId?: string): void {
  if (sessionId === undefined) slots.clear()
  else slots.delete(sessionId)
}

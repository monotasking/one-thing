/**
 * `scratchpad:*` 事件族进联合的**穷尽守卫**(草稿纸 P1)。
 *
 * 与 `interaction-events.test.ts` 同一条纪律,盯的是同一个失败模式:一个新事件
 * 被定义出来、发射点也写了,却**忘了进联合** —— 那样它在 `SessionEvent` 上不
 * 可达,IPCBridge 与 SSE 的分发里没有它,而 typecheck 一声不吭。症状是「后端
 * 明明发了,前端什么都没收到」。
 *
 * 两个方向都查:只查一个方向的话,**删掉**一个字段可以悄悄溜过去,而删字段
 * 正是最会让下游静默出错的那一类改动 —— 少了 `version`,水位线就永远画在 0。
 */
import { describe, expect, it } from 'vitest'

import type { ScratchpadConsumedEvent, SessionEvent } from '../session-events.js'

/* ── 事件族全表 ─────────────────────────────────────────────────────────── */

const SCRATCHPAD_EVENT_TYPES = [
  'scratchpad:consumed',
] as const satisfies readonly Extract<SessionEvent['type'], `scratchpad:${string}`>[]

type ScratchpadEventMissing = Exclude<
  Extract<SessionEvent['type'], `scratchpad:${string}`>,
  (typeof SCRATCHPAD_EVENT_TYPES)[number]
>
type ScratchpadEventStray = Exclude<
  (typeof SCRATCHPAD_EVENT_TYPES)[number],
  Extract<SessionEvent['type'], `scratchpad:${string}`>
>
const SCRATCHPAD_EVENTS_ARE_EXHAUSTIVE: [ScratchpadEventMissing] extends [never]
  ? [ScratchpadEventStray] extends [never]
    ? true
    : never
  : never = true

/* ── 事件本体的字段表 ───────────────────────────────────────────────────── */

const CONSUMED_FIELDS = ['type', 'version', 'turn'] as const satisfies
  readonly (keyof ScratchpadConsumedEvent)[]
type ConsumedMissing = Exclude<keyof ScratchpadConsumedEvent, (typeof CONSUMED_FIELDS)[number]>
type ConsumedStray = Exclude<(typeof CONSUMED_FIELDS)[number], keyof ScratchpadConsumedEvent>
const CONSUMED_IS_EXHAUSTIVE: [ConsumedMissing] extends [never]
  ? [ConsumedStray] extends [never]
    ? true
    : never
  : never = true

describe('scratchpad events', () => {
  it('scratchpad:* 全在 SessionEvent 联合里', () => {
    expect(SCRATCHPAD_EVENTS_ARE_EXHAUSTIVE).toBe(true)
    expect(SCRATCHPAD_EVENT_TYPES).toContain('scratchpad:consumed')
  })

  it('ScratchpadConsumedEvent 的字段表与类型逐字对齐', () => {
    expect(CONSUMED_IS_EXHAUSTIVE).toBe(true)
    expect([...CONSUMED_FIELDS]).toEqual(['type', 'version', 'turn'])
    // 一个真实形状能被当作 SessionEvent 收下 —— 分发端拿到的就是这个。
    const event: SessionEvent = { type: 'scratchpad:consumed', version: 1712, turn: 3 }
    expect(event).toEqual({ type: 'scratchpad:consumed', version: 1712, turn: 3 })
  })
})

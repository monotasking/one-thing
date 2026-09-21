import { describe, expect, it } from 'vitest'
import { AnchorRecorder, FakeTimers } from '../anchor-recorder'
import type { ScrollAnchor } from '../../../data/session-view-state'

/** `AnchorRecorder` 的去抖与两条守卫(G 线 P2-a)。零 DOM:量与守卫都由假函数答。 */

function setup(options?: { hasLayout?: boolean; anchor?: ScrollAnchor | undefined }) {
  const state = { hasLayout: options?.hasLayout ?? true, anchor: options?.anchor ?? ('bottom' as ScrollAnchor) }
  const saved: { sessionId: string; anchor: ScrollAnchor | undefined }[] = []
  let measures = 0
  const timers = new FakeTimers()
  const recorder = new AnchorRecorder({
    hasLayout: () => state.hasLayout,
    measure: () => {
      measures += 1
      return state.anchor
    },
    save: (sessionId, anchor) => void saved.push({ sessionId, anchor }),
    settleMs: 120,
    timers,
  })
  return { recorder, timers, saved, state, measures: () => measures }
}

describe('去抖:连滚一百下只在停下来那一次量', () => {
  it('连排十发,只开火一次', () => {
    const { recorder, timers, saved, measures } = setup()
    for (let i = 0; i < 10; i += 1) {
      recorder.schedule('s1')
      timers.advance(10)
    }
    expect(saved).toEqual([])
    timers.advance(120)
    expect(saved).toEqual([{ sessionId: 's1', anchor: 'bottom' }])
    expect(measures()).toBe(1)
  })

  it('没到点之前一个字都不量(`measure` 一次都没被调)', () => {
    const { recorder, timers, measures } = setup()
    recorder.schedule('s1')
    timers.advance(119)
    expect(measures()).toBe(0)
    expect(recorder.pending).toBe(true)
  })
})

describe('两条守卫各管各的', () => {
  it('去抖那一发**带**停靠守卫:没有排版就不写(「离底 0」是假的)', () => {
    const { recorder, timers, saved, state, measures } = setup()
    recorder.schedule('s1')
    state.hasLayout = false
    timers.advance(120)
    expect(saved).toEqual([])
    expect(measures()).toBe(0)
  })

  it('`saveNow()` **不带**:量不到照旧交 undefined,由量的那一头如实作答', () => {
    const { recorder, saved, state } = setup({ hasLayout: false })
    state.anchor = undefined
    recorder.saveNow('s1')
    expect(saved).toEqual([{ sessionId: 's1', anchor: undefined }])
  })
})

describe('跨会话', () => {
  it('还没到点那一发**不许跨会话开火** —— `cancel()` 之后一个字都不写', () => {
    const { recorder, timers, saved } = setup()
    recorder.schedule('s1')
    recorder.cancel()
    expect(recorder.pending).toBe(false)
    timers.advance(1000)
    expect(saved).toEqual([])
  })

  it('那一发记的是**排它时**那条会话的 id,不是到点时的', () => {
    const { recorder, timers, saved } = setup()
    recorder.schedule('s1')
    timers.advance(60)
    recorder.schedule('s2')
    timers.advance(120)
    expect(saved).toEqual([{ sessionId: 's2', anchor: 'bottom' }])
  })
})

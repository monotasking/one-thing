/**
 * `content/tail-snap.ts` 的算术(纯函数,零 DOM)。
 *
 * 真机那一半在 `scripts/gate-send-flow.mjs` 的 ④ 上(治前长回那一档 30 次方向反转,
 * 治后 0);这里钉的是**这只函数说了什么**:落点落在格子上、认下之后抖动摆不动它、
 * 真挪了窝当场重认、推的方向永远向上。
 */
import { describe, expect, it } from 'vitest'

import {
  devicePixelSize,
  resolveTailSnap,
  TAIL_SNAP_REACQUIRE_DEVICE_PX,
} from '../tail-snap'

const DP2 = devicePixelSize(2)

describe('devicePixelSize', () => {
  it('一个设备像素 = 1 / dpr;dpr 不可信时按 1 算', () => {
    expect(devicePixelSize(2)).toBe(0.5)
    expect(devicePixelSize(1)).toBe(1)
    expect(devicePixelSize(3)).toBeCloseTo(1 / 3, 10)
    expect(devicePixelSize(0)).toBe(1)
  })
})

describe('resolveTailSnap', () => {
  it('第一次:认一个设备像素格上的落点,推的量向上且在两个设备像素以内', () => {
    const { held, nudge, reacquired } = resolveTailSnap({
      bottom: 632.188,
      applied: 0,
      held: undefined,
      devicePx: DP2,
    })
    expect(reacquired).toBe(true)
    // 632.188 → floor 到 632.0 再让出一格 → 631.5
    expect(held).toBeCloseTo(631.5, 10)
    expect(nudge).toBeCloseTo(-0.688, 3)
    expect(632.188 + nudge).toBeCloseTo(held, 10)
  })

  it('认下之后,内容每长一截带来的亚像素残值一格都摆不动它', () => {
    // 真机量到的那一串(治前的 `内容列下缘`,残值在 ±0.25 之间游走)
    const naturals = [632.188, 632.078, 632.164, 631.938, 632.25, 632.0]
    let held: number | undefined
    let applied = 0
    const landed: number[] = []
    for (const natural of naturals) {
      const snap = resolveTailSnap({ bottom: natural + applied, applied, held, devicePx: DP2 })
      held = snap.held
      applied = snap.nudge
      landed.push(natural + snap.nudge)
    }
    // 落点逐字相同 —— 「读数行在内容长高时位置不变」那条判据的算术形
    expect(new Set(landed.map((v) => v.toFixed(6))).size).toBe(1)
    expect(landed.every((v) => Math.abs(v - landed[0]) < 1e-9)).toBe(true)
  })

  it('推的量永远 ≤ 0(只往上推:往下推会把滚动范围撑大,那是一条会自激的路)', () => {
    let held: number | undefined
    let applied = 0
    for (let i = 0; i < 200; i += 1) {
      // 在一个设备像素宽的区间里来回摆,与真机残值同形
      const natural = 632 + ((i * 7) % 5) * 0.125 - 0.25
      const snap = resolveTailSnap({ bottom: natural + applied, applied, held, devicePx: DP2 })
      expect(snap.nudge).toBeLessThanOrEqual(0)
      held = snap.held
      applied = snap.nudge
    }
  })

  it('真挪了窝(输入框长一行 / 窗子变高)当场重认,不被上一格落点拖住', () => {
    const first = resolveTailSnap({ bottom: 632.2, applied: 0, held: undefined, devicePx: DP2 })
    const moved = resolveTailSnap({
      bottom: 612.2 + first.nudge,
      applied: first.nudge,
      held: first.held,
      devicePx: DP2,
    })
    expect(moved.reacquired).toBe(true)
    expect(moved.held).toBeCloseTo(611.5, 10)
  })

  it('落点仍在自然位置上方时,门槛以内的变化保留落点', () => {
    const first = resolveTailSnap({ bottom: 632.2, applied: 0, held: undefined, devicePx: DP2 })
    const withinBand = TAIL_SNAP_REACQUIRE_DEVICE_PX * DP2 - 0.2
    const inside = resolveTailSnap({
      bottom: first.held + withinBand + first.nudge,
      applied: first.nudge,
      held: first.held,
      devicePx: DP2,
    })
    expect(inside.reacquired).toBe(false)
    expect(inside.held).toBe(first.held)
  })

  it('内容缩短越过原落点时重新对齐,不能用正补偿撑大滚动范围', () => {
    let held: number | undefined
    let applied = 0
    for (const natural of [632.2, 631.3, 632.2]) {
      const snap = resolveTailSnap({ bottom: natural + applied, applied, held, devicePx: DP2 })
      expect(snap.nudge).toBeLessThanOrEqual(0)
      expect(snap.held).toBeLessThanOrEqual(natural)
      expect(natural + snap.nudge).toBeCloseTo(snap.held, 10)
      if (held !== undefined && natural < held) expect(snap.reacquired).toBe(true)
      held = snap.held
      applied = snap.nudge
    }
  })

  it('dpr 1 上落点落在整像素上(格子换了,判词没换)', () => {
    const snap = resolveTailSnap({ bottom: 632.6, applied: 0, held: undefined, devicePx: 1 })
    expect(snap.held).toBe(631)
    expect(snap.nudge).toBeCloseTo(-1.6, 10)
  })
})

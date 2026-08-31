import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHoverIntent } from '../hover-intent'
import type { HoverAimProbe } from '../hover-intent'

/**
 * 悬停意图的状态机。这只件不认识 Dock,也不读 DOM —— 所以它整只可以用假时钟跑。
 *
 * 被试的三个数照 Dock 的真配方(motion.ts):延迟 600 / 宽限 320 / 瞄准窗口 400。
 * 几何由假探针注入:**x < 500 就算在瞄准区里**,`to.y < from.y` 算朝目标推进。
 * 这样几何与时序两件事各自可测,不必在这里再摆一遍三角形(那一半的用例在
 * stage/transitions.test.ts,连真机坐标一起)。
 */
const DELAY = 600
const GRACE = 320
const WINDOW = 400

interface FakeAim {
  armedAt: { x: number; y: number }
}

/** 只在「朝上走」时武装;之后 x < 500 算还在区里。 */
const probe: HoverAimProbe<FakeAim> = {
  arm: (from, to) => (to.y < from.y ? { armedAt: to } : null),
  track: (_aim, from, to) => ({ inside: to.x < 500, progressed: to.y < from.y }),
}

function harness(withAim = true) {
  const seen: Array<string | null> = []
  const intent = createHoverIntent<FakeAim>({
    delayMs: DELAY,
    graceMs: GRACE,
    aimWindowMs: WINDOW,
    aim: withAim ? probe : undefined,
    onChange: (id) => seen.push(id),
  })
  const open = () => (seen.length ? seen[seen.length - 1] : null)
  return { intent, seen, open }
}

/** 走一步:先报 move(状态机靠它算方向),顺序与浏览器一致(leave/enter 先于 move)。 */
function step(intent: ReturnType<typeof harness>['intent'], x: number, y: number) {
  intent.move({ x, y })
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('① 延迟出 / ② 宽限收(既有手感,不许回退)', () => {
  it('悬停够 delayMs 才出;擦过去的不算', () => {
    const { intent, open } = harness()
    intent.enter('a')
    vi.advanceTimersByTime(DELAY - 1)
    expect(open()).toBe(null)
    vi.advanceTimersByTime(1)
    expect(open()).toBe('a')
  })

  it('擦过去(不到 delayMs 就离开)一个泡都不开', () => {
    const { intent, seen } = harness()
    intent.enter('a')
    vi.advanceTimersByTime(100)
    intent.leave('a')
    vi.advanceTimersByTime(DELAY * 2)
    expect(seen).toEqual([])
  })

  it('离开之后缓 graceMs 才收;再进即取消(缝里那一段路)', () => {
    const { intent, open } = harness()
    intent.enter('a')
    vi.advanceTimersByTime(DELAY)
    // 横着走出去 = 不武装瞄准区,走的是宽限那条路
    step(intent, 100, 100)
    step(intent, 200, 100)
    intent.leave('a')
    vi.advanceTimersByTime(GRACE - 1)
    expect(open()).toBe('a')
    intent.enter('a')
    vi.advanceTimersByTime(GRACE * 2)
    expect(open()).toBe('a')
  })
})

describe('③ 瞄准区:途经旁人不重定目标(09-01 报障)', () => {
  it('报障复现的那条路:离开主角后途经旁人,主角一格不动、也不空窗', () => {
    const { intent, seen } = harness()
    intent.enter('a')
    vi.advanceTimersByTime(DELAY)
    expect(seen).toEqual(['a'])

    // 朝目标走(y 变小)→ 离开 a → 武装
    step(intent, 300, 200)
    step(intent, 290, 180)
    intent.leave('a')
    expect(intent.isAiming()).toBe(true)

    // 途经旁人 b:它不许接手
    intent.enter('b')
    for (let i = 0; i < 6; i++) step(intent, 280 - i * 10, 170 - i * 10)
    vi.advanceTimersByTime(DELAY * 2)

    // 修前这里会是 ['a', null, 'b'](先空窗再换人);修后一格没动。
    expect(seen).toEqual(['a'])
    expect(intent.isAiming()).toBe(true)
  })

  it('进到目标里(浮层是触发件的后代 → 同一个 id)即解除瞄准并转为常驻', () => {
    const { intent, seen } = harness()
    intent.enter('a')
    vi.advanceTimersByTime(DELAY)
    step(intent, 300, 200)
    step(intent, 290, 180)
    intent.leave('a')
    intent.enter('b')
    step(intent, 280, 160)
    intent.leave('b')
    intent.enter('a') // 到了泡上
    expect(intent.isAiming()).toBe(false)
    vi.advanceTimersByTime(GRACE * 3)
    expect(seen).toEqual(['a'])
  })

  it('出了瞄准区就恢复常态:此刻压着谁,谁按自己的延迟接手(不空窗)', () => {
    const { intent, seen } = harness()
    intent.enter('a')
    vi.advanceTimersByTime(DELAY)
    step(intent, 300, 200)
    step(intent, 290, 180)
    intent.leave('a')
    intent.enter('b')
    step(intent, 600, 160) // x ≥ 500 = 出区
    expect(intent.isAiming()).toBe(false)
    vi.advanceTimersByTime(DELAY - 1)
    expect(seen).toEqual(['a'])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['a', 'b'])
  })

  it('窗口量的是**停顿**不是飞行总时长:一路推进多久都不会被切断', () => {
    const { intent, seen } = harness()
    intent.enter('a')
    vi.advanceTimersByTime(DELAY)
    step(intent, 300, 400)
    step(intent, 300, 390)
    intent.leave('a')
    intent.enter('b')
    // 每步 300ms(< 窗口)但总计 3000ms(≫ 窗口),一路朝目标推进
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(300)
      step(intent, 300, 380 - i * 10)
    }
    expect(intent.isAiming()).toBe(true)
    expect(seen).toEqual(['a'])
  })

  it('停在瞄准区里不动超过窗口 = 不瞄了,常态恢复', () => {
    const { intent, seen } = harness()
    intent.enter('a')
    vi.advanceTimersByTime(DELAY)
    step(intent, 300, 400)
    step(intent, 300, 390)
    intent.leave('a')
    intent.enter('b')
    vi.advanceTimersByTime(WINDOW + 1)
    step(intent, 300, 390) // 原地(没推进)
    expect(intent.isAiming()).toBe(false)
    // 解除之后走的是同一条交接规则:此刻压着 b,就等 b 自己的延迟,中间不空窗。
    vi.advanceTimersByTime(DELAY - 1)
    expect(seen).toEqual(['a'])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['a', 'b'])
  })

  it('边界①:横着离开(没有朝目标的分量)根本不武装 —— 巡瓦保持即时切换', () => {
    const { intent, seen } = harness()
    intent.enter('a')
    vi.advanceTimersByTime(DELAY)
    step(intent, 300, 200)
    step(intent, 320, 200) // 纯横移
    intent.leave('a')
    expect(intent.isAiming()).toBe(false)
    intent.enter('b')
    // 切换延迟一格没变(仍是 b 自己的 delayMs);**改的只有中间那段空窗**:
    // 修前 a 在 graceMs(320)就自己没了,离 b 接手还差 280ms —— 那 280ms 谁都不在。
    vi.advanceTimersByTime(DELAY - 1)
    expect(seen).toEqual(['a'])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['a', 'b'])
  })

  it('指针停在缝里(不压着任何触发件)才排收拢 —— 那时确实没人可交接', () => {
    const { intent, seen } = harness()
    intent.enter('a')
    vi.advanceTimersByTime(DELAY)
    step(intent, 300, 200)
    step(intent, 320, 200)
    intent.leave('a')
    vi.advanceTimersByTime(GRACE)
    expect(seen).toEqual(['a', null])
  })

  it('没有开着的主角时,离开谁都不武装(瞄准区没有主语)', () => {
    const { intent } = harness()
    intent.enter('a')
    step(intent, 300, 200)
    step(intent, 300, 180)
    intent.leave('a') // a 的泡还没开出来
    expect(intent.isAiming()).toBe(false)
  })

  it('没有注入探针时退回两段式 —— 基础件不替消费方编一块几何', () => {
    const { intent, seen } = harness(false)
    intent.enter('a')
    vi.advanceTimersByTime(DELAY)
    step(intent, 300, 200)
    step(intent, 300, 180)
    intent.leave('a')
    expect(intent.isAiming()).toBe(false)
    vi.advanceTimersByTime(GRACE)
    expect(seen).toEqual(['a', null])
  })
})

describe('收场', () => {
  it('指针整个离开这一片:瞄准解除,按宽限收', () => {
    const { intent, seen } = harness()
    intent.enter('a')
    vi.advanceTimersByTime(DELAY)
    step(intent, 300, 200)
    step(intent, 300, 180)
    intent.leave('a')
    intent.cancel()
    expect(intent.isAiming()).toBe(false)
    vi.advanceTimersByTime(GRACE)
    expect(seen).toEqual(['a', null])
  })

  it('dispose 之后在飞的计时器一个都不许再响', () => {
    const { intent, seen } = harness()
    intent.enter('a')
    intent.dispose()
    vi.advanceTimersByTime(DELAY * 3)
    expect(seen).toEqual([])
  })
})

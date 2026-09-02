import { describe, expect, it } from 'vitest'
import {
  damperStep,
  dockRestCenters,
  GROWTH_BIAS,
  magnifyAt,
  magnifyLayout,
  MAX_GROW,
  RADIUS,
} from '../dock-magnify'
import type { DockRestLayout } from '../dock-magnify'
import { MAGNIFY_TAU_MS, RELEASE_MS } from '../motion'

/** 静止几何:五块瓷砖,间距 53(44 瓦 + 9 缝),第一块中心在 22。 */
const centers = [22, 75, 128, 181, 234]

/** 与上面那五个中心一致的静止坐标系(anchor = 第一块的左缘)。 */
const rest = (over: Partial<DockRestLayout> = {}): DockRestLayout => ({
  anchor: 0,
  tileSize: 44,
  gap: 9,
  count: 5,
  sepAfter: -1,
  sepSize: 1,
  growthBias: GROWTH_BIAS.center,
  ...over,
})

describe('magnifyAt(纯几何:布局尺寸系数)', () => {
  it('指针压着中心 = 顶格 1.35;半径外 = 原尺寸 1', () => {
    const f = magnifyAt(128, centers)
    expect(f[2]).toBeCloseTo(1.35, 5)
    expect(f[0]).toBe(1) // 距离 106 > 96
    expect(f[4]).toBe(1)
  })

  it('按距离单调衰减且左右对称', () => {
    const f = magnifyAt(128, centers)
    expect(f[1]).toBeGreaterThan(f[0])
    expect(f[2]).toBeGreaterThan(f[1])
    expect(f[1]).toBeCloseTo(f[3], 5)
  })

  it('系数恒 ≥ 1,且各瓦不同(六心叠一点的 offsetLeft 坑会让全员相等,衰减存在性是它的反证)', () => {
    const f = magnifyAt(22, centers)
    expect(f.every((v) => v >= 1)).toBe(true)
    expect(new Set(f.map((v) => v.toFixed(4))).size).toBeGreaterThan(1)
  })

  it('竖轴同一套几何:Dock 停左/右边时喂的是 clientY 与各瓦纵向中心,结果逐条相同', () => {
    // 同样的五个中心,这次它们是 y 坐标 —— magnifyAt 算的是一维距离,不是横向距离,
    // 所以轴向只改「量哪个坐标」(useMagnify 的事),纯函数一个字都不用变。
    const byY = magnifyAt(128, centers)
    expect(byY[2]).toBeCloseTo(1.35, 5)
    expect(byY[0]).toBe(1)
    expect(byY[1]).toBeCloseTo(byY[3], 5)
  })

  it('试衣间那三个数没被人动过(08-29 拍定:R=96 / Smax=1.35 / 余弦钟形)', () => {
    expect(RADIUS).toBe(96)
    expect(1 + MAX_GROW).toBeCloseTo(1.35, 5)
    // 半径一半处正好是钟形的拐点值 (1+cos(π/2))/2 = 0.5 —— 线性衰减在这儿会给 0.5 同值,
    // 所以再钉一个只有余弦答得出的点:四分之一半径处 (1+cos(π/4))/2 = 0.8536。
    expect(magnifyAt(0, [RADIUS / 2])[0]).toBeCloseTo(1 + MAX_GROW * 0.5, 6)
    expect(magnifyAt(0, [RADIUS / 4])[0]).toBeCloseTo(1 + MAX_GROW * 0.853553, 5)
  })
})

describe('dockRestCenters(静止坐标系是算出来的,不是量出来的)', () => {
  it('等距排布:anchor + 半个瓦,此后每格 瓦+缝', () => {
    expect(dockRestCenters(rest())).toEqual(centers)
  })

  it('分隔线占主轴一段长度 —— 它后面的每一块都被推开 缝+线宽', () => {
    const withSep = dockRestCenters(rest({ sepAfter: 1 }))
    expect(withSep.slice(0, 2)).toEqual(centers.slice(0, 2))
    for (let i = 2; i < withSep.length; i += 1) {
      expect(withSep[i]).toBe(centers[i] + 10) // gap 9 + sep 1
    }
  })

  it('锚点平移多少,整串中心就平移多少(条挪窝不改相对几何)', () => {
    expect(dockRestCenters(rest({ anchor: 300 }))).toEqual(centers.map((c) => c + 300))
  })
})

/**
 * shift —— 「把指针脚下那一点钉住」。
 *
 * 判据不是「shift 等于某个数」(那是把实现抄进测试),而是**它带来的后果**:
 * 指针停在第 p 块的静止中心上时,那块瓦的中心一动不动。所以下面每条都先按
 * 「条会怎么长」把瓦心的落点算出来,再断言它回到静止位。
 *
 * 真机对照(md 档 13 块,`npm run gate:dock` 的 ①a):改前 [-3.22, 0, 0, 1.19,
 * -1.19, 0 … 0, 3.22],改后全 0。
 */
function liveCenter(index: number, pointer: number, layout: DockRestLayout): number {
  const { factors, shift } = magnifyLayout(pointer, layout)
  let cursor = layout.anchor - layout.growthBias * totalGrowth(layout, factors) + shift
  for (let i = 0; i < index; i += 1) {
    cursor += layout.tileSize * factors[i] + layout.gap
    if (i === layout.sepAfter) cursor += layout.sepSize + layout.gap
  }
  return cursor + (layout.tileSize * factors[index]) / 2
}

function totalGrowth(layout: DockRestLayout, factors: number[]): number {
  return factors.reduce((sum, f) => sum + layout.tileSize * (f - 1), 0)
}

describe('magnifyLayout:指针脚下钉住', () => {
  it('每一块(含两端与紧挨分隔线那两块)停在自己中心上时都一动不动', () => {
    for (const layout of [rest(), rest({ sepAfter: 1 }), rest({ count: 8, sepAfter: 2 })]) {
      const at = dockRestCenters(layout)
      at.forEach((c, i) => {
        expect(liveCenter(i, c, layout) - c).toBeCloseTo(0, 6)
      })
    }
  })

  it('三档对齐各算各的,结论一样(退让比例不同,shift 跟着补回来)', () => {
    for (const align of ['start', 'center', 'end'] as const) {
      const layout = rest({ growthBias: GROWTH_BIAS[align] })
      const at = dockRestCenters(layout)
      at.forEach((c, i) => {
        expect(liveCenter(i, c, layout) - c).toBeCloseTo(0, 6)
      })
    }
    // 三档的 shift 本身必须不同 —— 否则「各算一次」就是假的。
    const mid = dockRestCenters(rest())[2]
    const shifts = (['start', 'center', 'end'] as const).map(
      (a) => magnifyLayout(mid, rest({ growthBias: GROWTH_BIAS[a] })).shift,
    )
    expect(new Set(shifts.map((v) => v.toFixed(4))).size).toBe(3)
  })

  it('条中段本来就不漂(左右对称) —— 病只在两端,所以两端才是这条修法的证人', () => {
    // 不带 shift 的老算法:居中档下第 2 块(正中)天然为 0,而第 0 / 第 4 块不是。
    const layout = rest()
    const at = dockRestCenters(layout)
    const withoutShift = (i: number) => {
      const factors = magnifyAt(at[i], at)
      let acc = 0
      for (let j = 0; j < i; j += 1) acc += layout.tileSize * (factors[j] - 1)
      return acc + (layout.tileSize * (factors[i] - 1)) / 2 - 0.5 * totalGrowth(layout, factors)
    }
    expect(withoutShift(2)).toBeCloseTo(0, 6)
    expect(Math.abs(withoutShift(0))).toBeGreaterThan(1)
    expect(Math.abs(withoutShift(4))).toBeGreaterThan(1)
    expect(withoutShift(0)).toBeCloseTo(-withoutShift(4), 6)
  })

  it('相邻两瓦零重叠:放大走布局尺寸,缝只会变大不会变负', () => {
    const layout = rest()
    const at = dockRestCenters(layout)
    for (const pointer of [at[0], at[2], at[4], at[2] + 20]) {
      const { factors } = magnifyLayout(pointer, layout)
      for (let i = 0; i + 1 < layout.count; i += 1) {
        const right = liveCenter(i, pointer, layout) + (layout.tileSize * factors[i]) / 2
        const nextLeft = liveCenter(i + 1, pointer, layout) - (layout.tileSize * factors[i + 1]) / 2
        expect(nextLeft - right).toBeGreaterThanOrEqual(layout.gap - 1e-6)
      }
    }
  })

  it('shift 吃的是**显示值**:入场鼓到一半时补偿的是此刻的布局,不是终局', () => {
    const layout = rest()
    const at = dockRestCenters(layout)
    const target = magnifyAt(at[0], at)
    const half = target.map((f) => 1 + (f - 1) / 2)
    const full = magnifyLayout(at[0], layout).shift
    const mid = magnifyLayout(at[0], layout, half).shift
    expect(mid).toBeCloseTo(full / 2, 6)
    expect(magnifyLayout(at[0], layout, target.map(() => 1)).shift).toBeCloseTo(0, 6)
  })
})

describe('damperStep:进 / 跟 / 放同一条插值', () => {
  const H = 1000 / 60

  it('τ=0 当帧瞬到(reduced-motion 与动效档「无」走这一档)', () => {
    expect(damperStep(1, 0, 1.35, 0, H)).toEqual({ value: 1.35, velocity: 0 })
  })

  it('dt=0 什么都不变 —— 与 τ=0 是两件事(09-02 真机判例:合并了入场当场变回一帧到位)', () => {
    // rAF 回调拿到的是**这一帧开始的时刻**,可能早于你调 requestAnimationFrame 那一刻,
    // 所以入场第一发的 dt 常常是 0 / 负数。这里把两个 0 分开钉死。
    expect(damperStep(1, 0, 1.35, MAGNIFY_TAU_MS, 0)).toEqual({ value: 1, velocity: 0 })
    expect(damperStep(1.2, 3, 1.35, MAGNIFY_TAU_MS, -5)).toEqual({ value: 1.2, velocity: 3 })
  })

  it('从静止起步不跳:第一帧只走一小截,且单调逼近、不过冲', () => {
    let value = 1
    let velocity = 0
    const steps: number[] = []
    for (let i = 0; i < 40; i += 1) {
      const next = damperStep(value, velocity, 1.35, MAGNIFY_TAU_MS, H)
      steps.push(next.value - value)
      value = next.value
      velocity = next.velocity
    }
    // 首帧涨幅 —— 真机门 ②a 的闸是 0.08,这里同一个数钉住配方本身。
    expect(steps[0]).toBeLessThan(0.08)
    expect(steps[0]).toBeGreaterThan(0)
    // 临界阻尼:一路逼近,从不越过目标(过冲 = 换成了欠阻尼)。
    expect(value).toBeLessThanOrEqual(1.35 + 1e-9)
    expect(steps.every((d) => d >= -1e-9)).toBe(true)
    // 指数逼近的首帧是最大的一步;临界阻尼是**先小后大再收** —— 峰值不在第 1 帧。
    expect(steps.indexOf(Math.max(...steps))).toBeGreaterThan(0)
  })

  it('到位够快:6 帧之内进目标 0.05 以内(真机门 ②a 的第二条闸)', () => {
    let value = 1
    let velocity = 0
    let frames = 0
    while (Math.abs(value - 1.35) > 0.05 && frames < 60) {
      const next = damperStep(value, velocity, 1.35, MAGNIFY_TAU_MS, H)
      value = next.value
      velocity = next.velocity
      frames += 1
    }
    expect(frames).toBeLessThanOrEqual(6)
  })

  it('收得干净:从顶格放手,一个 --dur-release 的量级内回到静止(真机门 ③)', () => {
    let value = 1.35
    let velocity = 0
    let elapsed = 0
    while (Math.abs(value - 1) > 0.005 && elapsed < 1000) {
      const next = damperStep(value, velocity, 1, MAGNIFY_TAU_MS, H)
      value = next.value
      velocity = next.velocity
      elapsed += H
    }
    expect(elapsed).toBeLessThanOrEqual(RELEASE_MS + H)
  })

  it('dt 变长走得更远但仍不越界 —— 掉帧不炸(解析解,不是欧拉积分)', () => {
    const long = damperStep(1, 0, 1.35, MAGNIFY_TAU_MS, 200)
    expect(long.value).toBeLessThanOrEqual(1.35 + 1e-9)
    expect(long.value).toBeGreaterThan(1.34)
    expect(Math.abs(long.velocity)).toBeLessThan(0.01)
  })
})

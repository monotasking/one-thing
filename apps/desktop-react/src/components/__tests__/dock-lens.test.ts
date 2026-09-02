import { describe, expect, it } from 'vitest'
import { bell, dockLens, dockPitch, GROWTH_BIAS, REST_FACTOR } from '../dock-lens'
import type { DockLensRest } from '../dock-lens'

/**
 * Dock 磁性放大的**纯几何**。宿主那半边在 `dock-lens-hook.test.tsx`。
 *
 * 这一份用例分两类:一类钉**形**(钟形长什么样、位移怎么算),另一类钉这套式子
 * 自己带的三条恒等式 —— 它们才是「不抖」的结构保证:
 *   · 缝恒定:相邻两块放大后的缝恒等于静止缝(所以零重叠不靠余量);
 *   · 长度守恒:growth = Σ 各瓦长出来的长度(底板长多少与瓦长多少是同一件事);
 *   · COLA:半径取瓦距的整数倍时,**growth 与指针位置无关** —— 条不呼吸。
 * 第三条是这一轮重做的核心发现,上一版的半径(96px / 53px = 1.81 倍瓦距)不满足它,
 * 于是纯几何自己就带着十几次方向反转。
 */

const SIZE = 44
const GAP = 9
const PITCH = SIZE + GAP

/** 一排等距的瓦,第一块中心在 22。 */
function uniform(count: number): number[] {
  return Array.from({ length: count }, (_, i) => SIZE / 2 + i * PITCH)
}

function rest(partial: Partial<DockLensRest> & { centers: readonly number[] }): DockLensRest {
  return { size: SIZE, max: 1.35, reach: 2 * PITCH, bias: 0.5, ...partial }
}

describe('bell:余弦钟形', () => {
  it('峰在 0、半径处接 0、半径外恒 0,而且没有折角', () => {
    expect(bell(0)).toBe(1)
    expect(bell(0.5)).toBeCloseTo(0.5, 10)
    expect(bell(1)).toBe(0)
    expect(bell(1.7)).toBe(0)
    // 边缘平滑接 0:差商在 t→1 处趋近 0,而线性核在这里的差商是常数 1 —— 那就是折角。
    const slopeAtEdge = Math.abs(bell(0.99) - bell(0.999)) / 0.009
    const slopeAtMid = Math.abs(bell(0.495) - bell(0.505)) / 0.01
    expect(slopeAtMid).toBeGreaterThan(1.5)
    expect(slopeAtEdge).toBeLessThan(slopeAtMid / 50)
  })
})

describe('dockLens:确定性与基本形', () => {
  it('同样的入参永远同样的出参 —— 一格状态都不留', () => {
    const r = rest({ centers: uniform(9) })
    const a = dockLens(133, r)
    const b = dockLens(133, r)
    expect(b).toEqual(a)
  })

  it('指针压在某块瓦心上,那块顶格、越远越小、半径外回到静止', () => {
    const centers = uniform(9)
    const { scale } = dockLens(centers[4], rest({ centers }))
    expect(scale[4]).toBeCloseTo(1.35, 10)
    expect(scale[3]).toBeGreaterThan(scale[2])
    expect(scale[3]).toEqual(scale[5])
    // 半径 = 2 倍瓦距 = 106px;第 2 块离第 4 块正好 106,第 1 块 159 —— 都在半径之外。
    expect(scale[2]).toBe(REST_FACTOR)
    expect(scale[1]).toBe(REST_FACTOR)
    expect(scale[0]).toBe(REST_FACTOR)
  })

  it('指针离条很远时全静止:一格位移都没有,条也不长', () => {
    const { scale, dx, growth } = dockLens(-9999, rest({ centers: uniform(9) }))
    expect(scale.every((v) => v === REST_FACTOR)).toBe(true)
    expect(dx.every((v) => v === 0)).toBe(true)
    expect(growth).toBe(0)
  })
})

describe('dockLens:三条恒等式', () => {
  it('长度守恒:growth 就是各瓦长出来的长度之和', () => {
    const centers = uniform(11)
    for (const x of [0, 37, 120, 233, 400]) {
      const { scale, growth } = dockLens(x, rest({ centers }))
      const sum = scale.reduce((acc, s) => acc + SIZE * (s - REST_FACTOR), 0)
      expect(growth).toBeCloseTo(sum, 10)
    }
  })

  it('缝恒定:相邻两块放大后的缝**恒等于静止缝**,零重叠是式子给的不是余量给的', () => {
    const centers = uniform(11)
    for (const x of [0, 17, 88, 191, 260, 431]) {
      const { scale, dx } = dockLens(x, rest({ centers }))
      for (let i = 0; i + 1 < centers.length; i += 1) {
        const right = centers[i + 1] + dx[i + 1] - (SIZE * scale[i + 1]) / 2
        const left = centers[i] + dx[i] + (SIZE * scale[i]) / 2
        expect(right - left).toBeCloseTo(GAP, 8)
      }
    }
  })

  it('COLA:半径取瓦距的**整数倍**时 growth 与指针位置无关 —— 条不呼吸', () => {
    // 条要够长,才量得到「中段」(两端被截断本来就不满足 COLA)。
    const centers = uniform(21)
    const sample = (reach: number) =>
      [0, 3, 7, 13, 21, 26, 40, 53, 71, 92, 106].map((d) => dockLens(centers[10] + d, rest({ centers, reach })).growth)
    for (const k of [2, 3]) {
      const g = sample(k * PITCH)
      expect(Math.max(...g) - Math.min(...g)).toBeLessThan(1e-9)
    }
    // 反面:上一版那个半径(96px = 1.81 倍瓦距)不是整数倍,条就一伸一缩。
    const ripple = sample(96)
    expect(Math.max(...ripple) - Math.min(...ripple)).toBeGreaterThan(0.5)
  })
})

describe('dockLens:位移与对齐档', () => {
  it('对称核的中段:指针停在某块瓦心上,那块的位移是 0', () => {
    const centers = uniform(21)
    const { dx } = dockLens(centers[10], rest({ centers }))
    expect(dx[10]).toBeCloseTo(0, 8)
  })

  it('bias 三档只改整条朝哪边退,**相对位移一个字不动**', () => {
    const centers = uniform(11)
    const at = centers[5] + 20
    const start = dockLens(at, rest({ centers, bias: GROWTH_BIAS.start }))
    const center = dockLens(at, rest({ centers, bias: GROWTH_BIAS.center }))
    const end = dockLens(at, rest({ centers, bias: GROWTH_BIAS.end }))
    // start 档条的前缘钉死:第一块只朝后挪,位移一律 ≥ 0。
    expect(Math.min(...start.dx)).toBeGreaterThanOrEqual(0)
    // end 档反过来:后缘钉死,一律 ≤ 0。
    expect(Math.max(...end.dx)).toBeLessThanOrEqual(1e-9)
    // 三档之间只差一个常数(= growth × Δbias),相邻间距因此完全一样。
    for (let i = 0; i < centers.length; i += 1) {
      expect(center.dx[i] - start.dx[i]).toBeCloseTo(-start.growth * 0.5, 8)
      expect(end.dx[i] - start.dx[i]).toBeCloseTo(-start.growth, 8)
    }
    expect(center.scale).toEqual(start.scale)
  })

  it('对齐档表与 AppShell 的三条定位规则是同一件事的两面', () => {
    expect(GROWTH_BIAS).toEqual({ start: 0, center: 0.5, end: 1 })
  })

  it('两端因钟形被条端截断而失衡:第一块会漂一两个像素,**不修**', () => {
    const centers = uniform(13)
    const { dx } = dockLens(centers[0], rest({ centers }))
    expect(Math.abs(dx[0])).toBeGreaterThan(0.5)
    expect(Math.abs(dx[0])).toBeLessThan(6)
  })
})

describe('dockPitch', () => {
  it('取最小的那段中心距 —— 分隔线宽出来的那一格不该把半径拉长', () => {
    expect(dockPitch(uniform(5), SIZE)).toBeCloseTo(PITCH, 10)
    expect(dockPitch([22, 75, 138, 191], SIZE)).toBeCloseTo(53, 10)
  })

  it('只有一块瓦时没有瓦距可言,退回瓦身量', () => {
    expect(dockPitch([22], SIZE)).toBe(SIZE)
    expect(dockPitch([], SIZE)).toBe(SIZE)
  })
})

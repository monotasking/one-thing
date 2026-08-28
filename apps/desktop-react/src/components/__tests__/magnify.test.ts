import { describe, expect, it } from 'vitest'
import { magnifyAt } from '../useMagnify'

/** 静止几何:五块瓷砖,间距 53(44 瓦 + 9 缝),第一块中心在 22。 */
const centers = [22, 75, 128, 181, 234]

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
})

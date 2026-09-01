import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PEAK_FACTOR, magnifyAt, useMagnify } from '../useMagnify'
import { RELEASE_MS } from '../motion'

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

/**
 * 入场缓冲(09-01 修「从上/下方进 Dock 突然变大不流畅」)。
 *
 * 跟手定律说的是「指针在条上时逐帧照算、零过渡」,而**入场那一帧**指针是从 1.0
 * 直接落到目标档的:零过渡 = 一帧之内从 44px 蹦到 59.4px,看上去就是「啪」一下。
 * 所以 `tracking`(= CSS 把 --tile-size-dur 压成 0ms 的那把开关)推迟
 * RELEASE_MS 再上岗,这一段里改档吃 CSS 过渡,从 1.0 平滑长到目标档。
 *
 * 真机 A/B(隔离 store,md 档,44 → 59.4):修后第一帧**不在**目标位,
 * 逐帧 44 → 46.7 → 48.8 → 50.3 → … → 59.4,141ms 到位。
 *
 * 反证:把 `rampTimer` 那一段换回 `setTracking(true)`,下面第一条立刻红。
 */
describe('useMagnify:入场先缓一段,过后才跟手', () => {
  const move = (x: number) =>
    ({ clientX: x, clientY: 0 }) as unknown as React.MouseEvent<HTMLDivElement>

  it('第一发 move 不跟手(过渡还开着),RELEASE_MS 之后才转跟手', () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useMagnify(3, 'x'))
      act(() => result.current.onMouseMove(move(100)))
      expect(result.current.tracking).toBe(false)
      act(() => vi.advanceTimersByTime(RELEASE_MS - 1))
      expect(result.current.tracking).toBe(false)
      act(() => vi.advanceTimersByTime(1))
      expect(result.current.tracking).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('离开即清:跟手关掉,下一次入场重新缓一段', () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useMagnify(3, 'x'))
      act(() => result.current.onMouseMove(move(100)))
      act(() => vi.advanceTimersByTime(RELEASE_MS))
      expect(result.current.tracking).toBe(true)
      act(() => result.current.onMouseLeave())
      expect(result.current.tracking).toBe(false)
      act(() => result.current.onMouseMove(move(120)))
      expect(result.current.tracking).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * 钉主人瓦(09-01 报障:「从 dock item 移动到 preview 的时候,dock item 不要变小」)。
 *
 * 修前指针一离开瓦朝泡走,距离拉开、余弦一落,主人瓦当场缩回去,而泡还挂在它头上 ——
 * 视觉上「泡没有主人了」。裁定语义:**泡开着期间主人瓦钉在满档**;
 * 泡关掉或换主才按 --dur-release 平滑回落,换主时新主接过满档。
 *
 * 反证:把 `shownFactors` 那一段换回直接交 `factors`,下面第一条立刻红。
 */
describe('useMagnify:泡的主人瓦钉在满档', () => {
  const move = (x: number) =>
    ({ clientX: x, clientY: 0 }) as unknown as React.MouseEvent<HTMLDivElement>

  it('钉住的那一格恒是满档,别人照旧按距离算', () => {
    const { result, rerender } = renderHook(({ pin }: { pin: number | null }) => useMagnify(3, 'x', pin), {
      initialProps: { pin: null as number | null },
    })
    act(() => result.current.onMouseMove(move(10_000))) // 指针在天边:所有人都该回静止
    expect(result.current.factors.every((f) => f === 1)).toBe(true)
    rerender({ pin: 1 })
    expect(result.current.factors[1]).toBe(PEAK_FACTOR)
    expect(result.current.factors[0]).toBe(1)
    expect(result.current.factors[2]).toBe(1)
  })

  it('指针整个离开条(泡里也算离开条身)之后,钉住的那一格仍是满档', () => {
    const { result, rerender } = renderHook(({ pin }: { pin: number | null }) => useMagnify(3, 'x', pin), {
      initialProps: { pin: 1 as number | null },
    })
    act(() => result.current.onMouseLeave())
    expect(result.current.factors[1]).toBe(PEAK_FACTOR)
    rerender({ pin: null })
    expect(result.current.factors[1]).toBe(1)
  })

  it('换主 / 解钉那一下重开入场缓冲 —— 旧主平滑落、新主平滑起,不「啪」一下', () => {
    vi.useFakeTimers()
    try {
      const { result, rerender } = renderHook(({ pin }: { pin: number | null }) => useMagnify(3, 'x', pin), {
        initialProps: { pin: null as number | null },
      })
      act(() => result.current.onMouseMove(move(100)))
      act(() => vi.advanceTimersByTime(RELEASE_MS))
      expect(result.current.tracking).toBe(true)
      act(() => rerender({ pin: 2 }))
      expect(result.current.tracking).toBe(false) // 过渡打开 = 这一下走 --dur-release
      act(() => vi.advanceTimersByTime(RELEASE_MS))
      expect(result.current.tracking).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

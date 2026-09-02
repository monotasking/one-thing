import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMagnify } from '../useMagnify'
import type { MagnifyInput } from '../useMagnify'
import { REST_FACTOR } from '../dock-magnify'

/**
 * `useMagnify` 的宿主半边 —— 纯几何那半边在 `magnify.test.ts`。
 *
 * 这里钉的是三件只有宿主才答得出的事:**锚点什么时候作废**、**指针在不在条上**
 * (含交叉轴那一维)、以及**那条 rAF 环收针之后会不会停**。
 *
 * 时间是自己造的:rAF 与 performance.now 都换成手推的,免得测试跟着真机帧率飘
 * (真跑一帧 16.7ms 还是 8ms,断言就会两个答案)。
 */

/** 条的静止矩形:主轴 100→400,交叉轴 800→862(与 md 档条高 62 对得上)。 */
const STRIP_BOX = { left: 100, top: 800, right: 400, bottom: 862, width: 300, height: 62 }
/** 锚点 = 左缘 + 边框 1 + 内距 10;各瓦中心 = 锚点 + i×(44+9) + 22。 */
const anchorOf = (left: number) => left + 1 + 10
const centerOf = (i: number, left = STRIP_BOX.left) => anchorOf(left) + i * 53 + 22

const INPUT: MagnifyInput = { count: 5, sepAfter: -1, edge: 'bottom', align: 'center', size: 'md' }

function harness(input: MagnifyInput = INPUT) {
  const frames: FrameRequestCallback[] = []
  let clock = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(performance, 'now').mockImplementation(() => clock)

  const strip = document.createElement('div')
  let box = { ...STRIP_BOX }
  strip.getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, toJSON: () => '' })
  const realComputed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
    if (el !== strip) return realComputed(el as Element)
    return {
      borderTopWidth: '1px',
      borderLeftWidth: '1px',
      paddingTop: '8px',
      paddingLeft: '10px',
      rowGap: '9px',
      columnGap: '9px',
      getPropertyValue: (name: string) =>
        name === '--tile-size' ? '44px' : name === '--dock-sep-w' ? '1px' : '',
    } as unknown as CSSStyleDeclaration
  })

  const view = renderHook((props: MagnifyInput) => useMagnify(props), { initialProps: input })
  act(() => {
    view.result.current.stripRef.current = strip
  })

  /** 推 n 帧(每帧 16.7ms)。 */
  const run = (n = 40) => {
    for (let i = 0; i < n; i += 1) {
      const pending = frames.splice(0, frames.length)
      if (pending.length === 0) return i
      clock += 1000 / 60
      act(() => pending.forEach((cb) => cb(clock)))
    }
    return n
  }
  const move = (main: number, cross = 830) =>
    act(() =>
      view.result.current.onMouseMove({
        clientX: main,
        clientY: cross,
      } as unknown as React.MouseEvent<HTMLDivElement>),
    )
  const leave = () => act(() => view.result.current.onMouseLeave())
  const peak = () => Math.max(...view.result.current.factors)

  /** 把条挪个窝(视口变了 / 条变宽了都会让它挪),配 window resize 一起用。 */
  const moveStrip = (left: number, width = box.width) => {
    box = { ...box, left, width, right: left + width }
  }

  return { view, run, move, leave, peak, moveStrip, framesPending: () => frames.length }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useMagnify:指针在不在条上', () => {
  it('主轴压着一块瓦、交叉轴也在条里 —— 放大到顶格', () => {
    const h = harness()
    h.move(centerOf(0))
    h.run()
    expect(h.peak()).toBeCloseTo(1.35, 2)
  })

  it('交叉轴出了条(悬在放大后长出条外的那一截上)= 不在条上,不放大', () => {
    const h = harness()
    // 条的交叉轴是 800→862;790 在条的上方 —— 正是瓦长出去那一截所在的位置。
    // 事件仍然会从那一截冒泡到条上,所以只判主轴的话这里会照样放大。
    h.move(centerOf(0), 790)
    h.run()
    expect(h.peak()).toBeCloseTo(REST_FACTOR, 5)
    expect(h.view.result.current.shift).toBe(0)
  })

  it('从条外挪回条里,同一条环把它鼓起来', () => {
    const h = harness()
    h.move(centerOf(0), 790)
    h.run()
    h.move(centerOf(0), 830)
    h.run()
    expect(h.peak()).toBeCloseTo(1.35, 2)
  })
})

describe('useMagnify:入场 / 释放走同一条插值', () => {
  it('入场是鼓起来的:第一帧远没到顶,三四帧后基本就位', () => {
    const h = harness()
    h.move(centerOf(0))
    h.run(1)
    const first = h.peak()
    expect(first).toBeGreaterThan(REST_FACTOR)
    expect(first).toBeLessThan(1.1) // 一帧就到 1.35 = 又跳回去了
    h.run(5)
    expect(h.peak()).toBeGreaterThan(1.3)
  })

  it('手离开后收回静止,收干净之后 rAF 环就停了(悬停不动不该有一条空转的环)', () => {
    const h = harness()
    h.move(centerOf(0))
    h.run()
    expect(h.framesPending()).toBe(0) // 跟手到位即停
    h.leave()
    const spent = h.run(60)
    expect(h.peak()).toBeCloseTo(REST_FACTOR, 5)
    expect(spent).toBeLessThan(60)
    expect(h.framesPending()).toBe(0)
  })
})

describe('useMagnify:静止坐标系什么时候作废', () => {
  it('瓦数变了要重新量 —— 否则新的那一块按旧坐标系算,整条错位', () => {
    const h = harness()
    h.move(centerOf(0))
    h.run()
    expect(h.view.result.current.factors).toHaveLength(5)
    // 瓦数从 5 变 8:第 5 块(下标 4)的静止中心照算是 345。
    act(() => h.view.rerender({ ...INPUT, count: 8 }))
    h.move(centerOf(4))
    h.run()
    const factors = h.view.result.current.factors
    expect(factors).toHaveLength(8)
    expect(factors.indexOf(Math.max(...factors))).toBe(4)
    expect(Math.max(...factors)).toBeCloseTo(1.35, 2)
  })

  it('分隔线插进来之后,它右边的每一块都被推开 —— 声明那半边当帧就算数', () => {
    const h = harness()
    h.move(centerOf(0))
    h.run()
    // 手不离开就改 sepAfter:量出来那半边(锚点)此刻量不了,沿用上一次;
    // 而**声明**那半边当帧就该算数 —— 第 3 块(下标 2)的中心从 239 推到 249。
    act(() => h.view.rerender({ ...INPUT, sepAfter: 1 }))
    h.move(centerOf(2) + 10)
    h.run()
    const factors = h.view.result.current.factors
    expect(factors.indexOf(Math.max(...factors))).toBe(2)
    expect(Math.max(...factors)).toBeCloseTo(1.35, 2)
    // 反证:旧中心(没算分隔线那 10px)现在已经不是顶格了。
    h.move(centerOf(2))
    h.run()
    expect(Math.max(...h.view.result.current.factors)).toBeLessThan(1.35)
  })

  it('条挪了窝(视口变):锚点作废,手一离开就按新位置重量', () => {
    const h = harness()
    h.move(centerOf(0))
    h.run()
    // 条整体左移 40 —— 居中档下视口一变就会这样。锚点作废,但此刻正放大着量不了。
    h.moveStrip(STRIP_BOX.left - 40)
    act(() => window.dispatchEvent(new Event('resize')))
    h.leave()
    h.run(60)
    h.move(centerOf(0, STRIP_BOX.left - 40))
    h.run()
    const factors = h.view.result.current.factors
    expect(factors.indexOf(Math.max(...factors))).toBe(0)
    expect(Math.max(...factors)).toBeCloseTo(1.35, 2)
  })

  it('对齐档换了,shift 跟着换(退让比例是 CSS 定位的后果,不是这里的选择)', () => {
    const h = harness()
    h.move(centerOf(0))
    h.run()
    const centered = h.view.result.current.shift
    act(() => h.view.rerender({ ...INPUT, align: 'start' }))
    h.move(centerOf(0))
    h.run()
    expect(h.view.result.current.shift).not.toBeCloseTo(centered, 3)
  })
})

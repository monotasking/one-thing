import { describe, expect, it } from 'vitest'
import { DomScrollPort, FakeScrollPort } from '../scroll-port'

/**
 * `ScrollPort` 的两条纪律各一组反证(G 线 P2-a,正本 §13.2.3)。
 *
 * `DomScrollPort` 这一半用 jsdom 的真元素 + 篡改的 property descriptor(与
 * `ChatStream.test.tsx` 那几组同一手);`FakeScrollPort` 那一半一格 DOM 都不碰 ——
 * 它是裁决层单测的地基,所以它自己得先对。
 */

interface Stub {
  el: HTMLDivElement
  column: HTMLDivElement
  pad: HTMLDivElement
  geo: { scrollTop: number; scrollHeight: number; clientHeight: number }
  port: DomScrollPort
}

function stub(geo?: Partial<Stub['geo']>): Stub {
  const el = document.createElement('div')
  const column = document.createElement('div')
  const pad = document.createElement('div')
  el.append(column)
  document.body.append(el)
  const state = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300, ...geo }
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => state.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => state.clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    // 浏览器会钳 —— 不演这一下,`lastTop` 记的就不是真机上那个数。
    set: (next: number) => void (state.scrollTop = Math.max(0, Math.min(next, state.scrollHeight - state.clientHeight))),
  })
  return { el, column, pad, geo: state, port: new DomScrollPort(() => el, () => pad) }
}

describe('DomScrollPort · 纪律① 停靠中一切读写都是恒等', () => {
  it('`clientHeight === 0` 时 `measure()` 答 undefined', () => {
    const { port, geo } = stub({ clientHeight: 0 })
    expect(port.measure()).toBeUndefined()
    geo.clientHeight = 300
    expect(port.measure()?.gap).toBe(700)
  })

  it('`clientHeight === 0` 时 `setTop` 一个字都不写,`lastTop` 也不动', () => {
    const { port, geo } = stub({ clientHeight: 0, scrollTop: 42 })
    port.setTop(0, 'tail-growth')
    expect(geo.scrollTop).toBe(42)
    expect(port.lastTop).toBeUndefined()
  })

  it('`clientHeight === 0` 时 `summarizeResize` 答 undefined,而且一个矩形都不读', () => {
    const { port, column, geo } = stub({ clientHeight: 0 })
    let rects = 0
    column.getBoundingClientRect = () => {
      rects += 1
      return { height: 0 } as DOMRect
    }
    expect(port.summarizeResize([{ target: column, contentRect: { height: 0 } } as unknown as ResizeObserverEntry]))
      .toBeUndefined()
    expect(rects).toBe(0)
    geo.clientHeight = 300
    expect(port.summarizeResize([{ target: column, contentRect: { height: 0 } } as unknown as ResizeObserverEntry]))
      .toEqual({ containerChanged: false, columnHeights: [0] })
    expect(rects).toBe(1)
  })

  it('没有元素时读面答出厂值、写面无声', () => {
    const port = new DomScrollPort(() => null, () => null)
    expect(port.top).toBe(0)
    expect(port.measure()).toBeUndefined()
    expect(port.gapNow()).toBe(0)
    expect(port.hasLayout()).toBe(false)
    expect(port.writePadHeight(12)).toBe(false)
    expect(() => port.setTop(10, 'restore')).not.toThrow()
  })
})

describe('DomScrollPort · 纪律② 写完当场记 `lastTop`,记的是读回来的那个数', () => {
  it('浏览器钳过之后 `lastTop` 是落点,不是我们要写的那个数', () => {
    const { port, geo } = stub()
    port.setTop(99_999, 'tail-growth')
    expect(geo.scrollTop).toBe(700)
    expect(port.lastTop).toBe(700)
  })

  it('滚动那一头交出**上一次**那个数,再把新的记下去', () => {
    const { port, geo } = stub()
    port.setTop(400, 'send-landing')
    geo.scrollTop = 120
    expect(port.noteScrolled()).toEqual({ previousTop: 400, top: 120 })
    expect(port.noteScrolled()).toEqual({ previousTop: 120, top: 120 })
  })

  it('这次挂载里一次都没写过 = `lastTop` 是 undefined(缺省 pinned 不需要它)', () => {
    const { port } = stub()
    expect(port.lastTop).toBeUndefined()
    expect(port.noteScrolled().previousTop).toBeUndefined()
  })
})

describe('DomScrollPort · 垫块与分档', () => {
  it('没有垫块那个元素时答 false —— 调用方据此**不记账**', () => {
    const el = document.createElement('div')
    el.append(document.createElement('div'))
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 300 })
    const port = new DomScrollPort(() => el, () => null)
    expect(port.writePadHeight(64)).toBe(false)
  })

  it('有垫块就写进 style,答 true', () => {
    const { port, pad } = stub()
    expect(port.writePadHeight(64)).toBe(true)
    expect(pad.style.height).toBe('64px')
  })

  it('`zoneOf` 只认三档,相交就算在场内', () => {
    const { port, el } = stub()
    el.getBoundingClientRect = () => ({ top: 100, bottom: 400 }) as DOMRect
    expect(port.zoneOf({ top: 0, bottom: 100 })).toBe('above')
    expect(port.zoneOf({ top: 400, bottom: 500 })).toBe('below')
    expect(port.zoneOf({ top: 90, bottom: 110 })).toBe('inside')
  })
})

describe('FakeScrollPort · 它自己得先对(裁决层单测的地基)', () => {
  it('`setTop` 演了「浏览器会钳」,并把每一笔记进 `writes`', () => {
    const port = new FakeScrollPort()
    port.setTop(99_999, 'tail-growth')
    port.setTop(-5, 'restore')
    expect(port.writes).toEqual([
      { top: 700, cause: 'tail-growth' },
      { top: 0, cause: 'restore' },
    ])
    expect(port.lastTop).toBe(0)
  })

  it('停靠档(`clientHeight: 0`)与真的那只同形:读答 undefined、写无声', () => {
    const port = new FakeScrollPort({ clientHeight: 0, scrollTop: 42 })
    expect(port.measure()).toBeUndefined()
    expect(port.summarizeResize([{ contentRect: { height: 10 } }])).toBeUndefined()
    port.setTop(0, 'tail-growth')
    expect(port.geometry.scrollTop).toBe(42)
    expect(port.writes).toEqual([])
  })

  it('`scrollTo` 是「人滚的」:改位置但不记 `lastTop`', () => {
    const port = new FakeScrollPort()
    port.scrollTo(120)
    expect(port.top).toBe(120)
    expect(port.lastTop).toBeUndefined()
    expect(port.noteScrolled()).toEqual({ previousTop: undefined, top: 120 })
  })

  it('`summarizeResize` 把容器那一支分出来', () => {
    const port = new FakeScrollPort()
    expect(port.summarizeResize([
      { target: 'container', contentRect: { height: 0 } },
      { contentRect: { height: 880 } },
    ])).toEqual({ containerChanged: true, columnHeights: [880] })
  })
})

import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useFloatDismiss, useFloatPosition } from '../float'
import type { FloatAnchor, FloatPlace } from '../float'

/**
 * 浮层两原语的守卫(09-01 ui 库自愈批)。
 *
 * 位置读数不断言 style 字符串,而是把 `useFloatPosition` 交出来的三个数原样
 * 挂成 data-*:要验的是**这只 hook 算出了什么**,不是消费方拿它画了什么。
 *
 * 时间上只有一处需要等:跟随重算走 rAF 合并(一帧最多一次),所以发完
 * scroll / resize 要 `await` 一帧才轮得到它。
 */

function rectOf(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

/** 一帧:发完事件等它,rAF 里那次重算才跑得到。 */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((done) => requestAnimationFrame(() => done()))
  })
}

const realInnerWidth = window.innerWidth
const realInnerHeight = window.innerHeight

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
}

afterEach(() => {
  setViewport(realInnerWidth, realInnerHeight)
})

/* ── useFloatDismiss ─────────────────────────────────────────────────────── */

function DismissHarness({ onClose, active }: { onClose: () => void; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useFloatDismiss(ref, onClose, active)
  return (
    <div ref={ref} data-testid="float">
      <button type="button">inside</button>
    </div>
  )
}

/**
 * **Esc 那一半退役了**(09-02 R1)。这只原语从前还管「Esc 认领关闭」,判据是一只
 * 模块级浮层栈(DOM 包含 + 入栈序两条猜出来的判据)。它连同「层叠时只退一层」
 * 那一组用例整个搬进了响应链:`<FocusScope onEscape>` 声明,唯一那个派发器沿
 * 活动路径由深到浅问。对应的守卫现在在 `src/focus/__tests__/modal-scope.test.tsx`
 * (对话框里开菜单,一下 Esc 只关菜单)与 `dispatch.test.tsx`(退一层的次序)。
 *
 * 所以这一组只剩点外关 —— 它各浮层各判各的,从来没有次序问题。
 */
describe('useFloatDismiss:怎么散', () => {
  it('点浮层外关,点浮层里不关', () => {
    const onClose = vi.fn()
    render(<DismissHarness onClose={onClose} />)

    fireEvent.pointerDown(screen.getByText('inside'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Esc 一个字都不管了(它归响应链)', () => {
    const onClose = vi.fn()
    render(<DismissHarness onClose={onClose} />)

    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => void window.dispatchEvent(ev))

    expect(onClose).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('active=false 零反应 —— 关着的浮层不许还在听指针', () => {
    const onClose = vi.fn()
    render(<DismissHarness onClose={onClose} active={false} />)

    fireEvent.pointerDown(document.body)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('卸载即拆监听(拆得干净:卸载后再点一下没有人接)', () => {
    const onClose = vi.fn()
    const view = render(<DismissHarness onClose={onClose} />)
    view.unmount()

    fireEvent.pointerDown(document.body)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('两层都开着时,点在两层外面两层都收到(各判各的,没有栈)', () => {
    const closeOuter = vi.fn()
    const closeInner = vi.fn()

    function Nested() {
      const outer = useRef<HTMLDivElement>(null)
      const inner = useRef<HTMLDivElement>(null)
      useFloatDismiss(outer, closeOuter)
      useFloatDismiss(inner, closeInner)
      return (
        <div ref={outer} data-testid="outer">
          <div ref={inner} data-testid="inner" />
        </div>
      )
    }
    render(<Nested />)

    fireEvent.pointerDown(document.body)
    expect(closeOuter).toHaveBeenCalledTimes(1)
    expect(closeInner).toHaveBeenCalledTimes(1)
  })

  it('outside:false 一条路都不留(Dialog 那一档:它的点外面是遮罩自己的 mousedown)', () => {
    const onClose = vi.fn()
    function Only() {
      const ref = useRef<HTMLDivElement>(null)
      useFloatDismiss(ref, onClose, true, { outside: false })
      return <div ref={ref} data-testid="float" />
    }
    render(<Only />)

    fireEvent.pointerDown(document.body)
    expect(onClose).not.toHaveBeenCalled()
  })

  it("outside:'capture' 走捕获相位:半路 stopPropagation 也拦不住点外关", () => {
    const onClose = vi.fn()
    function WithBlocker() {
      const ref = useRef<HTMLDivElement>(null)
      useFloatDismiss(ref, onClose, true, { outside: 'capture' })
      return (
        <>
          <div ref={ref} data-testid="float" />
          {/* 屏幕别处那件把 pointerdown 掐断的东西(Select / Tabs / FloatWindow 各有一句)。 */}
          <div data-testid="blocker" onPointerDown={(e) => e.stopPropagation()} />
        </>
      )
    }
    render(<WithBlocker />)

    fireEvent.pointerDown(screen.getByTestId('blocker'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

/* ── useFloatPosition ────────────────────────────────────────────────────── */

function PositionHarness({ anchor }: { anchor: FloatAnchor }) {
  const ref = useRef<HTMLDivElement>(null)
  const pos = useFloatPosition(ref, anchor)
  return (
    <div
      ref={ref}
      data-testid="float"
      data-left={pos.left}
      data-top={pos.top}
      data-flipped={String(pos.flipped)}
    />
  )
}

function readPos(): { left: string | null; top: string | null; flipped: string | null } {
  const el = screen.getByTestId('float')
  return {
    left: el.getAttribute('data-left'),
    top: el.getAttribute('data-top'),
    flipped: el.getAttribute('data-flipped'),
  }
}

/** 活矩形:测试自己拨它,模拟「页面滚了,锚点跟着走」。 */
function liveRect(initial: DOMRect | null) {
  const box = { current: initial }
  return {
    box,
    anchor: (place: FloatPlace): FloatAnchor => ({
      kind: 'rect',
      place,
      get: () => box.current,
    }),
  }
}

describe('useFloatPosition:rect 档跟着锚点走', () => {
  it('below-start:贴锚点下缘左对齐', () => {
    setViewport(1000, 800)
    const { anchor } = liveRect(rectOf(120, 60, 90, 24))
    render(<PositionHarness anchor={anchor('below-start')} />)
    expect(readPos()).toEqual({ left: '120', top: '84', flipped: 'false' })
  })

  /*
   * `below-end`(09-02 批 12 补的第三档)。判据是**对齐的是锚点的右缘**:
   * 左缘 = 右缘 − 浮层身量。jsdom 不排版(offsetWidth 恒 0),所以这里量到的是
   * 那个退化式 `left === r.right` —— 身量那一半由 `place()` 的算式本身承担,
   * 真机上的读数在 `scripts/gate-credential-pool.mjs` 里(菜单不再探出面板)。
   * 它证的是这一档**真的走了另一条分支**:同一个锚点,两档给出的 left 不同。
   */
  it('below-end:对齐的是锚点右缘,与 below-start 分道扬镳', () => {
    setViewport(1000, 800)
    const { anchor } = liveRect(rectOf(120, 60, 90, 24))
    const { unmount } = render(<PositionHarness anchor={anchor('below-end')} />)
    expect(readPos()).toEqual({ left: '210', top: '84', flipped: 'false' })
    unmount()
    render(<PositionHarness anchor={anchor('below-start')} />)
    expect(readPos().left).toBe('120')
  })

  it('below-end 也夹进视口:锚点右缘贴着屏幕边时不许溢出去', () => {
    setViewport(200, 800)
    const { anchor } = liveRect(rectOf(150, 60, 90, 24))
    render(<PositionHarness anchor={anchor('below-end')} />)
    // 理想位 240 越过 vw(200),夹到 vw − w = 200。
    expect(readPos().left).toBe('200')
  })

  it('滚一下 = 重新问锚点在哪儿,位置跟着移(这是「跟随」那一格)', async () => {
    setViewport(1000, 800)
    const { box, anchor } = liveRect(rectOf(120, 300, 90, 24))
    render(<PositionHarness anchor={anchor('below-start')} />)
    expect(readPos().top).toBe('324')

    // 页面滚了 200:锚点上移,浮层必须跟上。
    box.current = rectOf(120, 100, 90, 24)
    act(() => void window.dispatchEvent(new Event('scroll')))
    await nextFrame()

    expect(readPos()).toEqual({ left: '120', top: '124', flipped: 'false' })
  })

  it('getter 答不出矩形:不抛,位置原地不动', async () => {
    setViewport(1000, 800)
    const { box, anchor } = liveRect(rectOf(120, 300, 90, 24))
    render(<PositionHarness anchor={anchor('below-start')} />)
    const before = readPos()

    box.current = null
    act(() => void window.dispatchEvent(new Event('scroll')))
    await nextFrame()

    expect(readPos()).toEqual(before)
  })

  it('above-center:摆锚点正上方居中;上方摆不下就翻到下缘并报 flipped', () => {
    setViewport(1000, 800)
    // jsdom 不排版(offsetHeight 恒 0),所以「摆不下」只在锚点自己越过视口顶时成立。
    const { anchor } = liveRect(rectOf(100, 200, 60, 20))
    const { unmount } = render(<PositionHarness anchor={anchor('above-center')} />)
    expect(readPos()).toEqual({ left: '130', top: '200', flipped: 'false' })
    unmount()

    const above = liveRect(rectOf(100, -5, 60, 20))
    render(<PositionHarness anchor={above.anchor('above-center')} />)
    expect(readPos()).toEqual({ left: '130', top: '15', flipped: 'true' })
  })

  it('卸载即拆监听:走了之后再滚,getter 一次都不该被问', async () => {
    setViewport(1000, 800)
    const get = vi.fn(() => rectOf(10, 10, 10, 10))
    const view = render(
      <PositionHarness anchor={{ kind: 'rect', place: 'below-start', get }} />,
    )
    view.unmount()
    get.mockClear()

    act(() => void window.dispatchEvent(new Event('scroll')))
    await nextFrame()

    expect(get).not.toHaveBeenCalled()
  })
})

describe('useFloatPosition:point 档不跟滚', () => {
  it('resize 后重新 clamp 进视口', async () => {
    setViewport(500, 800)
    render(<PositionHarness anchor={{ kind: 'point', x: 800, y: 100 }} />)
    // 视口只有 500 宽,光标坐标 800 被夹回来。
    expect(readPos().left).toBe('500')

    setViewport(1000, 800)
    act(() => void window.dispatchEvent(new Event('resize')))
    await nextFrame()

    expect(readPos().left).toBe('800')
  })

  it('**不**响应 scroll —— 光标那个点不属于页面,页面滚它不该跟', async () => {
    setViewport(500, 800)
    render(<PositionHarness anchor={{ kind: 'point', x: 800, y: 100 }} />)
    expect(readPos().left).toBe('500')

    // 视口变了但只发 scroll:真去重算的话这里会变成 800。
    setViewport(1000, 800)
    act(() => void window.dispatchEvent(new Event('scroll')))
    await nextFrame()

    expect(readPos().left).toBe('500')
  })
})

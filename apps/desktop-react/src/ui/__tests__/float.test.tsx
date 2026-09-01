import { useRef, useState } from 'react'
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

/** Esc 一定要**可取消**才谈得上「认领」——不可取消的事件 preventDefault 是空转。 */
function escape(): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
}

describe('useFloatDismiss:怎么散', () => {
  it('Esc 关,并且**认领这一下**(defaultPrevented) —— 不认领会连底下那层一起收', () => {
    const onClose = vi.fn()
    render(<DismissHarness onClose={onClose} />)

    const ev = escape()
    act(() => void window.dispatchEvent(ev))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('别的键不碰:既不关也不认领', () => {
    const onClose = vi.fn()
    render(<DismissHarness onClose={onClose} />)

    const ev = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    act(() => void window.dispatchEvent(ev))

    expect(onClose).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('点浮层外关,点浮层里不关', () => {
    const onClose = vi.fn()
    render(<DismissHarness onClose={onClose} />)

    fireEvent.pointerDown(screen.getByText('inside'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('active=false 零反应 —— 关着的浮层不许还在听键盘和指针', () => {
    const onClose = vi.fn()
    render(<DismissHarness onClose={onClose} active={false} />)

    const ev = escape()
    act(() => void window.dispatchEvent(ev))
    fireEvent.pointerDown(document.body)

    expect(onClose).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('卸载即拆监听(拆得干净:卸载后再打一下 Esc 没有人接)', () => {
    const onClose = vi.fn()
    const view = render(<DismissHarness onClose={onClose} />)
    view.unmount()

    const ev = escape()
    act(() => void window.dispatchEvent(ev))

    expect(onClose).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })
})

/* ── 层叠:Esc 单层退 ─────────────────────────────────────────────────────
 * 「外 Dialog 内 Menu」的形。两层都是 useFloatDismiss 的默认档(认 Esc),
 * 用裸 hook 模拟就够 —— 要验的是**原语的栈**,不是任何一件组件的皮肤。
 * 内层的挂载序在外层之后(它长在外层的 children 里),这正是真机里的次序。
 * ──────────────────────────────────────────────────────────────────────── */

function Layer({
  onClose,
  active = true,
  testId,
  children,
}: {
  onClose: () => void
  active?: boolean
  testId: string
  children?: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useFloatDismiss(ref, onClose, active)
  return (
    <div ref={ref} data-testid={testId}>
      {children}
    </div>
  )
}

/**
 * 「对话框开着,里面又开了一张菜单」的真机形:菜单是 portal 出去的,DOM 上与
 * 对话框面板是**兄弟**,谁也不套着谁 —— 层序只能由入栈序说话。
 * 内层由外层的一次交互开出来,所以它后开、后入栈。
 */
function SiblingStack({
  closeOuter,
  closeInner,
  bumpable = false,
}: {
  closeOuter: () => void
  closeInner: () => void
  bumpable?: boolean
}) {
  const [innerOpen, setInnerOpen] = useState(false)
  const [, bump] = useState(0)
  return (
    <>
      {/* onClose 是就地闭包:每渲染一次都是新函数。进了依赖表就会出栈再入栈。 */}
      <Layer onClose={() => closeOuter()} testId="outer">
        <button type="button" onClick={() => setInnerOpen(true)}>
          open inner
        </button>
        {bumpable && (
          <button type="button" onClick={() => bump((n) => n + 1)}>
            bump
          </button>
        )}
      </Layer>
      {innerOpen && (
        <Layer
          onClose={() => {
            closeInner()
            setInnerOpen(false)
          }}
          testId="inner"
        />
      )}
    </>
  )
}

describe('useFloatDismiss:层叠时只退一层', () => {
  it('后开的那层先退:一下 Esc 只关内层;再一下才关外层', () => {
    const closeOuter = vi.fn()
    const closeInner = vi.fn()
    render(<SiblingStack closeOuter={closeOuter} closeInner={closeInner} />)
    fireEvent.click(screen.getByText('open inner'))

    const first = escape()
    act(() => void window.dispatchEvent(first))
    expect(closeInner).toHaveBeenCalledTimes(1)
    expect(closeOuter).not.toHaveBeenCalled()
    // 认领仍然发生 —— 只是由最上面那一层认领,外壳退层链照旧让位。
    expect(first.defaultPrevented).toBe(true)
    expect(screen.queryByTestId('inner')).toBeNull()

    const second = escape()
    act(() => void window.dispatchEvent(second))
    expect(closeOuter).toHaveBeenCalledTimes(1)
    expect(closeInner).toHaveBeenCalledTimes(1)
    expect(second.defaultPrevented).toBe(true)
  })

  it('套着的形:同一次提交里父子两层都在场,认领的是里面那层(effect 子先于父,入栈序在这一形上是反的)', () => {
    const closeOuter = vi.fn()
    const closeInner = vi.fn()
    render(
      <Layer onClose={closeOuter} testId="outer">
        <Layer onClose={closeInner} testId="inner" />
      </Layer>,
    )

    act(() => void window.dispatchEvent(escape()))
    expect(closeInner).toHaveBeenCalledTimes(1)
    expect(closeOuter).not.toHaveBeenCalled()
  })

  it('内层 escape:false(自己另有 Esc 语义)不进栈,也就不挡住外层', () => {
    const closeOuter = vi.fn()
    const closeInner = vi.fn()

    function Stacked() {
      const ref = useRef<HTMLDivElement>(null)
      // 只要点外关、Esc 归自己 —— composer 就是这一档。
      useFloatDismiss(ref, closeInner, true, { escape: false })
      return (
        <Layer onClose={closeOuter} testId="outer">
          <div ref={ref} data-testid="inner" />
        </Layer>
      )
    }
    render(<Stacked />)

    act(() => void window.dispatchEvent(escape()))
    expect(closeInner).not.toHaveBeenCalled()
    expect(closeOuter).toHaveBeenCalledTimes(1)
  })

  it('外层重渲染不会把自己顶上去(onClose 换了身份也不重排层序)', () => {
    const closeOuter = vi.fn()
    const closeInner = vi.fn()
    render(<SiblingStack closeOuter={closeOuter} closeInner={closeInner} bumpable />)
    fireEvent.click(screen.getByText('open inner'))

    fireEvent.click(screen.getByText('bump'))
    act(() => void window.dispatchEvent(escape()))

    expect(closeInner).toHaveBeenCalledTimes(1)
    expect(closeOuter).not.toHaveBeenCalled()
  })

  it('点外关那条不进栈:内层开着,点在两层外面时两层都收到(各判各的)', () => {
    const closeOuter = vi.fn()
    const closeInner = vi.fn()
    render(
      <Layer onClose={closeOuter} testId="outer">
        <Layer onClose={closeInner} testId="inner" />
      </Layer>,
    )

    fireEvent.pointerDown(document.body)
    expect(closeOuter).toHaveBeenCalledTimes(1)
    expect(closeInner).toHaveBeenCalledTimes(1)
  })

  it('outside:false 只要 Esc 不要点外关(Dialog 那一档)', () => {
    const onClose = vi.fn()
    function Only() {
      const ref = useRef<HTMLDivElement>(null)
      useFloatDismiss(ref, onClose, true, { outside: false })
      return <div ref={ref} data-testid="float" />
    }
    render(<Only />)

    fireEvent.pointerDown(document.body)
    expect(onClose).not.toHaveBeenCalled()

    act(() => void window.dispatchEvent(escape()))
    expect(onClose).toHaveBeenCalledTimes(1)
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

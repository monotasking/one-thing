import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { DragLayer, DropOverlay, resetDragSession, setDropFeedback, useDragSource } from '../drag'
import { focusTree } from '../../focus/registry'
import type { DragSourceSpec } from '../drag'

/**
 * **`ui/drag` 三件的守卫**(W3,派工令交付 1:阈值 / 取消 / 拒绝态 / 松手落定)。
 *
 * jsdom 里 `setPointerCapture` / `releasePointerCapture` 不存在,而这只件的实现
 * 把它们包在 try/catch 里(与 `EdgeShelf` / `FloatWindow` 逐字同一句判)——
 * 所以这里什么都不必补:测的正是「抢不到 capture 也照样工作」那条路。
 *
 * **四发事件一律用 `MouseEvent` 派而不是 `fireEvent.pointerDown`**:jsdom 没有
 * `PointerEvent` 这个构造器,而 testing-library 那一路会退回裸 `Event` ——
 * 于是 `e.button` 是 `undefined`,件里那句「只认主键」当场把整场挡掉(第一版
 * 用例全红的读数就是这个)。`MouseEvent` 带得出 `button` / `clientX` / `clientY`
 * 三格,而件读的就是这三格;React 按**事件名**派合成事件,所以
 * `onPointerDown` 照样收得到。判据与 `components/__tests__/dock-autohide.test.tsx`
 * 那条注释同源。
 */

/** 一颗能拖的按钮。事件序由用例自己派,所以它不需要任何布局。 */
function Source({ spec }: { spec: Omit<DragSourceSpec<string>, 'onStart'> & { payload?: string } }) {
  const onPointerDown = useDragSource<string>({
    ...spec,
    onStart: () => ({ payload: spec.payload ?? 'p1', ghost: { label: '一份文件' } }),
  })
  return (
    <>
      <button type="button" data-testid="src" onPointerDown={onPointerDown}>
        源
      </button>
      <DropOverlay />
      <DragLayer />
    </>
  )
}

/** 按下 → 走一段 → 松手。每一步都是一发真事件(与真机 CDP 派的同形)。 */
function down(el: Element, x = 0, y = 0): void {
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }))
}
function move(el: Element, x: number, y: number): void {
  el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }))
}
function up(el: Element, x: number, y: number): void {
  el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: x, clientY: y }))
}

afterEach(() => {
  // 归零会 notify 还挂着的两层 —— 包进 act 才不会在下一条用例里打出 act 告警。
  act(() => resetDragSession())
})

describe('阈值', () => {
  /*
   * **反证的正面**:阈值改 0 之后这一条会红 —— 「点击不起拖」就是它守的东西。
   * 3px 在 `DRAG_START_PX = 4` 之下,所以整场不该开始。
   */
  it('走不满 DRAG_START_PX 不起拖 —— 一次按下松开仍是普通点击', () => {
    const onDrop = vi.fn()
    render(<Source spec={{ onDrop }} />)
    const src = screen.getByTestId('src')
    act(() => {
      down(src, 100, 100)
      move(src, 103, 100)
      up(src, 103, 100)
    })
    expect(screen.queryByTestId('drag-ghost')).toBeNull()
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('走过阈值 = 起拖,浮影上屏并跟指针', () => {
    render(<Source spec={{}} />)
    const src = screen.getByTestId('src')
    act(() => {
      down(src, 100, 100)
      move(src, 120, 100)
    })
    expect(screen.getByTestId('drag-ghost').textContent).toContain('一份文件')
  })
})

describe('松手落定', () => {
  it('`onDrop` 拿到松手那一点,而且这时会话已经拆干净', () => {
    let ghostAtDrop: Element | null = null
    const onDrop = vi.fn(() => {
      // 次序即语义:落定动作会改树,那一刻不该还有一格活着的拖拽态。
      ghostAtDrop = screen.queryByTestId('drag-ghost')
    })
    render(<Source spec={{ onDrop }} />)
    const src = screen.getByTestId('src')
    act(() => {
      down(src, 100, 100)
      move(src, 200, 300)
      up(src, 200, 300)
    })
    expect(onDrop).toHaveBeenCalledWith({ x: 200, y: 300 }, 'p1')
    expect(ghostAtDrop).toBeNull()
    expect(screen.queryByTestId('drag-ghost')).toBeNull()
  })
})

describe('取消', () => {
  it('pointercancel = 取消,不落定', () => {
    const onDrop = vi.fn()
    const onCancel = vi.fn()
    render(<Source spec={{ onDrop, onCancel }} />)
    const src = screen.getByTestId('src')
    act(() => {
      down(src, 100, 100)
      move(src, 200, 100)
      src.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledWith('p1')
    expect(onDrop).not.toHaveBeenCalled()
    expect(screen.queryByTestId('drag-ghost')).toBeNull()
  })

  /*
   * **Esc 走响应链的瞬态口,不是一条 window listener**(裁定 8 / 不变量 I2)。
   * 这一条直接问树:拖拽期间那张瞬态表里有人,而且它答 true(吃掉这一下)。
   * 反证:把 `registerTransient` 那一段换成 window listener → `ui:consume` 的
   * `keydown-outside-focus` 硬闸当场红(那是零基线的)。
   */
  it('Esc 由 focus 树的瞬态口认领,拖拽当场取消', () => {
    const onCancel = vi.fn()
    render(<Source spec={{ onCancel }} />)
    const src = screen.getByTestId('src')
    act(() => {
      down(src, 100, 100)
      move(src, 200, 100)
    })
    const handlers = focusTree.transientEscapeHandlers()
    expect(handlers.length).toBeGreaterThan(0)
    act(() => {
      // 答 true = 这一下我吃了(tooltip 那一族答 false)。
      expect(handlers[handlers.length - 1]()).toBe(true)
    })
    expect(onCancel).toHaveBeenCalled()
    expect(screen.queryByTestId('drag-ghost')).toBeNull()
    // 拆干净 = 那一格也从瞬态表里销号了。
    expect(focusTree.transientEscapeHandlers().length).toBe(handlers.length - 1)
  })

  it('不拖的时候瞬态表里没有它 —— 没起拖的 Esc 该归别人', () => {
    const before = focusTree.transientEscapeHandlers().length
    render(<Source spec={{}} />)
    const src = screen.getByTestId('src')
    act(() => {
      down(src, 100, 100)
      move(src, 101, 100)
    })
    expect(focusTree.transientEscapeHandlers().length).toBe(before)
  })
})

describe('落点反馈', () => {
  it('接受:高亮盖住那块矩形,**字在浮影下那一行**(W6-b:落区上不写字)', () => {
    render(<Source spec={{ onMove: () => setDropFeedback({ rect: { left: 10, top: 20, width: 100, height: 50 }, tone: 'accept', hint: '钉到右侧架子' }) }} />)
    const src = screen.getByTestId('src')
    act(() => {
      down(src, 100, 100)
      move(src, 200, 100)
    })
    const band = screen.getByTestId('drop-overlay')
    expect(band.getAttribute('data-tone')).toBe('accept')
    // 落区上一个字都没有(设计 v3 §5 贯穿规则 2:唯一出现文字的地方是提示行)。
    expect(band.textContent).toBe('')
    expect(screen.getByTestId('drag-hint').textContent).toBe('钉到右侧架子')
  })

  /*
   * **拒绝不静默**(裁定 7):浮影变灰(`data-refuse`)+ 那一句理由写在提示行上,
   * 加一格根属性把整扇窗的光标换成 not-allowed(W6-b)。
   * 这一条同时钉住「拒绝时不画一块接受色的高亮」——`rect: null`,整块不出现。
   */
  it('拒绝:浮影变灰 + 一句理由 + not-allowed 光标,不画接受色的高亮', () => {
    render(
      <Source
        spec={{ onMove: () => setDropFeedback({ rect: null, tone: 'refuse', hint: '这里不能放' }) }}
      />,
    )
    const src = screen.getByTestId('src')
    act(() => {
      down(src, 100, 100)
      move(src, 200, 100)
    })
    expect(screen.getByTestId('drag-ghost').hasAttribute('data-refuse')).toBe(true)
    expect(screen.getByTestId('drag-hint').textContent).toContain('这里不能放')
    expect(document.documentElement.hasAttribute('data-drag-refuse')).toBe(true)
    expect(screen.queryByTestId('drop-overlay')).toBeNull()
    act(() => {
      up(src, 200, 100)
    })
    // 每条结束路径都摘掉 —— 留着的话整扇窗从此都是禁止光标。
    expect(document.documentElement.hasAttribute('data-drag-refuse')).toBe(false)
  })

  it('松手之后来的那一发反馈什么都不做(不凭空造一格拖拽态)', () => {
    render(<Source spec={{}} />)
    act(() => {
      setDropFeedback({ rect: { left: 0, top: 0, width: 10, height: 10 }, tone: 'accept', hint: '' })
    })
    expect(screen.queryByTestId('drop-overlay')).toBeNull()
  })
})

describe('来源答 null = 这一下不许拖', () => {
  it('整场作废,与普通点击逐字相同', () => {
    const onDrop = vi.fn()
    function Refusing() {
      const onPointerDown = useDragSource<string>({ onStart: () => null, onDrop })
      return (
        <>
          <button type="button" data-testid="src" onPointerDown={onPointerDown}>
            源
          </button>
          <DragLayer />
        </>
      )
    }
    render(<Refusing />)
    const src = screen.getByTestId('src')
    act(() => {
      down(src, 100, 100)
      move(src, 300, 100)
      up(src, 300, 100)
    })
    expect(screen.queryByTestId('drag-ghost')).toBeNull()
    expect(onDrop).not.toHaveBeenCalled()
  })
})

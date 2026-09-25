import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { DragLayer, DropOverlay, resetDragSession, setDropFeedback, useDragSource, useDragState } from '../drag'
import { focusTree } from '../../focus/registry'
import { installWindowFocusSource, reportWindowBlur, resetWindowFocus } from '../../focus/window-focus'
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

/**
 * **取消 = 卡片回家,不飞进落点**(09-25)。从前 Esc / 失焦两条路问的是 `landingRect`,
 * 而消费方答的是落点矩形(分屏板 / 新架子膜),于是按 Esc 之后卡片飞进那块板再消失 ——
 * 看着像落进去了,树却一个字没变。
 */
describe('取消:卡片飞回来源', () => {
  const HOME = { left: 10, top: 20, width: 80, height: 30 }
  const TARGET = { left: 500, top: 400, width: 300, height: 200 }

  /*
   * 前面几条用例起了拖却没松手(「走过阈值 = 起拖」那一条就是),那几场会话的 window
   * 监听还活着 —— 它们会和这里的新会话一起收到 pointercancel,先一步把共享的那一格
   * 清空。产品里同一时刻只有一场;这里先替它们松手收尸。
   */
  beforeEach(() => {
    act(() => {
      window.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }))
      resetDragSession()
    })
  })

  function Probe() {
    const drag = useDragState()
    return <output data-testid="probe">{drag?.landing ? JSON.stringify(drag.landing) : ''}</output>
  }

  function placeSource(el: Element, rect: typeof HOME | null): void {
    Object.assign(el, {
      getBoundingClientRect: () => {
        const r = rect ?? { left: 0, top: 0, width: 0, height: 0 }
        return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r }
      },
    })
  }

  function start(): HTMLElement {
    render(
      <>
        <Source spec={{ landingRect: () => TARGET }} />
        <Probe />
      </>,
    )
    const src = screen.getByTestId('src')
    placeSource(src, HOME)
    act(() => {
      down(src, 100, 100)
      move(src, 400, 300)
    })
    return src
  }

  const landing = () => screen.getByTestId('probe').textContent

  it('Esc:飞回来源的矩形,不是 landingRect 答的落点', () => {
    start()
    const handlers = focusTree.transientEscapeHandlers()
    act(() => {
      handlers[handlers.length - 1]()
    })
    expect(landing()).toBe(JSON.stringify(HOME))
  })

  it('窗口失焦 / pointercancel:同样飞回来源', () => {
    const src = start()
    act(() => {
      src.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }))
    })
    expect(landing()).toBe(JSON.stringify(HOME))
  })

  it('来源此刻量不到(撕出条的标签折成 0 宽):飞回它起拖时站的地方', () => {
    const src = start()
    placeSource(src, null)
    const handlers = focusTree.transientEscapeHandlers()
    act(() => {
      handlers[handlers.length - 1]()
    })
    expect(landing()).toBe(JSON.stringify(HOME))
  })

  it('松手落定照旧飞向落点(这一条没被带走)', () => {
    const src = start()
    act(() => {
      up(src, 400, 300)
    })
    expect(landing()).toBe(JSON.stringify(TARGET))
  })

  it('Esc 之后罩子与根上那格属性当场摘掉,不等松手;松手那一发 click 仍被吃掉', () => {
    const src = start()
    expect(document.querySelector('[data-drag-shield]')).not.toBeNull()
    expect(document.documentElement.hasAttribute('data-drag-active')).toBe(true)
    const handlers = focusTree.transientEscapeHandlers()
    act(() => {
      handlers[handlers.length - 1]()
    })
    expect(document.querySelector('[data-drag-shield]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-drag-active')).toBe(false)
    const clicked = vi.fn()
    src.addEventListener('click', clicked)
    act(() => {
      up(src, 400, 300)
      src.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(clicked).not.toHaveBeenCalled()
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

/**
 * **松在拒绝态上要说出口**(W6-c,设计 v3 §7 播报表的第四句)。
 *
 * 守的是那一句的**产地**:它住在这一场自己松手的那一帧,而不是落定那一头 ——
 * 条内换序那一形的拒绝由消费方的 `inline.drop` 当场吃掉,一步都不经过
 * `workbench/drop-commit.dropRef`,所以站在落定那儿的话有一整族拒绝念不到。
 * 念的是 `drop.hint`(**那句结构化拒绝的理由本身**),不是一句写死的「不行」。
 *
 * 反证:把 `DragSession` 的 `up` 里那句 `if (was === 'dragging' && refused) announce(refused)`
 * 注释掉 → 第一条当场红(播报口里一个字都没有)。
 */
describe('拒绝态松手:播报那句理由', () => {
  /* 播报口是模块级的一个 DOM 节点,活过整个文件 —— 每条用例各读各的那一句。 */
  beforeEach(() => {
    const live = document.querySelector('[data-live="polite"]')
    if (live) live.textContent = ''
  })

  it('念的是 drop.hint 本身', () => {
    vi.useFakeTimers()
    render(<Source spec={{}} />)
    const src = screen.getByTestId('src')
    act(() => {
      down(src, 100, 100)
      move(src, 300, 100)
      setDropFeedback({ rect: null, tone: 'refuse', hint: '两格的标签不能再并' })
    })
    act(() => {
      up(src, 300, 100)
      // `announce` 是先清空再写的那一拍 setTimeout,推完再读。
      vi.advanceTimersByTime(50)
    })
    expect(document.querySelector('[data-live="polite"]')?.textContent?.trim()).toBe(
      '两格的标签不能再并',
    )
    vi.useRealTimers()
  })

  it('接受态松手不念 —— 那一下该说话的是落定,不是这里', () => {
    vi.useFakeTimers()
    render(<Source spec={{}} />)
    const src = screen.getByTestId('src')
    act(() => {
      down(src, 100, 100)
      move(src, 300, 100)
      setDropFeedback({ rect: null, tone: 'accept', hint: '松手放回' })
    })
    act(() => {
      up(src, 300, 100)
      vi.advanceTimersByTime(50)
    })
    expect(document.querySelector('[data-live="polite"]')?.textContent?.trim() ?? '').toBe('')
    vi.useRealTimers()
  })
})


/**
 * **「窗口失焦」只认 `focus/window-focus` 那一个产地**(2026-09-15)。
 *
 * 真机记录(用户四轮真手势拖浏览器 tab):按下 → 这扇窗刚成 key 窗 → 40ms 后 macOS 把
 * 第一响应者还给 WebContentsView → 壳的 `window` 收到 DOM `blur` → 从前这里 `abort()`,
 * 起手前这一场就没了。窗口并没有失焦,所以那一发不算;桌面上「失焦」由主进程推。
 * 反证:把 `subscribeWindowBlur(onWindowBlur)` 换回 `window.addEventListener('blur', …)`
 * → 第一条红(blur 之后拖拽起不了手)。
 */
describe('宿主接管「窗口失焦」时 DOM blur 不取消拖拽', () => {
  afterEach(() => resetWindowFocus())

  it('起手前 DOM blur:照样起手;起手后 DOM blur:照样在拖;宿主报失焦才取消', () => {
    const restore = installWindowFocusSource()
    const onDrop = vi.fn()
    const onCancel = vi.fn()
    render(<Source spec={{ onDrop, onCancel }} />)
    const src = screen.getByTestId('src')
    act(() => { down(src, 0, 0) })
    act(() => { window.dispatchEvent(new Event('blur')) })
    act(() => { move(src, 30, 0) })
    expect(document.documentElement.hasAttribute('data-drag-active')).toBe(true)
    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(document.documentElement.hasAttribute('data-drag-active')).toBe(true)
    act(() => { reportWindowBlur() })
    expect(document.documentElement.hasAttribute('data-drag-active')).toBe(false)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onDrop).not.toHaveBeenCalled()
    restore()
  })

  it('没有宿主源(web 壳):DOM blur 仍旧取消(切走应用那一档一个字没变)', () => {
    const onDrop = vi.fn()
    const onCancel = vi.fn()
    render(<Source spec={{ onDrop, onCancel }} />)
    const src = screen.getByTestId('src')
    act(() => { down(src, 0, 0) })
    act(() => { move(src, 30, 0) })
    expect(document.documentElement.hasAttribute('data-drag-active')).toBe(true)
    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(document.documentElement.hasAttribute('data-drag-active')).toBe(false)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

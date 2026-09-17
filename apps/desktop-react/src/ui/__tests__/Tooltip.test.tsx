import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Tooltip } from '../Tooltip'
import { TOOLTIP_DELAY_MS } from '../../components/motion'
import { focusTree } from '../../focus/registry'

/**
 * Tooltip 的全部行为就是一句话:**悬停够久才出现,一离开立刻收**。
 * 所以用假时钟把「够久」这件事钉死 —— 差一毫秒不出,到点才出。
 * 延迟的默认值取 JS 侧那枚镜像常量,而不是在测试里写一个数:
 * 改 token 时测试跟着走,不需要两边一起改。
 *
 * React 的 onMouseEnter 是由 mouseover/mouseout 那一对合成出来的,
 * 所以这里发的是 mouseOver / mouseOut,不是 mouseEnter(后者 React 收不到,会假绿)。
 */
beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  focusTree.reset()
})

const tip = () => screen.queryByRole('tooltip')

describe('Tooltip:延迟出现,离开即收', () => {
  it('悬停不到时长不出现,到点才出现', () => {
    render(
      <Tooltip content="hint">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    fireEvent.mouseOver(screen.getByText('anchor'))

    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1))
    expect(tip()).toBe(null)

    act(() => void vi.advanceTimersByTime(1))
    expect(tip()?.textContent).toBe('hint')
  })

  it('没到点就离开 = 永远不出现', () => {
    render(
      <Tooltip content="hint">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    const anchor = screen.getByText('anchor')

    fireEvent.mouseOver(anchor)
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1))
    fireEvent.mouseOut(anchor)
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS))
    expect(tip()).toBe(null)
  })

  it('出现之后离开立刻收(退场不留残影)', () => {
    render(
      <Tooltip content="hint">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    const anchor = screen.getByText('anchor')

    fireEvent.mouseOver(anchor)
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS))
    expect(tip()).toBeTruthy()

    fireEvent.mouseOut(anchor)
    expect(tip()).toBe(null)
  })

  it('键盘也能唤起:聚焦同样走延迟', () => {
    render(
      <Tooltip content="hint">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    const anchor = screen.getByText('anchor')
    // 键盘会话 = 浏览器说 `:focus-visible` 成立(jsdom 的 fireEvent.focus 不是真聚焦,这里替它说)。
    const matches = vi.spyOn(anchor, 'matches').mockImplementation(selector => selector === ':focus-visible')
    fireEvent.focus(anchor)
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS))
    expect(tip()?.textContent).toBe('hint')
    matches.mockRestore()
  })

  it('程序置焦(不是键盘会话,`:focus-visible` 不成立)不出提示', () => {
    render(
      <Tooltip content="hint">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    const anchor = screen.getByText('anchor')
    // 鼠标点开一扇窗、树把焦点送进来 = `:focus-visible` 不成立。
    const matches = vi.spyOn(anchor, 'matches').mockImplementation(selector => selector !== ':focus-visible')
    fireEvent.focus(anchor)
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS))
    expect(tip()).toBe(null)
    matches.mockRestore()
  })

  it('delayMs 可由调用方改,组件不写死这个数', () => {
    render(
      <Tooltip content="hint" delayMs={TOOLTIP_DELAY_MS * 3}>
        <button type="button">anchor</button>
      </Tooltip>,
    )
    fireEvent.mouseOver(screen.getByText('anchor'))

    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS))
    expect(tip()).toBe(null)
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS * 2))
    expect(tip()).toBeTruthy()
  })

  /*
   * cloneElement 注入同名 prop 会**静默覆盖**孩子原本那一个 —— 这个模式的经典缺陷:
   * 一颗自己就要听悬停的按钮包进 Tooltip 之后,它那一手再也不响,不报错、不警告。
   * 09-01 改成组合(先孩子、后自己),这两条钉的就是它。
   */
  it('孩子自带的 onMouseEnter 照常响,提示也照常出 —— 注入是组合,不是覆盖', () => {
    const theirs = vi.fn()
    render(
      <Tooltip content="hint">
        <button type="button" onMouseEnter={theirs}>
          anchor
        </button>
      </Tooltip>,
    )
    fireEvent.mouseOver(screen.getByText('anchor'))
    expect(theirs).toHaveBeenCalledTimes(1)

    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS))
    expect(tip()?.textContent).toBe('hint')
  })

  it('孩子自带的 ref 照常拿到节点(锚点 ref 与它并存)', () => {
    const theirs = vi.fn()
    render(
      <Tooltip content="hint">
        <button type="button" ref={theirs}>
          anchor
        </button>
      </Tooltip>,
    )
    // 拿到的就是屏幕上那颗钮 —— 而提示照旧能出(说明我们自己那一份 ref 也接到了)。
    expect(theirs).toHaveBeenCalledWith(screen.getByText('anchor'))

    fireEvent.mouseOver(screen.getByText('anchor'))
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS))
    expect(tip()?.textContent).toBe('hint')
  })

  it('孩子自带的 onMouseLeave / onFocus / onBlur 同样不被吞', () => {
    const leave = vi.fn()
    const focus = vi.fn()
    const blur = vi.fn()
    render(
      <Tooltip content="hint">
        <button type="button" onMouseLeave={leave} onFocus={focus} onBlur={blur}>
          anchor
        </button>
      </Tooltip>,
    )
    const anchor = screen.getByText('anchor')

    fireEvent.mouseOut(anchor)
    fireEvent.focus(anchor)
    fireEvent.blur(anchor)

    expect(leave).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(blur).toHaveBeenCalledTimes(1)
  })

  it('挂在 body 上,不留在锚点里(浮层一律 portal)', () => {
    const { container } = render(
      <Tooltip content="hint">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    fireEvent.mouseOver(screen.getByText('anchor'))
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS))

    expect(container.querySelector('[role="tooltip"]')).toBe(null)
    expect(document.body.contains(tip())).toBe(true)
  })
})

/**
 * **Esc 走响应链的瞬态口**(09-02 R1;从前是这只组件自己在 document 上挂的一条)。
 *
 * 二选一里选的是瞬态口而不是作用域,理由写在 `Tooltip.tsx` 那段注释上:它没有一个
 * 包着触发元素的根 —— 提示体是 portal 出去的,锚点是消费方自己那颗按钮。
 * 行为两条,与从前逐字相同:提示在场时按 Esc 消掉它;**不认领**这一下
 * (APG:tooltip 的 Esc 不该拦别人)。
 */
describe('Tooltip:Esc 消提示(响应链的瞬态口)', () => {
  function shown(): void {
    render(
      <Tooltip content="hint">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    fireEvent.mouseOver(screen.getByText('anchor'))
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS))
    expect(tip()).toBeTruthy()
  }

  it('提示在场 = 瞬态表上有它一格;收掉之后那一格也没了(不挂不属于自己的键)', () => {
    shown()
    expect(focusTree.transientEscapeHandlers().length).toBe(1)

    fireEvent.mouseOut(screen.getByText('anchor'))
    act(() => void vi.advanceTimersByTime(0))
    expect(tip()).toBe(null)
    expect(focusTree.transientEscapeHandlers()).toEqual([])
  })

  it('那一格答 **false** —— 消掉提示,但这一下 Esc 继续传给别人', () => {
    shown()
    const [handler] = focusTree.transientEscapeHandlers()
    let claimed: boolean | undefined
    act(() => {
      claimed = handler()
    })
    expect(claimed).toBe(false)
    expect(tip()).toBe(null)
  })

  it('提示还没出现时表上一格都没有', () => {
    render(
      <Tooltip content="hint">
        <button type="button">anchor</button>
      </Tooltip>,
    )
    expect(focusTree.transientEscapeHandlers()).toEqual([])
  })
})

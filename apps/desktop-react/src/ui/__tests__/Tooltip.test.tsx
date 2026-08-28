import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Tooltip } from '../Tooltip'
import { TOOLTIP_DELAY_MS } from '../../components/motion'

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
    fireEvent.focus(screen.getByText('anchor'))
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS))
    expect(tip()?.textContent).toBe('hint')
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

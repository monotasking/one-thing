import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Checkbox } from '../Checkbox'

/**
 * indeterminate 在 HTML 里没有属性,只有 DOM 字段 —— 它是最容易「看着对、其实没设上」
 * 的一格,所以这里直接断言那个 DOM 字段,而不是断言画了一横。
 */
describe('Checkbox:三态与受控', () => {
  it('indeterminate 落到真正的 DOM 字段上', () => {
    const { rerender } = render(<Checkbox checked={false} onChange={() => {}} label="c" />)
    const el = screen.getByLabelText('c') as HTMLInputElement
    expect(el.indeterminate).toBe(false)

    rerender(<Checkbox checked={false} indeterminate onChange={() => {}} label="c" />)
    expect((screen.getByLabelText('c') as HTMLInputElement).indeterminate).toBe(true)
  })

  it('半选态点一下走的是「勾上」,不是再半选一次', () => {
    const onChange = vi.fn()
    render(<Checkbox checked={false} indeterminate onChange={onChange} label="c" />)
    fireEvent.click(screen.getByLabelText('c'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('受控:点一下只交出新值,checked 不自己翻', () => {
    const onChange = vi.fn()
    render(<Checkbox checked onChange={onChange} label="c" />)
    const el = screen.getByLabelText('c') as HTMLInputElement

    fireEvent.click(el)
    expect(onChange).toHaveBeenCalledWith(false)
    expect(el.checked).toBe(true)
  })

  // 同 Input:disabled 的执行者是原生元素,jsdom 的 fireEvent 绕得过去,
  // 所以断言机制在位(原生 disabled + 外框降透明度),不断言「没回调」。
  it('禁用落到原生 input 上,外框同时进降级态', () => {
    const { container } = render(<Checkbox checked={false} onChange={() => {}} disabled label="c" />)
    expect((screen.getByLabelText('c') as HTMLInputElement).disabled).toBe(true)
    expect(container.firstElementChild?.className).toMatch(/disabled/)
  })

  it('只读:不变淡、不进 Tab 序、读屏念只读,点了不翻也不交值', () => {
    const onChange = vi.fn()
    const { container } = render(<Checkbox checked={false} onChange={onChange} readOnly label="c" />)
    const el = screen.getByLabelText('c') as HTMLInputElement
    expect(el.getAttribute('aria-readonly')).toBe('true')
    expect(el.tabIndex).toBe(-1)
    expect(container.firstElementChild?.className).not.toMatch(/disabled/)
    fireEvent.click(el)
    expect(el.checked).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })
})

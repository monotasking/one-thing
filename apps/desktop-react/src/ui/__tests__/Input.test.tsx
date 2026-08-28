import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Input } from '../Input'

/**
 * Input 是**受控**的:它自己不存值。这一批钉的就是这件事 ——
 * 打字只是把新值交出去,屏幕上变不变由调用方说了算。
 * 一旦哪天有人给它加了内部 state,第一条用例就会红。
 */
describe('Input:受控与禁用', () => {
  it('打字交出新值,自己不改显示', () => {
    const onValueChange = vi.fn()
    render(<Input value="a" onValueChange={onValueChange} aria-label="f" />)
    const el = screen.getByLabelText('f') as HTMLInputElement

    fireEvent.change(el, { target: { value: 'ab' } })
    expect(onValueChange).toHaveBeenCalledWith('ab')
    // 调用方没回写,所以屏幕上仍是旧值 —— 这正是「受控」的定义
    expect(el.value).toBe('a')
  })

  // 注:disabled 由原生元素执行(真浏览器根本不派发事件);jsdom 的 fireEvent 是直接
  // 往元素上 dispatch,绕过了那一层,所以这里断言的是**机制在位**而不是「回调没被调」——
  // 后者在 jsdom 里恒假,写了也是假绿。
  it('禁用落到原生 input 上,并把禁用态一起交给外框', () => {
    render(<Input value="a" onValueChange={() => {}} disabled aria-label="f" />)
    const el = screen.getByLabelText('f') as HTMLInputElement

    expect(el.disabled).toBe(true)
    expect(el.parentElement?.className).toMatch(/disabled/)
  })

  it('invalid 只上 aria-invalid,不改值也不拦输入', () => {
    const onValueChange = vi.fn()
    render(<Input value="a" onValueChange={onValueChange} invalid aria-label="f" />)
    const el = screen.getByLabelText('f')

    expect(el.getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(el, { target: { value: 'ab' } })
    expect(onValueChange).toHaveBeenCalledWith('ab')
  })

  it('前后槽给了才占位', () => {
    const { container, rerender } = render(<Input value="" onValueChange={() => {}} aria-label="f" />)
    const count = () => container.querySelectorAll('span').length
    expect(count()).toBe(0)

    rerender(<Input value="" onValueChange={() => {}} aria-label="f" prefix={<i />} suffix={<i />} />)
    expect(count()).toBe(2)
  })
})

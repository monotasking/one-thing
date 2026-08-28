import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Spinner } from '../Spinner'

/**
 * Spinner 没有行为,只有形态与无障碍语义 —— 所以这里只钉两件:
 * 两档尺寸各挂各的类(不是同一个类加内联尺寸),以及
 * 「给了 label 才对读屏可见,不给就是纯装饰」这条二选一,不许两头都占。
 */
describe('Spinner:形态与无障碍', () => {
  it('两档尺寸各挂各的类,基础类相同', () => {
    const { container, rerender } = render(<Spinner size="sm" />)
    const sm = (container.firstElementChild as HTMLElement).className
    rerender(<Spinner size="md" />)
    const md = (container.firstElementChild as HTMLElement).className

    expect(sm).not.toBe(md)
    expect(sm.split(' ')[0]).toBe(md.split(' ')[0])
  })

  it('默认 sm', () => {
    const { container, rerender } = render(<Spinner />)
    const bare = (container.firstElementChild as HTMLElement).className
    rerender(<Spinner size="sm" />)
    expect((container.firstElementChild as HTMLElement).className).toBe(bare)
  })

  it('不给 label = 纯装饰:aria-hidden,读屏里没有它', () => {
    const { container } = render(<Spinner />)
    const el = container.firstElementChild as HTMLElement
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.getAttribute('role')).toBe(null)
  })

  it('给了 label = 一个状态:role=status 且不再 aria-hidden', () => {
    render(<Spinner label="Loading" />)
    const el = screen.getByRole('status')
    expect(el.getAttribute('aria-label')).toBe('Loading')
    expect(el.getAttribute('aria-hidden')).toBe(null)
  })
})

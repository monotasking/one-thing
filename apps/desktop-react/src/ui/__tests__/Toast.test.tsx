import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ToastHost, useToastHub } from '../Toast'
import { TOAST_LIFE_MS } from '../../components/motion'

/**
 * Toast 的合同就三条:入队即出现、活满 --dur-toast-life 自动消失、hover 期间**暂停计时**。
 * 第三条是最容易做成「重新计时」的一格 —— 所以这里特意先烧掉一半再 hover,
 * 松开后只推进剩下那一半:重新计时的实现会在这一步仍然留着,当场红。
 *
 * 时长同样取 JS 侧镜像常量,不在测试里写数。
 */
beforeEach(() => {
  vi.useFakeTimers()
  useToastHub.setState({ toasts: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

const push = (msg: string) => act(() => void useToastHub.getState().push(msg))

describe('Toast:入队与自动消失', () => {
  it('入队即出现,活满时长自动消失', () => {
    render(<ToastHost />)
    push('saved')
    expect(screen.getByText('saved')).toBeTruthy()

    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS - 1))
    expect(screen.queryByText('saved')).toBeTruthy()

    act(() => void vi.advanceTimersByTime(1))
    expect(screen.queryByText('saved')).toBe(null)
  })

  it('多条按入队次序堆叠,各自计各自的时', () => {
    render(<ToastHost />)
    push('one')
    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS / 2))
    push('two')

    const rows = screen.getAllByRole('status')
    expect(rows.map((r) => r.textContent)).toEqual(['one', 'two'])

    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS / 2))
    expect(screen.queryByText('one')).toBe(null)
    expect(screen.queryByText('two')).toBeTruthy()
  })

  it('hover 是暂停不是重来:烧掉一半再悬停,松开只需再走一半', () => {
    render(<ToastHost />)
    push('hold')

    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS / 2))
    fireEvent.mouseOver(screen.getByRole('status'))

    // 悬停期间时钟照走,但它不该被计进寿命
    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS * 2))
    expect(screen.queryByText('hold')).toBeTruthy()

    fireEvent.mouseOut(screen.getByRole('status'))
    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS / 2))
    expect(screen.queryByText('hold')).toBe(null)
  })

  it('三个变体只换左侧图标,底色是同一个(角色都是 status)', () => {
    render(<ToastHost />)
    act(() => {
      const { push: p } = useToastHub.getState()
      p('a', 'info')
      p('b', 'success')
      p('c', 'danger')
    })
    const rows = screen.getAllByRole('status')
    expect(rows.length).toBe(3)
    // 变体类名各不相同,但基础类名是同一个
    const base = rows.map((r) => r.className.split(' ')[0])
    expect(new Set(base).size).toBe(1)
    expect(new Set(rows.map((r) => r.className)).size).toBe(3)
  })

  it('空队列时连容器都不挂;有内容时挂在 body 上(浮层一律 portal)', () => {
    const { container } = render(<ToastHost />)
    expect(container.firstChild).toBe(null)

    push('x')
    expect(container.querySelector('[role="status"]')).toBe(null)
    expect(document.body.contains(screen.getByRole('status'))).toBe(true)
  })
})

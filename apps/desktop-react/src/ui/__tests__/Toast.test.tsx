import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MAX_VISIBLE_TOASTS, ToastHost, useToastHub } from '../Toast'
import type { ToastLevel } from '../Toast'
import { TOAST_LIFE_MS } from '../../components/motion'

/**
 * Toast 的合同:入队即出现、**按级别活满各自的时长**、hover 期间暂停计时、
 * error 不自动消失(只有 ✕ 能关)、同屏最多三条更早的折成一枚小丸。
 *
 * 「hover = 暂停而不是重来」是最容易做错的一格 —— 所以这里特意先烧掉一半再 hover,
 * 松开后只推进剩下那一半:重新计时的实现会在这一步仍然留着,当场红。
 *
 * 时长一律取 JS 侧镜像常量,不在测试里写数。
 */
beforeEach(() => {
  vi.useFakeTimers()
  useToastHub.setState({ toasts: [], folded: 0 })
})

afterEach(() => {
  vi.useRealTimers()
})

const push = (title: string, level: ToastLevel = 'info') =>
  act(() =>
    void useToastHub.getState().push({
      level,
      title,
      lifeMs: level === 'error' ? null : TOAST_LIFE_MS[level],
    }),
  )

describe('Toast:入队与自动消失', () => {
  it('入队即出现,活满时长自动消失', () => {
    render(<ToastHost />)
    push('saved')
    expect(screen.getByText('saved')).toBeTruthy()

    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS.info - 1))
    expect(screen.queryByText('saved')).toBeTruthy()

    act(() => void vi.advanceTimersByTime(1))
    expect(screen.queryByText('saved')).toBe(null)
  })

  it('多条按入队次序堆叠,各自计各自的时', () => {
    render(<ToastHost />)
    push('one')
    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS.info / 2))
    push('two')

    const rows = screen.getAllByRole('status')
    expect(rows.map((r) => r.textContent)).toEqual(['one', 'two'])

    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS.info / 2))
    expect(screen.queryByText('one')).toBe(null)
    expect(screen.queryByText('two')).toBeTruthy()
  })

  it('hover 是暂停不是重来:烧掉一半再悬停,松开只需再走一半', () => {
    render(<ToastHost />)
    push('hold')

    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS.info / 2))
    fireEvent.mouseOver(screen.getByRole('status'))

    // 悬停期间时钟照走,但它不该被计进寿命
    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS.info * 2))
    expect(screen.queryByText('hold')).toBeTruthy()

    fireEvent.mouseOut(screen.getByRole('status'))
    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS.info / 2))
    expect(screen.queryByText('hold')).toBe(null)
  })

  it('四个变体只换左侧图标,底色是同一个(角色都是 status)', () => {
    render(<ToastHost />)
    push('a', 'info')
    push('b', 'success')
    push('c', 'warn')
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

describe('Toast:命运按级别分档', () => {
  it('success 3s / info 4s / warn 8s —— 各自到点各自走', () => {
    render(<ToastHost />)
    push('ok', 'success')
    push('note', 'info')
    push('careful', 'warn')

    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS.success))
    expect(screen.queryByText('ok')).toBe(null)
    expect(screen.queryByText('note')).toBeTruthy()

    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS.info - TOAST_LIFE_MS.success))
    expect(screen.queryByText('note')).toBe(null)
    expect(screen.queryByText('careful')).toBeTruthy()

    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS.warn))
    expect(screen.queryByText('careful')).toBe(null)
  })

  it('error 不自动消失:等到天荒地老仍在,点 ✕ 才走', () => {
    render(<ToastHost closeLabel="关闭" />)
    push('broke', 'error')

    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS.warn * 10))
    expect(screen.queryByText('broke')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('关闭'))
    expect(screen.queryByText('broke')).toBe(null)
  })

  it('会自己走的那几档画剩余时间线,不自动消失的那一档画 ✕ —— 两者互斥', () => {
    render(<ToastHost closeLabel="关闭" />)
    push('timed', 'info')
    expect(screen.getByTestId('toast-life')).toBeTruthy()
    expect(screen.queryByLabelText('关闭')).toBe(null)

    push('stuck', 'error')
    expect(screen.getAllByTestId('toast-life').length).toBe(1)
    expect(screen.getAllByLabelText('关闭').length).toBe(1)
  })

  it('剩余时间线的时长就是这一条的寿命,悬停时它跟着停', () => {
    render(<ToastHost />)
    push('careful', 'warn')
    const line = screen.getByTestId('toast-life')
    expect(line.style.animationDuration).toBe(`${TOAST_LIFE_MS.warn}ms`)
    expect(line.style.animationPlayState).toBe('running')

    fireEvent.mouseOver(screen.getByRole('status'))
    expect(screen.getByTestId('toast-life').style.animationPlayState).toBe('paused')
  })
})

describe('Toast:同屏最多三条', () => {
  it('第四条来了,最早那条折进小丸(它已经进了中心,屏幕上只留一句「还有几条」)', () => {
    render(<ToastHost moreText={(n) => `+${n} 更早`} />)
    push('a')
    push('b')
    push('c')
    expect(screen.getAllByRole('status').length).toBe(MAX_VISIBLE_TOASTS)
    expect(screen.queryByText('+1 更早')).toBe(null)

    push('d')
    expect(screen.getAllByRole('status').map((r) => r.textContent)).toEqual(['b', 'c', 'd'])
    expect(screen.getByText('+1 更早')).toBeTruthy()

    push('e')
    expect(screen.getByText('+2 更早')).toBeTruthy()
  })

  it('折走的那条不再计时也不再回来 —— 时钟随它一起退场,数只由新的挤压推高', () => {
    render(<ToastHost moreText={(n) => `+${n} 更早`} />)
    push('a')
    push('b')
    push('c')
    push('d')
    act(() => void vi.advanceTimersByTime(TOAST_LIFE_MS.info * 3))
    // 三条到点走光 → 丸没有可依附的东西了,一起收
    expect(screen.queryByRole('status')).toBe(null)
    expect(useToastHub.getState().folded).toBe(0)
  })

  it('点小丸:数清零并把「打开中心」那件事交回宿主', () => {
    const onMore = vi.fn()
    render(<ToastHost moreText={(n) => `+${n} 更早`} onMore={onMore} />)
    push('a')
    push('b')
    push('c')
    push('d')
    fireEvent.click(screen.getByText('+1 更早'))
    expect(onMore).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('+1 更早')).toBe(null)
  })

  it('宿主不给文案就不画丸 —— 组件自己不造字面文案', () => {
    render(<ToastHost />)
    push('a')
    push('b')
    push('c')
    push('d')
    expect(useToastHub.getState().folded).toBe(1)
    expect(screen.getAllByRole('status').length).toBe(MAX_VISIBLE_TOASTS)
  })
})

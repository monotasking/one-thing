import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SessionCard } from './SessionCard'
import { SESSIONS } from '../data'

/**
 * Quick Look 的**鼠标**入口。键盘入口(Space)一直都在,这里补的是鼠标那条。
 *
 * 两条要钉住:
 * 1. 它**占位常驻** —— 不是 hover 才渲染出来的。条件渲染会在出现的那一帧挤动布局,
 *    而这一批的规矩是「hover 只改样式,不动位置」。
 * 2. 它不嵌在卡这个 <button> 里(那是非法 HTML,浏览器会当场拆开),
 *    所以点它只触发预览,不会顺带触发「进入」。
 */
const session = SESSIONS[0]

function setup() {
  const onEnter = vi.fn()
  const onQuickLook = vi.fn()
  render(
    <SessionCard
      session={session}
      current={false}
      focused={false}
      onEnter={onEnter}
      onQuickLook={onQuickLook}
    />,
  )
  return { onEnter, onQuickLook }
}

describe('会话卡:Quick Look 鼠标入口', () => {
  it('没 hover 时也在 DOM 里(占位常驻,只动 opacity)', () => {
    setup()
    expect(screen.getByTestId(`card-preview-${session.id}`)).toBeTruthy()
  })

  it('点它 = 预览,不触发进入', () => {
    const { onEnter, onQuickLook } = setup()
    fireEvent.click(screen.getByTestId(`card-preview-${session.id}`))
    expect(onQuickLook).toHaveBeenCalledTimes(1)
    expect(onEnter).not.toHaveBeenCalled()
  })

  it('点卡面仍然是进入,预览没被误触', () => {
    const { onEnter, onQuickLook } = setup()
    fireEvent.click(screen.getByText(session.title))
    expect(onEnter).toHaveBeenCalledTimes(1)
    expect(onQuickLook).not.toHaveBeenCalled()
  })

  it('预览按钮不是卡那个 button 的后代 —— button 套 button 是非法 HTML', () => {
    setup()
    const preview = screen.getByTestId(`card-preview-${session.id}`)
    const card = screen.getByText(session.title).closest('button')
    expect(card).toBeTruthy()
    expect(card?.contains(preview)).toBe(false)
  })
})

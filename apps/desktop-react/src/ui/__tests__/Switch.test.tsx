import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Switch } from '../Switch'

/**
 * 开关的语义是「开 / 关」,不是「已选中」—— 所以角色必须是 switch 且带 aria-checked。
 * 它同样是受控的:点一下只交出「反过来的那个值」,自己不翻。
 */
describe('Switch:切换与无障碍语义', () => {
  it('角色是 switch,aria-checked 跟着 checked 走', () => {
    const { rerender } = render(<Switch checked={false} onChange={() => {}} label="s" />)
    const el = screen.getByRole('switch')
    expect(el.getAttribute('aria-checked')).toBe('false')

    rerender(<Switch checked onChange={() => {}} label="s" />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('点一下交出取反的值,自身状态不动', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} onChange={onChange} label="s" />)
    const el = screen.getByRole('switch')

    fireEvent.click(el)
    expect(onChange).toHaveBeenCalledWith(true)
    expect(el.getAttribute('aria-checked')).toBe('false')
  })

  it('禁用时点不动', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} onChange={onChange} disabled label="s" />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('无障碍名由调用方给,不落在组件里', () => {
    render(<Switch checked onChange={() => {}} label="Dock autohide" />)
    expect(screen.getByRole('switch').getAttribute('aria-label')).toBe('Dock autohide')
  })
})

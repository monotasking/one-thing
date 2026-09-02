import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { InlineEditStrip } from '../InlineEditStrip'
import { Input } from '../Input'

/**
 * `ui/InlineEditStrip` 的门。判据逐条对着文件头的三张状态表:
 *   · 四格(前缀 / 控件 / 主钮 / 取消)按序在场,缺席的格**不渲染 DOM**;
 *   · `canSave=false` 时主钮禁,取消照旧可点;
 *   · busy:主钮换文案 + `aria-busy` + 一枚转圈,取消一并禁
 *     (写已经发出去了,「取消」取消不掉它);
 *   · 没有控件槽的那一形(删除确认)仍然是一条完整的条 —— 那是它不另立一件的理由;
 *   · 主钮的语气(primary / danger)只换皮肤,不换行为。
 */
function strip(over: Partial<Parameters<typeof InlineEditStrip>[0]> = {}) {
  return (
    <InlineEditStrip
      saveLabel="保存"
      savingLabel="正在保存…"
      cancelLabel="取消"
      onCommit={() => {}}
      onCancel={() => {}}
      {...over}
    />
  )
}

describe('InlineEditStrip', () => {
  it('四格按序在场;缺席的格不渲染 DOM', () => {
    const { container } = render(
      strip({
        prefix: <span>sk-f44••••a477 →</span>,
        children: <Input aria-label="新密钥" value="" onValueChange={() => {}} />,
      }),
    )
    expect(screen.getByText('sk-f44••••a477 →')).toBeTruthy()
    expect(screen.getByLabelText('新密钥')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()
    // 不给前缀就一个像素都不占。
    const { container: bare } = render(strip())
    expect(bare.querySelectorAll('span').length).toBeLessThan(
      container.querySelectorAll('span').length,
    )
  })

  it('canSave=false 时主钮禁,取消照旧可点 —— 空值拦的是提交,不是退路', () => {
    const onCancel = vi.fn()
    render(strip({ canSave: false, onCancel }))
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('busy:主钮换文案 + aria-busy + 一枚转圈,取消一并禁', () => {
    const onCommit = vi.fn()
    const { container } = render(strip({ busy: true, onCommit }))
    const save = screen.getByRole('button', { name: /正在保存/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(save.getAttribute('aria-busy')).toBe('true')
    // 转圈**在钮里**(Spinner 仅有的两个合法位之一)。
    expect(save.querySelector('span')).toBeTruthy()
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy()
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(save)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('没有控件槽的那一形(删除确认)仍是一条完整的条', () => {
    const onCommit = vi.fn()
    render(
      strip({
        prefix: <span>删掉这一条?</span>,
        tone: 'danger',
        saveLabel: '删除',
        onCommit,
      }),
    )
    expect(screen.getByText('删掉这一条?')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('主钮的语气只换皮肤,不换行为 —— danger 与 primary 的点击路径逐字相同', () => {
    const primary = vi.fn()
    const danger = vi.fn()
    const { unmount } = render(strip({ onCommit: primary }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    unmount()
    render(strip({ tone: 'danger', onCommit: danger }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(primary).toHaveBeenCalledTimes(1)
    expect(danger).toHaveBeenCalledTimes(1)
  })
})

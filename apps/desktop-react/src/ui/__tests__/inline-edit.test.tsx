import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { useInlineEdit } from '../inline-edit'

/**
 * `useInlineEdit` 的门。五条性质各配一个反证:
 *   · `↵` 落定、`Esc` 收回,两者都 `preventDefault`(撞键裁决靠它);
 *   · 一进来就 focus + **select 全文**(接着打就是覆盖,不是往后接);
 *   · `cancelOnBlur` 缺省 **不挂** onBlur —— 并肩站着提交钮的那一形靠这条活着;
 *   · 打开 `cancelOnBlur` 时失焦 = 取消;
 *   · 重渲**不重新拽光标**(回调走 ref,不进依赖)。
 */

function Host({
  cancelOnBlur,
  onCommit,
  onCancel,
}: {
  cancelOnBlur?: boolean
  onCommit: () => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('sk-old-value')
  // 现写的箭头函数 —— 正是「每次重渲身份都变」的那一形。
  const edit = useInlineEdit({
    controlId: 'probe',
    onCommit: () => onCommit(),
    onCancel: () => onCancel(),
    cancelOnBlur,
  })
  return (
    <input
      id="probe"
      data-testid="probe"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      {...edit}
    />
  )
}

function probe(): HTMLInputElement {
  return screen.getByTestId('probe') as HTMLInputElement
}

describe('useInlineEdit:原地编辑那一格的手势', () => {
  it('↵ 落定,并按下 default —— 全局派发器据此让路', () => {
    const onCommit = vi.fn()
    render(<Host onCommit={onCommit} onCancel={vi.fn()} />)
    const event = fireEvent.keyDown(probe(), { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledTimes(1)
    // fireEvent 返回「没有被 preventDefault」为 true。
    expect(event).toBe(false)
  })

  it('Esc 收回,同样按下 default', () => {
    const onCancel = vi.fn()
    render(<Host onCommit={vi.fn()} onCancel={onCancel} />)
    const event = fireEvent.keyDown(probe(), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(event).toBe(false)
  })

  it('别的键一个都不接 —— 打字不该被这件看见', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<Host onCommit={onCommit} onCancel={onCancel} />)
    const event = fireEvent.keyDown(probe(), { key: 'a' })
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(event).toBe(true)
  })

  it('一进来就聚焦并选中全文 —— 接着打是覆盖不是追加', () => {
    render(<Host onCommit={vi.fn()} onCancel={vi.fn()} />)
    const el = probe()
    expect(document.activeElement).toBe(el)
    expect(el.selectionStart).toBe(0)
    expect(el.selectionEnd).toBe('sk-old-value'.length)
  })

  it('缺省不挂失焦 —— 并肩的提交钮才点得到(blur 在 click 之前到)', () => {
    const onCancel = vi.fn()
    render(<Host onCommit={vi.fn()} onCancel={onCancel} />)
    fireEvent.blur(probe())
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('打开 cancelOnBlur:失焦 = 取消', () => {
    const onCancel = vi.fn()
    render(<Host cancelOnBlur onCommit={vi.fn()} onCancel={onCancel} />)
    fireEvent.blur(probe())
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('重渲不把光标重新拽回开头 —— 回调走 ref,不进依赖', () => {
    render(<Host onCommit={vi.fn()} onCancel={vi.fn()} />)
    const el = probe()
    fireEvent.change(el, { target: { value: 'sk-typed' } })
    el.setSelectionRange(3, 3)
    // 再重渲一次(回调身份又变了一轮)。
    fireEvent.change(el, { target: { value: 'sk-typed2' } })
    expect(el.selectionStart).toBe(9)
    expect(el.selectionEnd).toBe(9)
  })
})

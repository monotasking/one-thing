import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Select } from '../Select'

/**
 * Select 是「触发器 + 既有的 Menu」拼出来的,所以这里不重测菜单的定位与 Esc
 * (那是 Menu 的事),只测拼接处的三件:开合、选中回调、以及**再点触发器要能收起**。
 *
 * 第三件是有来历的:Menu 的「点外关」听 window 上的 pointerdown,而触发器就在菜单外面。
 * 不在触发器上拦住那一下,第二次点会先关再开 —— 屏幕上看起来是「点了没反应」。
 * 这条用例就是钉那个坑的。
 */
const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
]

describe('Select:开合与选中', () => {
  it('默认收起,触发器显示当前项的 label', () => {
    render(<Select options={OPTIONS} value="b" onChange={() => {}} label="m" />)
    const trigger = screen.getByRole('combobox', { name: 'm' })
    expect(trigger.textContent).toContain('Beta')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('listbox')).toBe(null)
  })

  it('点触发器展开,菜单里每个选项一行,当前项打勾', () => {
    render(<Select options={OPTIONS} value="b" onChange={() => {}} label="m" />)
    fireEvent.click(screen.getByRole('combobox', { name: 'm' }))

    expect(screen.getByRole('listbox')).toBeTruthy()
    const items = screen.getAllByRole('option')
    expect(items.map((el) => el.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  })

  it('APG listbox 语义:触发器 combobox + aria-controls 指着展开的那块面板', () => {
    render(<Select options={OPTIONS} value="b" onChange={() => {}} label="m" />)
    const trigger = screen.getByRole('combobox', { name: 'm' })
    // 收起时不指:指一个还没渲染出来的 id 是一条断掉的引用。
    expect(trigger.getAttribute('aria-controls')).toBe(null)

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id)
  })

  it('触发器上按 ↓ 也展开(APG combobox 那一下)', () => {
    render(<Select options={OPTIONS} value="b" onChange={() => {}} label="m" />)
    const trigger = screen.getByRole('combobox', { name: 'm' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('面板里方向键走选项,整组只占一个 Tab 位', () => {
    render(<Select options={OPTIONS} value="b" onChange={() => {}} label="m" />)
    fireEvent.click(screen.getByRole('combobox', { name: 'm' }))
    const list = screen.getByRole('listbox')
    const items = screen.getAllByRole('option')
    // 初始:Tab 位落在当前选中的那一项(Beta)上。
    expect(items.map((el) => el.tabIndex)).toEqual([-1, 0])

    items[1].focus()
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[0])
    expect(items.map((el) => el.tabIndex)).toEqual([0, -1])
  })

  it('选一项 = 交出 value 并收起', () => {
    const onChange = vi.fn()
    render(<Select options={OPTIONS} value="b" onChange={onChange} label="m" />)
    fireEvent.click(screen.getByRole('combobox', { name: 'm' }))
    fireEvent.click(screen.getByRole('option', { name: 'Alpha' }))

    expect(onChange).toHaveBeenCalledWith('a')
    expect(screen.queryByRole('listbox')).toBe(null)
  })

  it('再点一次触发器收起(pointerdown 被拦住,不会先关再开)', () => {
    render(<Select options={OPTIONS} value="b" onChange={() => {}} label="m" />)
    const trigger = screen.getByRole('combobox', { name: 'm' })

    fireEvent.click(trigger)
    expect(screen.getByRole('listbox')).toBeTruthy()

    // 真实点击是 pointerdown 在前、click 在后;两下都发,才复现得出那个坑
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    expect(screen.queryByRole('listbox')).toBe(null)
  })

  it('禁用时展不开', () => {
    render(<Select options={OPTIONS} value="b" onChange={() => {}} disabled label="m" />)
    const trigger = screen.getByRole('combobox', { name: 'm' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(screen.queryByRole('listbox')).toBe(null)
  })
})

import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../Menu'

/**
 * A11y 线 · A2:菜单的**键盘路**与角色。
 *
 * roving 与 focus-trap 的机制各有自己的用例(ui/a11y/__tests__/),这里验的是接线:
 * 菜单开出来焦点真的进去了、方向键真的走项、Esc 真的把焦点还给开它的那个元素、
 * 项的角色真的随容器的 role 走(menu → menuitem,listbox → option)。
 */
function Harness({ role }: { role?: 'menu' | 'listbox' }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <Menu x={10} y={10} role={role} onClose={() => setOpen(false)} label="m">
          <MenuSection>组</MenuSection>
          <MenuItem onClick={() => {}}>一</MenuItem>
          <MenuItem onClick={() => {}}>二</MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => {}}>三</MenuItem>
        </Menu>
      )}
    </>
  )
}

describe('Menu:键盘路', () => {
  it('开出来焦点进容器,↑↓ 走项,整组只占一个 Tab 位', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('opener'))
    const menu = screen.getByRole('menu')
    expect(document.activeElement).toBe(menu)

    const items = screen.getAllByRole('menuitem')
    expect(items.map((el) => el.tabIndex)).toEqual([0, -1, -1])

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    expect(items.map((el) => el.tabIndex)).toEqual([-1, 0, -1])

    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(items[2])

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])
  })

  it('Esc 关,焦点还给开它的那个元素', () => {
    render(<Harness />)
    const opener = screen.getByTestId('opener')
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('menu')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBe(null)
    expect(document.activeElement).toBe(opener)
  })

  it('Tab 圈在菜单里 —— 浮层开着时焦点不许溜到后面那一屏', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('opener'))
    const items = screen.getAllByRole('menuitem')

    items[2].focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(items[0])

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(items[2])
  })

  it('项的角色由容器决定:listbox 档下是 option,不是 menuitem', () => {
    render(<Harness role="listbox" />)
    fireEvent.click(screen.getByTestId('opener'))
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(screen.getAllByRole('option').length).toBe(3)
    expect(screen.queryAllByRole('menuitem').length).toBe(0)
  })

  it('小节标题不是菜单树的一员(role=presentation),分隔线是 separator', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('opener'))
    expect(screen.getByText('组').getAttribute('role')).toBe('presentation')
    expect(screen.getByRole('separator')).toBeTruthy()
  })

  it('单选项报 menuitemradio + aria-checked', () => {
    const onClick = vi.fn()
    render(
      <Menu x={0} y={0} onClose={() => {}} label="m">
        <MenuItem checked onClick={onClick}>
          选中的
        </MenuItem>
        <MenuItem checked={false} onClick={() => {}}>
          没选中的
        </MenuItem>
      </Menu>,
    )
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map((el) => el.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    fireEvent.click(items[0])
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

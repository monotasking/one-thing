import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../Menu'
import { FocusScope } from '../../focus/FocusScope'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'

/**
 * A11y 线 · A2:菜单的**键盘路**与角色。
 *
 * roving 的机制有自己的用例(ui/a11y/__tests__/),Tab 圈禁与 Esc 退一层归响应链
 * (src/focus/__tests__/),这里验的是接线:菜单开出来焦点真的进去了、方向键真的
 * 走项、Esc 真的关掉它并把焦点还回去、项的角色真的随容器的 role 走
 * (menu → menuitem,listbox → option)。
 *
 * **夹具里多了两件**(09-02 R1):一格 `root` 作用域(菜单在树上是它的孩子,
 * 焦点归还就还到这一格上次所在的元素 = 那颗 opener)与那一个派发器
 * (`FocusDispatchHarness`)—— 从前 Esc / Tab 是 Menu 自己挂的监听,现在它们是
 * 声明,听键盘的只有外壳上那一个。
 */
function Harness({ role }: { role?: 'menu' | 'listbox' }) {
  const [open, setOpen] = useState(false)
  return (
    <FocusScope scope="root">
      {({ scopeProps }) => (
        <div {...scopeProps}>
          <FocusDispatchHarness />
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
        </div>
      )}
    </FocusScope>
  )
}

afterEach(() => {
  focusTree.reset()
})

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

/* ── danger + 两段就地确认(09-01,自定义 provider 删除的落点)──────────────── */

describe('MenuItem 的危险动作', () => {
  function DangerHarness({ onDelete }: { onDelete: () => void }) {
    return (
      <Menu x={0} y={0} onClose={() => {}} label="行动作">
        <MenuItem danger confirmLabel="真删?" onClick={onDelete}>
          删除…
        </MenuItem>
      </Menu>
    )
  }

  it('第一下只换字,**不执行** —— 两段就地确认,不弹对话框', () => {
    const onDelete = vi.fn()
    render(<DangerHarness onDelete={onDelete} />)
    const item = screen.getByRole('menuitem', { name: '删除…' })
    fireEvent.click(item)
    expect(onDelete).not.toHaveBeenCalled()
    // 字换了,而且还是同一个菜单项(菜单没关、焦点没被拽走)。
    expect(screen.getByRole('menuitem', { name: '真删?' })).toBe(item)
  })

  it('第二下才真做', () => {
    const onDelete = vi.fn()
    render(<DangerHarness onDelete={onDelete} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '删除…' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '真删?' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('走开(blur)就撤回第一段 —— 半截确认不该在那儿等下一次误触', () => {
    const onDelete = vi.fn()
    render(<DangerHarness onDelete={onDelete} />)
    const item = screen.getByRole('menuitem', { name: '删除…' })
    fireEvent.click(item)
    fireEvent.blur(item)
    expect(screen.getByRole('menuitem', { name: '删除…' })).toBeTruthy()
    // 撤回之后再点一下仍然是「第一段」,不会直接删。
    fireEvent.click(screen.getByRole('menuitem', { name: '删除…' }))
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('没给 confirmLabel 的项照旧一下就做 —— 两段是**选项**,不是所有项的负担', () => {
    const onClick = vi.fn()
    render(
      <Menu x={0} y={0} onClose={() => {}} label="行动作">
        <MenuItem onClick={onClick}>普通项</MenuItem>
      </Menu>,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: '普通项' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

/**
 * 禁灰档(09-02 批 12)。判据两条:**它还在**(菜单形状恒定,不随上下文变形),
 * 而且**它不响应** —— 点了什么都不发生,方向键也不会停在它身上
 * (`a11y/roving` 的入组判据本来就把 disabled 排除在外)。
 */
describe('MenuItem 的禁灰档', () => {
  function DisabledHarness({ onMove }: { onMove: () => void }) {
    return (
      <Menu x={0} y={0} onClose={() => {}} label="行动作">
        <MenuItem disabled onClick={onMove}>
          上移
        </MenuItem>
        <MenuItem onClick={() => {}}>下移</MenuItem>
      </Menu>
    )
  }

  it('禁掉的项**不消失**,只是点不动', () => {
    const onMove = vi.fn()
    render(<DisabledHarness onMove={onMove} />)
    const up = screen.getByRole('menuitem', { name: '上移' }) as HTMLButtonElement
    expect(up.disabled).toBe(true)
    fireEvent.click(up)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('方向键不会停在禁掉的那一项上 —— 它压根不在 roving 组里', () => {
    render(<DisabledHarness onMove={() => {}} />)
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '下移' }))
  })
})

/**
 * **点外关**(`ui/float` 的 `useFloatDismiss`)。它读的是这块面自己的 ref,而那格 ref
 * 现在由 `<FocusScope rootRef>` 一并写 —— DOM 上只有一格 `ref` 属性,菜单又同时要
 * 定位、判「点没点在我身上」、当作用域根。
 *
 * 所以这一条同时是那格 `rootRef` 的守卫:**不把元素写回消费方那格 ref**,
 * `ref.current` 恒为 null,`contains()` 恒 false —— 点在菜单**里面**也会把它关掉。
 * 反证:摘掉 `FocusScope` 里那句 `outerRef.current.current = el` → 第二条当场红。
 */
describe('Menu:点外关', () => {
  it('点菜单外面关掉', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('opener'))
    expect(screen.getByRole('menu')).toBeTruthy()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBe(null)
  })

  it('点菜单**里面**不关(判据是那格 rootRef 真的拿到了元素)', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('opener'))
    fireEvent.pointerDown(screen.getByText('二'))
    expect(screen.queryByRole('menu')).toBeTruthy()
  })
})

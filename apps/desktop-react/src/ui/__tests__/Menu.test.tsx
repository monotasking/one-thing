import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
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

  it('Esc 关,焦点还给开它的那个元素', async () => {
    render(<Harness />)
    const opener = screen.getByTestId('opener')
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('menu')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBe(null)
    // 结构归还晚一个微任务(09-04 S4,判词在 `FocusTree.pendingUnregister`)。
    await act(async () => { await Promise.resolve() })
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

/**
 * **封顶 + 头部槽**(A6,09-13;报障:真店 24 个项目让会话侧栏的范围菜单无限长)。
 *
 * 两件都是**库件**的事,所以钉在这只文件里而不是消费面的用例里:封顶随
 * `--menu-max-h` 落在菜单体上(jsdom 不排版,所以这里钉的是「那一格属性挂在
 * 哪个元素上」与「结构分了两层」——真高度由 `gate:sessions` ⑨ 在真机上量),
 * 头部槽钉的是它的三条约束与那三个键的交接。
 */
describe('Menu 的封顶与头部槽(A6)', () => {
  function HeaderHarness({
    onEscape,
    onFirst,
  }: {
    onEscape?: () => boolean
    onFirst?: () => void
  }) {
    const [word, setWord] = useState('')
    return (
      <FocusScope scope="root">
        {({ scopeProps }) => (
          <div {...scopeProps}>
            <FocusDispatchHarness />
            <Menu
              x={0}
              y={0}
              onClose={() => {}}
              label="m"
              onEscape={onEscape}
              header={
                <input
                  aria-label="筛选"
                  value={word}
                  onChange={(e) => setWord(e.target.value)}
                />
              }
            >
              <MenuItem onClick={() => onFirst?.()}>一</MenuItem>
              <MenuItem onClick={() => {}}>二</MenuItem>
            </Menu>
          </div>
        )}
      </FocusScope>
    )
  }

  it('结构分两层:面(data-menu-surface)在外,role=menu 的**体**在里', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('opener'))
    const menu = screen.getByRole('menu')
    const surface = document.querySelector('[data-menu-surface]')
    expect(surface).toBeTruthy()
    expect(surface).not.toBe(menu)
    expect(surface?.contains(menu)).toBe(true)
  })

  it('封顶那一格落在**菜单体**上(滚的是它,不是整张面)', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('opener'))
    // CSS Modules 在 vitest 下交出的是类名字符串,判据是「体带的类与面不是同一个」。
    const menu = screen.getByRole('menu')
    expect(menu.className).not.toBe(document.querySelector('[data-menu-surface]')?.className)
    expect(menu.className).toBeTruthy()
  })

  it('头部槽在 role=menu **外面**(一只 input 不是 menu 的合法孩子)', () => {
    render(<HeaderHarness />)
    const input = screen.getByLabelText('筛选')
    expect(screen.getByRole('menu').contains(input)).toBe(false)
    expect(document.querySelector('[data-menu-surface]')?.contains(input)).toBe(true)
    // 也不进 roving:组里只有那两项。
    expect(input.hasAttribute('data-roving-item')).toBe(false)
  })

  it('有头部槽时**焦点开出来就在那只框里**(落点明说,不靠「根恰好是它」)', () => {
    render(<HeaderHarness />)
    expect(document.activeElement).toBe(screen.getByLabelText('筛选'))
  })

  it('↓ / ↑ 把键盘交给菜单体;打字与 ← → 一个不碰', () => {
    render(<HeaderHarness />)
    const input = screen.getByLabelText('筛选')
    const items = screen.getAllByRole('menuitem')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])

    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[1])

    // ← → 与 Home / End 留给光标:这一下不该动焦点。
    input.focus()
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      fireEvent.keyDown(input, { key })
      expect(document.activeElement, key).toBe(input)
    }
  })

  it('↵ 选**当前那一项**(焦点还在槽里时 = 第一项)', () => {
    const onFirst = vi.fn()
    render(<HeaderHarness onFirst={onFirst} />)
    fireEvent.keyDown(screen.getByLabelText('筛选'), { key: 'Enter' })
    expect(onFirst).toHaveBeenCalledTimes(1)
  })

  it('Esc 先问消费方:答 true 就不关这张菜单', () => {
    const onEscape = vi.fn(() => true)
    render(<HeaderHarness onEscape={onEscape} />)
    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeTruthy()
  })

  it('答 false 照旧关掉 —— 「这一下归不归我」由消费方答,关不关是库件的事', () => {
    const onEscape = vi.fn(() => false)
    const onClose = vi.fn()
    render(
      <FocusScope scope="root">
        {({ scopeProps }) => (
          <div {...scopeProps}>
            <FocusDispatchHarness />
            <Menu x={0} y={0} onClose={onClose} label="m" onEscape={onEscape}>
              <MenuItem onClick={() => {}}>一</MenuItem>
            </Menu>
          </div>
        )}
      </FocusScope>,
    )
    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('开出来那一拍把**打勾的那一项**滚进视野(两种角色各认各的属性)', () => {
    const seen: Element[] = []
    const spy = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(function (this: HTMLElement) {
        seen.push(this)
      })
    render(
      <Menu x={0} y={0} onClose={() => {}} label="m">
        <MenuItem checked={false} onClick={() => {}}>
          一
        </MenuItem>
        <MenuItem checked onClick={() => {}}>
          二
        </MenuItem>
      </Menu>,
    )
    expect(seen).toEqual([screen.getByRole('menuitemradio', { name: '二' })])
    spy.mockRestore()
  })
})

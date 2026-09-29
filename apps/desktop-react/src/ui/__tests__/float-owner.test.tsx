import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { isLogicallyInside, registerFloatOwner, useFloatDismiss } from '../float'
import { Menu, MenuItem } from '../Menu'
import { Select } from '../Select'

/**
 * **逻辑包含**的守卫(09-29 事故:composer 模型抽屉里一只 `ui/Select`,按下选项那一下
 * 抽屉按 DOM 判「点了外面」、在捕获相位关掉自己,选项的 click 永远没跑)。
 *
 * 这里每一次「按」都是**真的指针序列**:`pointerDown` → `pointerUp` → `click`。
 * 事故之所以活过了门与两次手测,正是因为它们只发了一下 `element.click()` ——
 * 合成 click 不带 pointerdown,点外关那条监听压根没被问到。
 */

afterEach(() => cleanup())

/** 真的按一下:点外关听的是 pointerdown,选项的动作挂在 click 上,两样都得发。 */
function press(el: Element): void {
  fireEvent.pointerDown(el)
  fireEvent.pointerUp(el)
  fireEvent.click(el)
}

const OPTIONS = [
  { value: 'fable', label: 'Fable 5.1' },
  { value: 'opus', label: 'Opus 5.5' },
]

/** 一个会被点外关的宿主(与 composer 抽屉同档:捕获相位),里面装一只 Select。 */
function Host({
  onClose,
  onChange,
  second = false,
}: {
  onClose: () => void
  onChange: (v: string) => void
  second?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [a, setA] = useState('fable')
  const [b, setB] = useState('fable')
  useFloatDismiss(ref, onClose, true, { outside: 'capture' })
  return (
    <>
      <div ref={ref} data-testid="host">
        <Select
          label="A"
          options={OPTIONS}
          value={a}
          onChange={(v) => {
            setA(v)
            onChange(v)
          }}
        />
        {second && (
          <Select
            label="B"
            options={OPTIONS}
            value={b}
            onChange={(v) => {
              setB(v)
              onChange(v)
            }}
          />
        )}
      </div>
      <button type="button" data-testid="elsewhere">
        elsewhere
      </button>
    </>
  )
}

describe('useFloatDismiss × portal 出去的 Select:按选项不算点外面', () => {
  it('按下 portal 出去的选项:宿主不关,onChange 拿到那一项', () => {
    const onClose = vi.fn()
    const onChange = vi.fn()
    render(<Host onClose={onClose} onChange={onChange} />)

    press(screen.getByRole('combobox', { name: 'A' }))
    const listbox = screen.getByRole('listbox')
    // 前提:面板真的不在宿主的 DOM 子树里 —— 否则这条测不到任何东西。
    expect(screen.getByTestId('host').contains(listbox)).toBe(false)

    press(within(listbox).getByRole('option', { name: /Opus 5\.5/ }))

    expect(onClose).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith('opus')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'A' }).textContent).toContain('Opus 5.5')
  })

  it('按真正的外面:宿主关,恰一次', () => {
    const onClose = vi.fn()
    render(<Host onClose={onClose} onChange={() => {}} />)
    press(screen.getByTestId('elsewhere'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Select 开着时按真正的外面:宿主照样关(主人只把自己的面板算进来)', () => {
    const onClose = vi.fn()
    render(<Host onClose={onClose} onChange={() => {}} />)
    press(screen.getByRole('combobox', { name: 'A' }))
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.pointerDown(screen.getByTestId('elsewhere'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('A 选完、再开 B 选:两次都成,宿主一次都没关', () => {
    const onClose = vi.fn()
    const onChange = vi.fn()
    render(<Host onClose={onClose} onChange={onChange} second />)

    press(screen.getByRole('combobox', { name: 'A' }))
    press(within(screen.getByRole('listbox')).getByRole('option', { name: /Opus/ }))
    press(screen.getByRole('combobox', { name: 'B' }))
    press(within(screen.getByRole('listbox')).getByRole('option', { name: /Opus/ }))
    // 再来一轮,把 A 选回去 —— 旧登记没有挡住新的那一张面板。
    press(screen.getByRole('combobox', { name: 'A' }))
    press(within(screen.getByRole('listbox')).getByRole('option', { name: /Fable/ }))

    expect(onClose).not.toHaveBeenCalled()
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['opus', 'opus', 'fable'])
  })
})

describe('没有主人的浮层:行为逐字不变', () => {
  function Unrelated({ onClose }: { onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null)
    useFloatDismiss(ref, onClose, true, { outside: 'capture' })
    return <div ref={ref} data-testid="unrelated" />
  }

  it('光标处开的 Menu(不给 owner):按它对一个无关的宿主仍是「点了外面」', () => {
    const onClose = vi.fn()
    render(
      <>
        <Unrelated onClose={onClose} />
        <Menu x={10} y={10} onClose={() => {}}>
          <MenuItem onClick={() => {}}>Rename</MenuItem>
        </Menu>
      </>,
    )
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('给了 owner 但主人在别处:按菜单只算进主人那一格,不算进无关宿主', () => {
    const onClose = vi.fn()
    function Owned() {
      const owner = useRef<HTMLButtonElement>(null)
      return (
        <>
          <button ref={owner} type="button">
            opener
          </button>
          <Menu x={10} y={10} onClose={() => {}} owner={owner}>
            <MenuItem onClick={() => {}}>Rename</MenuItem>
          </Menu>
        </>
      )
    }
    render(
      <>
        <Unrelated onClose={onClose} />
        <Owned />
      </>,
    )
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('登记的寿命', () => {
  it('Select 收起(面板卸载)之后,旧面板上的节点不再算「里面」', () => {
    const onClose = vi.fn()
    render(<Host onClose={onClose} onChange={() => {}} />)
    const host = screen.getByTestId('host')
    press(screen.getByRole('combobox', { name: 'A' }))
    const option = within(screen.getByRole('listbox')).getByRole('option', { name: /Opus/ })
    const panel = option.closest('[data-menu-surface]')!
    expect(isLogicallyInside(host, option)).toBe(true)

    press(option) // 选中即收起:面板卸载,登记随之拆掉
    expect(screen.queryByRole('listbox')).toBeNull()
    // 把那块脱离了文档的旧面板重新挂回 body(模拟「一块不再属于谁的节点」):
    // 它身上的登记已经没了,所以对宿主来说是外面。
    document.body.appendChild(panel)
    expect(isLogicallyInside(host, option)).toBe(false)
    fireEvent.pointerDown(option)
    expect(onClose).toHaveBeenCalledTimes(1)
    panel.remove()
  })

  it('主人先卸载:登记还在也不再生效(主人不在文档上 = 那条逻辑边不算数)', () => {
    const host = document.createElement('div')
    const owner = document.createElement('button')
    host.appendChild(owner)
    const root = document.createElement('div')
    const leaf = document.createElement('span')
    root.appendChild(leaf)
    document.body.append(host, root)
    const off = registerFloatOwner(root, owner)
    expect(isLogicallyInside(host, leaf)).toBe(true)
    owner.remove()
    expect(isLogicallyInside(host, leaf)).toBe(false)
    off()
    host.remove()
    root.remove()
  })

  it('拆卸只删自己那一条;两块浮层互为主人也不会死循环', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    const leaf = document.createElement('span')
    a.appendChild(leaf)
    const host = document.createElement('div')
    document.body.append(a, b, host)
    const offA = registerFloatOwner(a, b)
    const offB = registerFloatOwner(b, a)
    expect(isLogicallyInside(host, leaf)).toBe(false)

    // 同一个根换了主人:旧拆卸不许把新的删掉。
    const offA2 = registerFloatOwner(a, host)
    offA()
    expect(isLogicallyInside(host, leaf)).toBe(true)
    offA2()
    expect(isLogicallyInside(host, leaf)).toBe(false)
    offB()
    a.remove()
    b.remove()
    host.remove()
  })
})

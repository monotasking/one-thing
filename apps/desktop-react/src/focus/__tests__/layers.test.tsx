import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { Button } from '../../ui/Button'
import { FocusScope } from '../FocusScope'
import { focusTree } from '../registry'
import { FocusDispatchHarness } from '../../test/focus-harness'

/**
 * **R1 收编之后的层叠语义**(设计 §4.4 / §4.5)。
 *
 * 这一组是浮层栈那几条用例的新家:从前它们验的是「模块级栈按 DOM 包含 + 入栈序
 * 挑出栈顶」,现在验的是同一件事在树上的说法 —— **由深到浅,第一个答 true 的
 * 消费掉这一下**。差别在于树不需要猜:portal 出去的菜单在 DOM 上是对话框的兄弟,
 * 在 React 树上是它的孩子,而树认的是后者。
 *
 * 用裸 `<FocusScope>` 而不是 `ui/Dialog` + `ui/Menu`:要验的是**机制**,
 * 不是任何一件组件的皮肤(那两件各有自己的接线用例)。
 */

afterEach(() => {
  focusTree.reset()
  focusTree.policy.moveFocus = true
})

/** 一层浮层:portal 出去(与真机上的菜单 / 对话框同形),声明自己认 Esc。 */
function Layer({
  scope,
  onClose,
  testId,
  children,
}: {
  scope: 'dialog' | 'menu'
  onClose: () => void
  testId: string
  children?: React.ReactNode
}) {
  return (
    <FocusScope scope={scope} activateOnMount onEscape={() => (onClose(), true)}>
      {({ scopeProps }) =>
        createPortal(
          <div {...scopeProps} data-testid={testId} tabIndex={-1}>
            <Button>{`${testId} 一`}</Button>
            <Button>{`${testId} 二`}</Button>
            {children}
          </div>,
          document.body,
        )
      }
    </FocusScope>
  )
}

function Shell({ children }: { children?: React.ReactNode }) {
  return (
    <FocusScope scope="root">
      {({ scopeProps }) => (
        <div {...scopeProps}>
          <FocusDispatchHarness />
          {children}
        </div>
      )}
    </FocusScope>
  )
}

const escape = () =>
  new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })

describe('层叠:Esc 只退一层', () => {
  it('对话框里开一张菜单:一下 Esc 只关菜单,再一下才关对话框', () => {
    const closeOuter = vi.fn()
    const closeInner = vi.fn()

    function Stack() {
      const [innerOpen, setInnerOpen] = useState(false)
      return (
        <Shell>
          <Layer scope="dialog" onClose={closeOuter} testId="outer">
            <Button onClick={() => setInnerOpen(true)}>open inner</Button>
            {innerOpen && (
              <Layer
                scope="menu"
                onClose={() => {
                  closeInner()
                  setInnerOpen(false)
                }}
                testId="inner"
              />
            )}
          </Layer>
        </Shell>
      )
    }
    render(<Stack />)
    fireEvent.click(screen.getByText('open inner'))

    const first = escape()
    act(() => void window.dispatchEvent(first))
    expect(closeInner).toHaveBeenCalledTimes(1)
    expect(closeOuter).not.toHaveBeenCalled()
    // 认领仍然发生 —— 只是由最深那一层认领,外壳退层链照旧让位。
    expect(first.defaultPrevented).toBe(true)
    expect(screen.queryByTestId('inner')).toBeNull()

    const second = escape()
    act(() => void window.dispatchEvent(second))
    expect(closeOuter).toHaveBeenCalledTimes(1)
    expect(closeInner).toHaveBeenCalledTimes(1)
  })

  it('**DOM 上是兄弟、树上是父子**:portal 出去照样按逻辑嵌套判(浮层栈当年要猜的那件事)', () => {
    const closeOuter = vi.fn()
    const closeInner = vi.fn()
    render(
      <Shell>
        <Layer scope="dialog" onClose={closeOuter} testId="outer">
          <Layer scope="menu" onClose={closeInner} testId="inner" />
        </Layer>
      </Shell>,
    )
    // 两块面在 DOM 上谁也不套着谁 —— 这正是判据①(DOM 包含)答不出的那一形。
    const outer = screen.getByTestId('outer')
    const inner = screen.getByTestId('inner')
    expect(outer.contains(inner)).toBe(false)

    act(() => void window.dispatchEvent(escape()))
    expect(closeInner).toHaveBeenCalledTimes(1)
    expect(closeOuter).not.toHaveBeenCalled()
  })

  it('浅的那一层不认 Esc 时,这一下继续往外传到 root(退层链是最后一环)', () => {
    const rootEscape = vi.fn(() => true)
    render(
      <FocusScope scope="root" onEscape={rootEscape}>
        {({ scopeProps }) => (
          <div {...scopeProps}>
            <FocusDispatchHarness />
            <FocusScope scope="stage-layer">
              {({ scopeProps: layerProps }) => <div {...layerProps} data-testid="stage" />}
            </FocusScope>
          </div>
        )}
      </FocusScope>,
    )
    act(() => screen.getByTestId('stage').focus())
    const ev = escape()
    act(() => void window.dispatchEvent(ev))
    expect(rootEscape).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true)
  })
})

describe('modal:Tab 圈禁与结构性归还', () => {
  function Harness() {
    const [open, setOpen] = useState(false)
    return (
      <Shell>
        <Button data-testid="opener" onClick={() => setOpen(true)}>
          open
        </Button>
        <Button data-testid="outside">外面</Button>
        {open && <Layer scope="dialog" onClose={() => setOpen(false)} testId="panel" />}
      </Shell>
    )
  }

  it('开出来焦点进容器;Tab 在里面循环;焦点被别处抢走后下一下 Tab 拽回来', () => {
    render(<Harness />)
    act(() => screen.getByTestId('opener').focus())
    fireEvent.click(screen.getByTestId('opener'))

    const panel = screen.getByTestId('panel')
    expect(document.activeElement).toBe(panel)

    const [one, two] = ['panel 一', 'panel 二'].map((label) => screen.getByText(label))

    // 焦点在容器上(不在任何一项里):下一下 Tab 落到第一项。
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(one)

    // 末项之后回首项(圈禁的闭合处)。中间那几步是浏览器的原生行为,jsdom 不模拟。
    act(() => two.focus())
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(one)

    // 反向:首项之前回末项。
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(two)

    // 焦点跑到浮层外面之后,下一下 Tab 把它拽回圈里。
    act(() => screen.getByTestId('outside').focus())
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(one)
  })

  it('关掉之后焦点回到开它的那个元素 —— **没有锚点簿记**,是路径缩回父的结果', () => {
    render(<Harness />)
    const opener = screen.getByTestId('opener')
    act(() => opener.focus())
    fireEvent.click(opener)
    expect(document.activeElement).toBe(screen.getByTestId('panel'))

    act(() => void window.dispatchEvent(escape()))
    expect(screen.queryByTestId('panel')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('非模态的路径上 Tab 一个字都不管(结构键不进表)', () => {
    render(
      <Shell>
        <Button data-testid="outside">外面</Button>
      </Shell>,
    )
    act(() => screen.getByTestId('outside').focus())
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => void window.dispatchEvent(ev))
    expect(ev.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(screen.getByTestId('outside'))
  })
})

describe('layer 的 inert:切 tab 之后焦点不变孤儿(I1)', () => {
  function Shelf({ on }: { on: 'a' | 'b' }) {
    return (
      <Shell>
        {(['a', 'b'] as const).map((id) => (
          <FocusScope key={id} scope="shelf-layer" inert={id !== on}>
            {({ scopeProps }) => (
              <div {...scopeProps} data-testid={`layer-${id}`} inert={id !== on || undefined}>
                <Button data-testid={`btn-${id}`}>{id}</Button>
              </div>
            )}
          </FocusScope>
        ))}
      </Shell>
    )
  }

  it('活动那一层打上 inert:路径缩回父,焦点回落,**不掉 body**', () => {
    const view = render(<Shelf on="a" />)
    act(() => screen.getByTestId('btn-a').focus())
    expect(focusTree.current()?.scope).toBe('shelf-layer')

    view.rerender(<Shelf on="b" />)
    expect(focusTree.current()?.scope).toBe('root')
    expect(document.activeElement).not.toBe(document.body)
  })
})

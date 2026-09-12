import { afterEach, describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { FocusScope } from '../FocusScope'
import { useFocusScope, useFocusScopeActive } from '../useFocusScope'
import { focusTree } from '../registry'

/**
 * **`<FocusScope>` 的两条硬约束**:
 *  ① 它一个 DOM 节点都不许多加(region / layer 全长在 grid 里,多一层 div 掀布局);
 *  ② 父子关系来自**逻辑嵌套**,不是 DOM 位置(portal 出去的菜单照样是对话框的孩子)。
 *
 * 外加那道闸在组件层的形:`tabIndex={-1}` 只在 `policy.moveFocus` 开着时才铺
 * (R1 起缺省开)—— 那个属性存在的唯一理由就是「焦点能被送到根上」,
 * 一个开关管一件事。`data-focus-scope` 不受它管(I4 任何时候都要能扫)。
 */

afterEach(() => {
  focusTree.reset()
  focusTree.policy.moveFocus = true
})

describe('零 DOM:属性铺在消费方自己的根上', () => {
  it('渲染出来只有消费方那一个元素,没有包装层', () => {
    const { container } = render(
      <FocusScope scope="root">{({ scopeProps }) => <div {...scopeProps} id="shell" />}</FocusScope>,
    )
    expect(container.childElementCount).toBe(1)
    expect(container.firstElementChild?.id).toBe('shell')
  })

  it('根上带 `data-focus-scope`(I4 的判据)与 `tabIndex=-1`(R1 起)', () => {
    const { container } = render(
      <FocusScope scope="root">{({ scopeProps }) => <div {...scopeProps} />}</FocusScope>,
    )
    const el = container.firstElementChild as HTMLElement
    expect(el.getAttribute('data-focus-scope')).toBe('root')
    expect(el.getAttribute('tabindex')).toBe('-1')
  })

  it('闸关掉时同一段代码**不铺 tabIndex**,但 `data-focus-scope` 照旧在', () => {
    focusTree.policy.moveFocus = false
    const { container } = render(
      <FocusScope scope="root">{({ scopeProps }) => <div {...scopeProps} />}</FocusScope>,
    )
    const el = container.firstElementChild as HTMLElement
    expect(el.hasAttribute('tabindex')).toBe(false)
    expect(el.getAttribute('data-focus-scope')).toBe('root')
  })

  it('根元素真的交到了树上(ref 与登记两头都补一次)', () => {
    const { container } = render(
      <FocusScope scope="root">{({ scopeProps }) => <div {...scopeProps} />}</FocusScope>,
    )
    const node = [...focusTree.nodes().values()][0]
    expect(node.root).toBe(container.firstElementChild)
  })
})

describe('树 = 逻辑嵌套', () => {
  it('套着写就是父子', () => {
    render(
      <FocusScope scope="root">
        {({ scopeProps }) => (
          <div {...scopeProps}>
            <FocusScope scope="viewer">{(v) => <div {...v.scopeProps} />}</FocusScope>
          </div>
        )}
      </FocusScope>,
    )
    const nodes = [...focusTree.nodes().values()]
    const root = nodes.find((n) => n.scope === 'root')
    const viewer = nodes.find((n) => n.scope === 'viewer')
    expect(viewer?.parent).toBe(root?.instanceId)
  })

  it('**portal**:菜单 portal 到 body,DOM 上不在对话框里,树上仍是它的孩子', () => {
    render(
      <FocusScope scope="dialog">
        {({ scopeProps }) => (
          <div {...scopeProps} data-testid="dialog">
            {createPortal(
              <FocusScope scope="menu">{(m) => <div {...m.scopeProps} data-testid="menu" />}</FocusScope>,
              document.body,
            )}
          </div>
        )}
      </FocusScope>,
    )
    const nodes = [...focusTree.nodes().values()]
    const dialog = nodes.find((n) => n.scope === 'dialog')
    const menu = nodes.find((n) => n.scope === 'menu')
    expect(dialog?.root?.contains(menu?.root ?? null)).toBe(false)
    expect(menu?.parent).toBe(dialog?.instanceId)
  })

  it('卸载即摘表(归还是结构性的,消费方不用写一行清理)', () => {
    const { unmount } = render(
      <FocusScope scope="root">{({ scopeProps }) => <div {...scopeProps} />}</FocusScope>,
    )
    expect(focusTree.nodes().size).toBe(1)
    unmount()
    expect(focusTree.nodes().size).toBe(0)
  })
})

describe('isActive:别再去问 document.activeElement', () => {
  function Probe() {
    const isActive = useFocusScopeActive()
    return <span data-testid="probe">{isActive ? 'active' : 'rest'}</span>
  }

  it('activate 之后路径上那几格全部 active,别的仍是 rest', () => {
    const { getAllByTestId } = render(
      <FocusScope scope="root">
        {({ scopeProps }) => (
          <div {...scopeProps}>
            <FocusScope scope="viewer">
              {(v) => (
                <div {...v.scopeProps}>
                  <Probe />
                </div>
              )}
            </FocusScope>
            <FocusScope scope="files">
              {(f) => (
                <div {...f.scopeProps}>
                  <Probe />
                </div>
              )}
            </FocusScope>
          </div>
        )}
      </FocusScope>,
    )
    expect(getAllByTestId('probe').map((n) => n.textContent)).toEqual(['rest', 'rest'])

    const viewer = [...focusTree.nodes().values()].find((n) => n.scope === 'viewer')!
    act(() => focusTree.activate(viewer.instanceId, 'open'))
    expect(getAllByTestId('probe').map((n) => n.textContent)).toEqual(['active', 'rest'])
  })

  it('不在任何 FocusScope 里调也不抛(规格页那种没有宿主的地方)', () => {
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('probe').textContent).toBe('rest')
  })
})

describe('声明的进出', () => {
  it('`onEscape` 从有到无是**摘得掉**的(不然那一层会一直吃 Esc)', () => {
    function Case({ armed }: { armed: boolean }) {
      return (
        <FocusScope scope="jumpbar" onEscape={armed ? () => true : undefined}>
          {({ scopeProps }) => <div {...scopeProps} />}
        </FocusScope>
      )
    }
    const { rerender } = render(<Case armed />)
    const id = [...focusTree.nodes().values()][0].instanceId
    expect(focusTree.nodes().get(id)?.onEscape).toBeTypeOf('function')
    rerender(<Case armed={false} />)
    expect(focusTree.nodes().get(id)?.onEscape).toBeUndefined()
  })

  it('`commands` 每渲染同步内容,但**不重登记**(实例 id 不变)', () => {
    function Case({ n }: { n: number }) {
      return (
        <FocusScope scope="viewer" commands={{ 'view.find': () => void n }}>
          {({ scopeProps }) => <div {...scopeProps} />}
        </FocusScope>
      )
    }
    const { rerender } = render(<Case n={1} />)
    const before = [...focusTree.nodes().values()][0]
    const first = before.commands?.['view.find']
    rerender(<Case n={2} />)
    const after = [...focusTree.nodes().values()][0]
    expect(after.instanceId).toBe(before.instanceId)
    expect(after.commands?.['view.find']).not.toBe(first)
  })

  it('`inert` 改成 true 就地生效,不经重登记', () => {
    function Case({ off }: { off: boolean }) {
      return (
        <FocusScope scope="shelf-layer" inert={off}>
          {({ scopeProps }) => <div {...scopeProps} />}
        </FocusScope>
      )
    }
    const { rerender } = render(<Case off={false} />)
    const id = [...focusTree.nodes().values()][0].instanceId
    rerender(<Case off />)
    expect(focusTree.nodes().get(id)?.inert).toBe(true)
  })
})

/**
 * `rootRef`:消费方那格 ref 与树的登记**共用同一只回调**。
 * DOM 上只有一格 `ref` 属性,而浮层同时要定位、要判「点没点在我身上」、
 * 要当作用域根 —— 就地拼一个回调会每渲染换一次身份(根一摘一挂),
 * 所以由这只组件一并写。
 */
describe('rootRef:一格 ref,两个读者', () => {
  it('元素同时写进消费方那格 ref 与树里那一格', () => {
    const mine: { current: HTMLElement | null } = { current: null }
    const { container } = render(
      <FocusScope scope="menu" rootRef={mine}>
        {({ scopeProps }) => <div {...scopeProps} id="panel" />}
      </FocusScope>,
    )
    const el = container.firstElementChild as HTMLElement
    expect(mine.current).toBe(el)
    expect([...focusTree.nodes().values()][0].root).toBe(el)
  })

  it('卸载时两头一起摘(不留一个指着游离节点的 ref)', () => {
    const mine: { current: HTMLElement | null } = { current: null }
    const view = render(
      <FocusScope scope="menu" rootRef={mine}>
        {({ scopeProps }) => <div {...scopeProps} />}
      </FocusScope>,
    )
    expect(mine.current).not.toBeNull()
    view.unmount()
    expect(mine.current).toBeNull()
    expect(focusTree.nodes().size).toBe(0)
  })
})

/**
 * **`<FocusScope>` 自己不许订阅焦点树**(09-03,读数背书);
 * **`useFocusScope()` 也不许**(09-04 S2,同一条法的第二半)。
 *
 * 病历(`probe-hotspots`):它从前用 `useSyncExternalStore` 自己算 `isActive` 并经
 * render-prop 交出去 —— 而全壳**没有一个消费者**读那一格(grep 只找得到它自己)。
 * 代价却是实打实的:它包住的是一整块面,于是每次焦点换格,翻面的那两格 scope
 * 各把整棵子树重渲一遍;文件树开着时单次 focusin 的同步 flush 0.94ms → **5.45ms**
 * (5.8×),那一段里 `TreeEntryRow` total 37.3ms。
 *
 * 判据因此是一句话:**焦点换格不该让包着的面重渲**;要这个布尔的叶子自己去问。
 *
 * 09-04 S2 补的第二半:那时「叶子自己去问」还是同一只 `useFocusScope()`,而它
 * 无条件挂着那格 `useSyncExternalStore` —— 于是**只要 `activate`** 的人也照样订阅。
 * 真机读数(焦点在输入框与总览的树之间来回换 80 次,每次让一帧):
 * `render.Overview` = 80(整块总览连它的树重渲 80 次),而总览从头到尾没读过
 * 那个布尔。所以订阅搬进了独立的 `useFocusScopeActive()`,`useFocusScope()`
 * 只剩 `instanceId` / `activate` 两格纯值。
 */
describe('订阅的粒度:面不订,叶子订', () => {
  function Counting({ counts }: { counts: { n: number } }) {
    counts.n += 1
    return null
  }

  /** 只要 `activate`(壳里四个生产消费者全是这一形)—— 它不该订阅任何东西。 */
  function ActivateOnlyLeaf({ counts }: { counts: { n: number } }) {
    const { activate } = useFocusScope()
    counts.n += 1
    // 「拿到」那一格就够了 —— 这一条量的是订阅,不是点击(所以不画一颗真按钮)。
    return <span data-testid="only">{typeof activate}</span>
  }

  function AskingLeaf({ counts }: { counts: { n: number } }) {
    const isActive = useFocusScopeActive()
    counts.n += 1
    return <span data-testid="leaf">{isActive ? 'active' : 'rest'}</span>
  }

  function twoScopes(children: (which: 'viewer' | 'files') => React.ReactNode) {
    return render(
      <FocusScope scope="root">
        {({ scopeProps }) => (
          <div {...scopeProps}>
            <FocusScope scope="viewer">
              {(v) => <div {...v.scopeProps}>{children('viewer')}</div>}
            </FocusScope>
            <FocusScope scope="files">
              {(f) => <div {...f.scopeProps}>{children('files')}</div>}
            </FocusScope>
          </div>
        )}
      </FocusScope>,
    )
  }

  const idOf = (scope: string) =>
    [...focusTree.nodes().values()].find((n) => n.scope === scope)!.instanceId

  it('两格之间来回切 20 次,`<FocusScope>` 底下的探针一次都不重渲', () => {
    const counts = { viewer: { n: 0 }, files: { n: 0 } }
    twoScopes((which) => <Counting counts={counts[which]} />)
    const before = { viewer: counts.viewer.n, files: counts.files.n }
    expect(before.viewer).toBeGreaterThan(0)

    const viewer = idOf('viewer')
    const files = idOf('files')
    for (let i = 0; i < 20; i += 1) {
      act(() => focusTree.activate(i % 2 === 0 ? viewer : files, 'programmatic'))
    }

    expect(counts.viewer.n - before.viewer).toBe(0)
    expect(counts.files.n - before.files).toBe(0)
  })

  it('**只取 `activate` 的叶子一次都不重渲**(09-04 S2:订阅按需,不按调用)', () => {
    const counts = { viewer: { n: 0 }, files: { n: 0 } }
    twoScopes((which) => <ActivateOnlyLeaf counts={counts[which]} />)
    const before = { viewer: counts.viewer.n, files: counts.files.n }
    expect(before.viewer).toBeGreaterThan(0)

    const viewer = idOf('viewer')
    const files = idOf('files')
    for (let i = 0; i < 20; i += 1) {
      act(() => focusTree.activate(i % 2 === 0 ? viewer : files, 'programmatic'))
    }

    /*
     * 反证:把 `useFocusScopeActive` 那格订阅搬回 `useFocusScope()` → 这两句当场红
     * (各 20 次重渲),而那正是真机上「焦点一进出总览,整块总览重渲一遍」的病根。
     */
    expect(counts.viewer.n - before.viewer).toBe(0)
    expect(counts.files.n - before.files).toBe(0)
  })

  it('自己问的那颗叶子:只在**自己**翻面时重渲', () => {
    const counts = { viewer: { n: 0 }, files: { n: 0 } }
    twoScopes((which) => <AskingLeaf counts={counts[which]} />)
    const before = { viewer: counts.viewer.n, files: counts.files.n }

    const viewer = idOf('viewer')
    act(() => focusTree.activate(viewer, 'programmatic'))
    // viewer 那颗翻了(rest → active);files 那颗从头到尾都是 rest,
    // `useSyncExternalStore` 读到同一个值就地短路。
    expect(counts.viewer.n).toBeGreaterThan(before.viewer)
    expect(counts.files.n - before.files).toBe(0)
  })
})

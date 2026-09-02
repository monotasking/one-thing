import { afterEach, describe, expect, it } from 'vitest'
import {
  activePathOf,
  restingElementOf,
  returnTargetOf,
  routeEscape,
  routeKey,
  scopeAtElement,
  shrinkPath,
} from '../transitions'
import { FOCUS_SCOPES } from '../scopes'
import type { FocusScopeId, ScopeNode } from '../types'

/**
 * **响应链四个问题的纯函数**(设计 §4.2 / §4.3 / §4.4 / §4.5)。
 *
 * 这一组要钉的不是「函数会不会算」,是**四种真机上出过事的树形**:
 *  · portal:菜单在 DOM 上是对话框的兄弟,在树上是它的孩子(`floatStack` 要用
 *    两条判据去猜的那件事);
 *  · 同一次提交里父子一起挂载:React 的 effect **子先于父**跑,子登记那一刻
 *    父还不在表上;
 *  · inert 祖先:架子切 tab,旧层打 inert 而层里那块面自己没打;
 *  · 多实例同 scope:两扇浮窗各一个查看器 —— 键只该落在路径上那一份。
 *
 * 反证纪律:每条断言都要能被「把实现拆掉」翻红,拆法逐条写在用例里。
 */

const els: HTMLElement[] = []

function el(): HTMLElement {
  const node = document.createElement('div')
  document.body.append(node)
  els.push(node)
  return node
}

afterEach(() => {
  for (const node of els.splice(0)) node.remove()
})

function scopeNode(
  instanceId: string,
  scope: FocusScopeId,
  parent: string | null,
  extra: Partial<ScopeNode> = {},
): ScopeNode {
  return {
    instanceId,
    scope,
    kind: FOCUS_SCOPES[scope].kind,
    parent,
    inert: false,
    root: null,
    lastFocused: null,
    ...extra,
  }
}

const tree = (...nodes: ScopeNode[]) => new Map(nodes.map((n) => [n.instanceId, n]))

const KEY_F = { key: 'f', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
const KEY_P = { key: 'p', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
const noRoot = () => null

describe('activePathOf —— 从第一响应者走到根,根在前', () => {
  it('三层的路径按根 → 层 → 面排好', () => {
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('l', 'float-layer', 'r'),
      scopeNode('v', 'viewer', 'l'),
    )
    expect(activePathOf(t, 'v')).toEqual(['r', 'l', 'v'])
  })

  it('**portal**:菜单在 DOM 上是对话框的兄弟,树上照样是它的孩子', () => {
    // 两块根元素互不包含 —— DOM 上平级,这正是 floatStack 要靠「入栈序」去猜的形。
    const dialogEl = el()
    const menuEl = el()
    const t = tree(
      scopeNode('r', 'root', null, { root: el() }),
      scopeNode('d', 'dialog', 'r', { root: dialogEl }),
      scopeNode('m', 'menu', 'd', { root: menuEl }),
    )
    expect(dialogEl.contains(menuEl)).toBe(false)
    expect(activePathOf(t, 'm')).toEqual(['r', 'd', 'm'])
  })

  it('**同批挂载**:父还没登记时回已经走到的那一段,不抛也不假装它是根', () => {
    // React 的 effect 子先于父跑;这是合法中间态,不是错误。
    const t = tree(scopeNode('v', 'viewer', 'l-not-yet'))
    expect(activePathOf(t, 'v')).toEqual(['v'])
  })

  it('实例不在表上(刚卸载)= 空路径,交给调用方去缩', () => {
    expect(activePathOf(tree(scopeNode('r', 'root', null)), 'gone')).toEqual([])
    expect(activePathOf(tree(), null)).toEqual([])
  })

  it('成环也不会死循环(见过的就停)', () => {
    const a = scopeNode('a', 'viewer', 'b')
    const b = scopeNode('b', 'files', 'a')
    expect(activePathOf(tree(a, b), 'a')).toEqual(['b', 'a'])
  })
})

describe('shrinkPath —— 缩到最近一个仍可交互的祖先', () => {
  it('**inert 祖先**在哪儿截断,后代不管自己活着与否都出局', () => {
    // 架子切 tab:旧层打 inert,层里那块面自己没打 —— 从深往浅找「第一个活着的」
    // 会把那块面选成第一响应者,而它整块都看不见了。
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('shelf', 'shelf-layer', 'r', { inert: true }),
      scopeNode('files', 'files', 'shelf'),
    )
    expect(shrinkPath(t, ['r', 'shelf', 'files'])).toEqual(['r'])
  })

  it('第一响应者自己 inert:退回它的父', () => {
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('j', 'jumpbar', 'r', { inert: true }),
    )
    expect(shrinkPath(t, ['r', 'j'])).toEqual(['r'])
  })

  it('路径上有已经不在表上的实例,同样从那儿断', () => {
    const t = tree(scopeNode('r', 'root', null))
    expect(shrinkPath(t, ['r', 'gone'])).toEqual(['r'])
  })

  it('全都可交互 = 原样', () => {
    const t = tree(scopeNode('r', 'root', null), scopeNode('v', 'viewer', 'r'))
    expect(shrinkPath(t, ['r', 'v'])).toEqual(['r', 'v'])
  })
})

describe('routeKey —— 局部先接,没接住放行全局', () => {
  it('由深到浅:查看器在路径上,⌘F 归它(用户报的那条 bug 的正面)', () => {
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('v', 'viewer', 'r', { keyHandlers: { find: () => {} } }),
    )
    expect(routeKey(t, ['r', 'v'], KEY_F, noRoot)).toEqual({
      target: 'scope',
      instanceId: 'v',
      scope: 'viewer',
      action: 'find',
    })
  })

  it('**多实例同 scope**:只有活动路径上那一份接得住', () => {
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('v1', 'viewer', 'r', { keyHandlers: { find: () => {} } }),
      scopeNode('v2', 'viewer', 'r', { keyHandlers: { find: () => {} } }),
    )
    expect(routeKey(t, ['r', 'v2'], KEY_F, noRoot)).toMatchObject({ instanceId: 'v2' })
  })

  it('**由深到浅**:同一个键两格都接得住时,深的那一份赢', () => {
    /*
     * 今天的封闭表里没有两格声明同一个组合的情形(查看器 ⌘S/⌘L/⌘F 与文件树
     * ⌘I/⌘↵ 不相交),所以这一条用**同一种作用域的两份实例**套起来钉方向 ——
     * 它验的是循环的走向本身。把 `routeKey` 的循环改成由浅到深,这一条当场红。
     * R2 里 composer / search 各自带上局部键之后,这就是一个真实形状。
     */
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('outer', 'viewer', 'r', { keyHandlers: { find: () => {} } }),
      scopeNode('inner', 'viewer', 'outer', { keyHandlers: { find: () => {} } }),
    )
    expect(routeKey(t, ['r', 'outer', 'inner'], KEY_F, noRoot)).toMatchObject({
      instanceId: 'inner',
    })
  })

  it('深的那一格没这个键 → 继续往浅问(文件树在查看器外面时的 ⌘F)', () => {
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('v', 'viewer', 'r', { keyHandlers: { find: () => {} } }),
      scopeNode('f', 'files', 'v', { keyHandlers: { detail: () => {} } }),
    )
    expect(routeKey(t, ['r', 'v', 'f'], KEY_F, noRoot)).toMatchObject({ instanceId: 'v' })
  })

  it('声明有、落点没注入 → **当作没命中**,不吞这一下', () => {
    // 吞掉的表现是「按了没反应」,那是最难查的一种;落到全局至少是可预期的。
    const t = tree(scopeNode('r', 'root', null), scopeNode('v', 'viewer', 'r'))
    expect(routeKey(t, ['r', 'v'], KEY_F, () => 'toc.toggle')).toEqual({
      target: 'root',
      command: 'toc.toggle',
    })
  })

  it('inert 的那一格一律不接', () => {
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('v', 'viewer', 'r', { inert: true, keyHandlers: { find: () => {} } }),
    )
    expect(routeKey(t, ['r', 'v'], KEY_F, noRoot)).toBeNull()
  })

  it('没有任何局部键命中 → 全局命令表;它也答不出就是 null', () => {
    const t = tree(scopeNode('r', 'root', null))
    expect(routeKey(t, ['r'], KEY_P, () => 'search.toggle')).toEqual({
      target: 'root',
      command: 'search.toggle',
    })
    expect(routeKey(t, ['r'], KEY_P, noRoot)).toBeNull()
  })
})

describe('routeEscape —— 由深到浅的候选序', () => {
  it('回的是节点表而不是「谁答了 true」:纯函数不许调 onEscape', () => {
    let called = 0
    const t = tree(
      scopeNode('r', 'root', null, { onEscape: () => ((called += 1), true) }),
      scopeNode('j', 'jumpbar', 'r', { onEscape: () => ((called += 1), true) }),
    )
    const order = routeEscape(t, ['r', 'j']).map((n) => n.instanceId)
    expect(order).toEqual(['j', 'r'])
    expect(called).toBe(0)
  })

  it('没声明 onEscape 的那几格不进表(声明与「答 false」是两件事)', () => {
    const t = tree(
      scopeNode('r', 'root', null, { onEscape: () => true }),
      scopeNode('v', 'viewer', 'r'),
      scopeNode('j', 'jumpbar', 'v', { onEscape: () => true }),
    )
    expect(routeEscape(t, ['r', 'v', 'j']).map((n) => n.instanceId)).toEqual(['j', 'r'])
  })

  it('inert 的那一格不许吃掉这一下 Esc', () => {
    const t = tree(
      scopeNode('r', 'root', null, { onEscape: () => true }),
      scopeNode('j', 'jumpbar', 'r', { inert: true, onEscape: () => true }),
    )
    expect(routeEscape(t, ['r', 'j']).map((n) => n.instanceId)).toEqual(['r'])
  })
})

describe('returnTargetOf —— 卸载后焦点回哪儿(归还是结构性的)', () => {
  it('回父的 lastFocused:跳转条卸载,焦点回查看器上次那一行', () => {
    const viewerRoot = el()
    const row = document.createElement('button')
    viewerRoot.append(row)
    const t = tree(
      scopeNode('r', 'root', null, { root: el() }),
      scopeNode('v', 'viewer', 'r', { root: viewerRoot, lastFocused: row }),
      scopeNode('j', 'jumpbar', 'v'),
    )
    expect(returnTargetOf(t, t.get('j'))).toEqual({ instanceId: 'v', element: row })
  })

  it('lastFocused 已经**不连通** → 退到声明的落点', () => {
    const viewerRoot = el()
    const detached = document.createElement('button') // 没进文档
    const resting = document.createElement('input')
    viewerRoot.append(resting)
    const t = tree(
      scopeNode('r', 'root', null, { root: el() }),
      scopeNode('v', 'viewer', 'r', {
        root: viewerRoot,
        lastFocused: detached,
        restingTarget: () => resting,
      }),
      scopeNode('j', 'jumpbar', 'v'),
    )
    expect(returnTargetOf(t, t.get('j'))?.element).toBe(resting)
  })

  it('lastFocused 连通但**已经不在那个祖先里** → 不用它', () => {
    // 往一个已经不在那块面里的节点上 focus,浏览器会把焦点扔回 body(孤儿焦点)。
    const viewerRoot = el()
    const elsewhere = el()
    const stray = document.createElement('button')
    elsewhere.append(stray)
    const t = tree(
      scopeNode('r', 'root', null, { root: el() }),
      scopeNode('v', 'viewer', 'r', { root: viewerRoot, lastFocused: stray }),
      scopeNode('j', 'jumpbar', 'v'),
    )
    expect(returnTargetOf(t, t.get('j'))?.element).toBe(viewerRoot)
  })

  it('父 inert → 再往上一层接手', () => {
    const rootEl = el()
    const t = tree(
      scopeNode('r', 'root', null, { root: rootEl }),
      scopeNode('shelf', 'shelf-layer', 'r', { inert: true, root: el() }),
      scopeNode('f', 'files', 'shelf'),
    )
    expect(returnTargetOf(t, t.get('f'))).toEqual({ instanceId: 'r', element: rootEl })
  })

  it('全树都答不出 → null(此时什么都不做,而不是把焦点扔给 body)', () => {
    const t = tree(scopeNode('r', 'root', null), scopeNode('j', 'jumpbar', 'r'))
    expect(returnTargetOf(t, t.get('j'))).toBeNull()
    expect(returnTargetOf(t, undefined)).toBeNull()
  })
})

describe('落点与「这个元素归哪块面」', () => {
  it('restingElementOf:声明优先,否则根;答不出就是 null', () => {
    const rootEl = el()
    const input = document.createElement('input')
    rootEl.append(input)
    const withResting = scopeNode('a', 'jumpbar', null, { root: rootEl, restingTarget: () => input })
    expect(restingElementOf(withResting)).toBe(input)
    expect(restingElementOf(scopeNode('b', 'viewer', null, { root: rootEl }))).toBe(rootEl)
    expect(restingElementOf(scopeNode('c', 'viewer', null))).toBeNull()
  })

  it('scopeAtElement 取**最内层**那一个(祖先的根一定包着后代的根)', () => {
    const outer = el()
    const inner = document.createElement('div')
    const leaf = document.createElement('button')
    inner.append(leaf)
    outer.append(inner)
    const t = tree(
      scopeNode('r', 'root', null, { root: outer }),
      scopeNode('v', 'viewer', 'r', { root: inner }),
    )
    expect(scopeAtElement(t, leaf)?.instanceId).toBe('v')
    expect(scopeAtElement(t, null)).toBeNull()
    expect(scopeAtElement(t, document.body)).toBeNull()
  })
})

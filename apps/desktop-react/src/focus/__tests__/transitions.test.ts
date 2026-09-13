import { afterEach, describe, expect, it } from 'vitest'
import {
  activePathOf,
  isReachablyInteractive,
  modalTrapNode,
  nearestInteractiveAncestorOf,
  restingElementOf,
  returnTargetOf,
  routeEscape,
  routeKey,
  scopeAtElement,
  shrinkPath,
} from '../transitions'
import { FOCUS_SCOPES } from '../scopes'
import type { CommandId } from '../../keymap/types'
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
    lastActiveAt: 0,
    ...extra,
  }
}

const tree = (...nodes: ScopeNode[]) => new Map(nodes.map((n) => [n.instanceId, n]))

const KEY_F = { key: 'f', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
const KEY_P = { key: 'p', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
/**
 * ⌘F 上的候选集(K0:候选由 `keymap/transitions.lookupCommands` 按用户的改绑算,
 * 纯函数这一头只收算好的那一串)。出厂表里 ⌘F 只有一条命令 `view.find`,
 * 而它 `app: false` —— 所以「没人答」= 放行,不是「掉给全局」。
 */
const FIND: readonly CommandId[] = ['view.find']
const noCandidates: readonly CommandId[] = []
/*
 * **这一组按 mac 跑**(T1-fix)。`matchCombo` 从这一批起要知道「主修饰键是哪一枚
 * 物理键」(判词在 `keymap/transitions.matchCombo` 上),而夹具里的 `KEY_F` /
 * `KEY_P` 按的都是 ⌘(`metaKey: true`)—— 所以每一处 `routeKey` 都把 `'mac'`
 * 递进去。要量 Win 那一档的话换掉夹具那两格修饰键,别只换这个字符串。
 */

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

describe('routeKey —— 局部先接,没接住放行应用层', () => {
  it('由深到浅:查看器在路径上,⌘F 归它(用户报的那条 bug 的正面)', () => {
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('v', 'viewer', 'r', { commands: { 'view.find': () => {} } }),
    )
    expect(routeKey(t, ['r', 'v'], KEY_F, FIND, 'mac')).toEqual({
      target: 'scope',
      instanceId: 'v',
      scope: 'viewer',
      command: 'view.find',
    })
  })

  it('**多实例同 scope**:只有活动路径上那一份接得住', () => {
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('v1', 'viewer', 'r', { commands: { 'view.find': () => {} } }),
      scopeNode('v2', 'viewer', 'r', { commands: { 'view.find': () => {} } }),
    )
    expect(routeKey(t, ['r', 'v2'], KEY_F, FIND, 'mac')).toMatchObject({ instanceId: 'v2' })
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
      scopeNode('outer', 'viewer', 'r', { commands: { 'view.find': () => {} } }),
      scopeNode('inner', 'viewer', 'outer', { commands: { 'view.find': () => {} } }),
    )
    expect(routeKey(t, ['r', 'outer', 'inner'], KEY_F, FIND, 'mac')).toMatchObject({
      instanceId: 'inner',
    })
  })

  it('深的那一格没这个键 → 继续往浅问(文件树在查看器外面时的 ⌘F)', () => {
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('v', 'viewer', 'r', { commands: { 'view.find': () => {} } }),
      scopeNode('f', 'files', 'v', { commands: { 'files.detail': () => {} } }),
    )
    expect(routeKey(t, ['r', 'v', 'f'], KEY_F, FIND, 'mac')).toMatchObject({ instanceId: 'v' })
  })

  it('候选里有、落点没注入 → **当作没命中**,不吞这一下', () => {
    /*
     * 吞掉的表现是「按了没反应」,那是最难查的一种。K0 之后「没人答」有两种
     * 收场,由命令自己的 `app` 那一格说了算,两条都在这儿钉着:
     *  · 候选里只有 `app: false` 的(⌘F 就是)→ **放行**(null),页面 / PTY /
     *    系统菜单接着走;
     *  · 候选里有 `app: true` 的 → 走 root(应用层兜底)。
     */
    const t = tree(scopeNode('r', 'root', null), scopeNode('v', 'viewer', 'r'))
    expect(routeKey(t, ['r', 'v'], KEY_F, FIND, 'mac')).toBeNull()
    expect(routeKey(t, ['r', 'v'], KEY_F, [...FIND, 'toc.toggle'], 'mac')).toEqual({
      target: 'root',
      command: 'toc.toggle',
    })
  })

  it('inert 的那一格一律不接', () => {
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('v', 'viewer', 'r', { inert: true, commands: { 'view.find': () => {} } }),
    )
    expect(routeKey(t, ['r', 'v'], KEY_F, FIND, 'mac')).toBeNull()
  })

  it('没有任何响应者命中 → 候选里 app 那一条走 root;候选空就是 null', () => {
    const t = tree(scopeNode('r', 'root', null))
    expect(routeKey(t, ['r'], KEY_P, ['toggle:search'], 'mac')).toEqual({
      target: 'root',
      command: 'toggle:search',
    })
    expect(routeKey(t, ['r'], KEY_P, noCandidates, 'mac')).toBeNull()
  })
})

describe('routeKey —— 认领(`claims`):壳不碰,原样交给里面那台程序', () => {
  /*
   * **K0 的那一格**(方案 §4 ③)。终端在 Win / Linux 上认领 `Ctrl+P/E/J/N/W` ——
   * 那五个键在 readline 下是每天都在按的,而主修饰键在那两台机器上**就是** Ctrl,
   * 与应用的 ⌘P/⌘E/⌘J/⌘N/⌘W 抢的是同一枚物理键。
   *
   * 认领与「接住并执行」是两件事:命中 claim 回的是 `claim`,调用方据此**不**
   * `preventDefault`、也不再往外问,xterm 收到原生 keydown 自己把 `\x10` 发下去。
   * 从前这里是「局部键 + 一个把控制字节写回 PTY 的 action」——壳先截下来,
   * 再自己写一遍 xterm 本来就会写的那个字节。
   */
  /*
   * **K2 换了样本键**:检索面让出 ⌘P 之后 `^P` 不再与任何一条命令抢键(那一档
   * 由「问不到人就不 preventDefault」这条缺省覆盖,不必走认领),于是这一节改用
   * `^N` —— 它抢的是 `content.new`(⌘N),而 `^N` 在 readline 下是「下一条历史」。
   * 认领那条路一个字没改,只是拿一个**此刻真的会撞**的键来量它。
   */
  const CTRL_N = { key: 'n', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }

  it('Win / Linux:Ctrl+N 在终端里答 `claim`,不落到 `content.new`', () => {
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('leaf', 'leaf', 'r', { commands: { 'tab.close': () => {} } }),
      scopeNode('term', 'terminal', 'leaf', { commands: { 'view.find': () => {} } }),
    )
    expect(routeKey(t, ['r', 'leaf', 'term'], CTRL_N, ['content.new'], 'other')).toEqual({
      target: 'claim',
      instanceId: 'term',
      scope: 'terminal',
    })
  })

  it('**Ctrl+W 同理** —— 装着它的那片叶答 `tab.close`,但认领比它深,所以先命中', () => {
    /*
     * 这一条钉的是深度裁决本身:终端比叶深,由深到浅走先遇到认领。哪天
     * `leaf` 与 `terminal` 的父子关系反了(或者循环改成由浅到深),
     * 「终端里 Ctrl+W 删一个词」当场变成「关掉跑着的 shell」。
     */
    const CTRL_W = { key: 'w', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('leaf', 'leaf', 'r', { commands: { 'tab.close': () => {} } }),
      scopeNode('term', 'terminal', 'leaf', {}),
    )
    expect(routeKey(t, ['r', 'leaf', 'term'], CTRL_W, ['tab.close'], 'other')).toMatchObject({
      target: 'claim',
    })
  })

  it('mac:认领表是空的,Ctrl+N 谁都不命中(⌘ 与 Ctrl 分得开)', () => {
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('term', 'terminal', 'r', { commands: { 'view.find': () => {} } }),
    )
    // mac 上 Ctrl+N 连候选都算不出来(`lookupCommands` 那一头),这里直接给空候选。
    expect(routeKey(t, ['r', 'term'], CTRL_N, [], 'mac')).toBeNull()
  })

  it('`claiming: false` = 里面那台程序此刻不收键(查找框在打字)→ 认领整族让开', () => {
    /*
     * 实例那一头的开关,与 `commands[id]` 缺席同一个形。少了它,Win / Linux 上
     * 在终端查找框里按 Ctrl+W 会被当成「归 PTY」放行,而那时候在收键的是一只
     * 输入框,不是 shell。
     */
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('term', 'terminal', 'r', { claiming: false, commands: { 'view.find': () => {} } }),
    )
    expect(routeKey(t, ['r', 'term'], CTRL_N, ['toggle:search'], 'other')).toEqual({
      target: 'root',
      command: 'toggle:search',
    })
  })

  it('inert 的那一格连认领都不算数', () => {
    const t = tree(
      scopeNode('r', 'root', null),
      scopeNode('term', 'terminal', 'r', { inert: true }),
    )
    expect(routeKey(t, ['r', 'term'], CTRL_N, ['toggle:search'], 'other')).toEqual({
      target: 'root',
      command: 'toggle:search',
    })
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

describe('returnTargetOf ① returnTo —— 兄弟之间的那一格(§4.5 R1 裁定,R2 落地)', () => {
  /**
   * 场景就是 gate 场景 12:焦点在输入面板 → ⌘P 开出检索面(**兄弟**,不是孩子)→
   * Esc 关掉。父链只到得了 root,所以「回开它之前那个输入框」必须靠 `returnTo`。
   *
   * 反证:把 `returnTargetOf` 开头那一段 returnTo 判据删掉 → 这一条回的是 root。
   */
  it('兄弟归还:检索面关掉,焦点回它开出来之前那个输入框', () => {
    const rootEl = el()
    const composerRoot = el()
    const box = document.createElement('textarea')
    composerRoot.append(box)
    const t = tree(
      scopeNode('r', 'root', null, { root: rootEl }),
      scopeNode('c', 'composer', 'r', { root: composerRoot, lastFocused: box }),
      scopeNode('s', 'search', 'r', {
        root: el(),
        returnTo: { instanceId: 'c', element: box },
      }),
    )
    expect(returnTargetOf(t, t.get('s'))).toEqual({ instanceId: 'c', element: box })
  })

  it('returnTo 那一格**已经卸载** → 退回父链(不去猜第二个候选)', () => {
    const rootEl = el()
    const gone = document.createElement('textarea')
    document.body.append(gone)
    const t = tree(
      scopeNode('r', 'root', null, { root: rootEl }),
      // 'c' 不在表里 = 它自己也卸载了。
      scopeNode('s', 'search', 'r', {
        root: el(),
        returnTo: { instanceId: 'c', element: gone },
      }),
    )
    expect(returnTargetOf(t, t.get('s'))).toEqual({ instanceId: 'r', element: rootEl })
  })

  it('returnTo 那一格**变 inert** → 退回父链(不往看不见的面上送焦点)', () => {
    const rootEl = el()
    const shelfRoot = el()
    const box = document.createElement('input')
    shelfRoot.append(box)
    const t = tree(
      scopeNode('r', 'root', null, { root: rootEl }),
      scopeNode('c', 'composer', 'r', { root: shelfRoot, lastFocused: box, inert: true }),
      scopeNode('s', 'search', 'r', {
        root: el(),
        returnTo: { instanceId: 'c', element: box },
      }),
    )
    expect(returnTargetOf(t, t.get('s'))).toEqual({ instanceId: 'r', element: rootEl })
  })

  it('returnTo 记的**元素已经不连通** → 退回父链', () => {
    const rootEl = el()
    const detached = document.createElement('textarea') // 没进文档
    const t = tree(
      scopeNode('r', 'root', null, { root: rootEl }),
      scopeNode('c', 'composer', 'r', { root: el() }),
      scopeNode('s', 'search', 'r', {
        root: el(),
        returnTo: { instanceId: 'c', element: detached },
      }),
    )
    expect(returnTargetOf(t, t.get('s'))).toEqual({ instanceId: 'r', element: rootEl })
  })

  it('没有 returnTo 的一格,走的仍然是原来那三格父链', () => {
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
})

describe('returnTargetOf ② 父链 —— 卸载后焦点回哪儿(归还是结构性的)', () => {
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

/**
 * **Tab 圈在哪一格里**(`modalTrapNode`)。两步判据,第二步有病历:
 * `ui/a11y/focus-trap` 那只退役的 hook 之所以把监听挂在 document 而不是容器上,
 * 逐字的理由是「焦点万一已经跑到容器外面,挂容器就再也收不到这一下 Tab」。
 * 只按活动路径判等于把那条判例丢掉,所以有第二步。
 */
describe('modalTrapNode —— Tab 圈在哪一格里', () => {
  it('路径上最深那个 modal:对话框里开菜单,圈的是菜单', () => {
    const t = tree(
      scopeNode('r', 'root', null, { root: el() }),
      scopeNode('d', 'dialog', 'r', { root: el() }),
      scopeNode('m', 'menu', 'd', { root: el() }),
    )
    expect(modalTrapNode(t, ['r', 'd', 'm'])?.instanceId).toBe('m')
    // 菜单关掉之后路径缩回对话框,圈的就是对话框。
    expect(modalTrapNode(t, ['r', 'd'])?.instanceId).toBe('d')
  })

  it('**焦点跑到模态外面**:路径上一个 modal 都没有,照样圈得住(退役 hook 那条判例)', () => {
    const t = tree(
      scopeNode('r', 'root', null, { root: el() }),
      scopeNode('d', 'dialog', 'r', { root: el() }),
    )
    // 路径只有 root —— 焦点被别处抢走了。模态还在场,Tab 仍归它。
    expect(modalTrapNode(t, ['r'])?.instanceId).toBe('d')
  })

  it('一格 modal 都没有 → null(结构键放行,别处一律不管)', () => {
    const t = tree(
      scopeNode('r', 'root', null, { root: el() }),
      scopeNode('v', 'viewer', 'r', { root: el() }),
    )
    expect(modalTrapNode(t, ['r', 'v'])).toBeNull()
  })

  it('没铺根元素的不算 —— 还没到位的东西圈不住任何东西', () => {
    const t = tree(
      scopeNode('r', 'root', null, { root: el() }),
      scopeNode('d', 'dialog', 'r'),
    )
    expect(modalTrapNode(t, ['r', 'd'])).toBeNull()
  })

  it('inert 的不算(整块看不见的面不该圈住键盘)', () => {
    const t = tree(
      scopeNode('r', 'root', null, { root: el() }),
      scopeNode('d', 'dialog', 'r', { root: el(), inert: true }),
    )
    expect(modalTrapNode(t, ['r'])).toBeNull()
  })

  it('第二步取**树深最大**的那一个(与第一步同一个口径,不引入第二种说法)', () => {
    const t = tree(
      scopeNode('r', 'root', null, { root: el() }),
      scopeNode('d', 'dialog', 'r', { root: el() }),
      scopeNode('m', 'menu', 'd', { root: el() }),
    )
    expect(modalTrapNode(t, ['r'])?.instanceId).toBe('m')
  })
})

/**
 * **inert 祖先截断**(2026-09-12「收起 ≠ 关闭」抓的:架子收起改成保挂载之后
 * 才活出来的树形)。树:root > shelf-layer(**inert**)> leaf(自己不 inert)> search。
 * 归还从 `search` 往上走,第一个碰到的是 `leaf` —— 它自己的旗是干净的,可它整个
 * 躺在一块 inert 的面里。从前这一形活不到被问(收起把整层卸载),今天它是常态。
 *
 * 反证:把 `returnTargetOf` 里的 `isReachablyInteractive` 换回 `isInteractive` →
 * 第一条回的是 `leaf` 的根;把 `acceptsFocus` 的 `closest('[inert]')` 拆掉 → 第二条
 * 回的是那只躺在 inert 容器里的输入框。
 */
describe('returnTargetOf ③ inert 祖先截断 —— 架子收起保挂载(2026-09-12)', () => {
  it('归还跳过「自己干净、祖先 inert」的叶,落到 root', () => {
    const rootEl = el()
    // 输入面板与架子都长在 root 的根元素**里面**(与真机 DOM 同形,`contains` 才成立)。
    const composerRoot = document.createElement('div')
    rootEl.append(composerRoot)
    const box = document.createElement('textarea')
    composerRoot.append(box)
    const shelfRoot = document.createElement('div')
    shelfRoot.setAttribute('inert', '')
    rootEl.append(shelfRoot)
    const leafRoot = document.createElement('div')
    shelfRoot.append(leafRoot)
    const t = tree(
      scopeNode('r', 'root', null, { root: rootEl, lastFocused: box }),
      scopeNode('c', 'composer', 'r', { root: composerRoot, lastFocused: box }),
      scopeNode('sh', 'shelf-layer', 'r', { root: shelfRoot, inert: true }),
      scopeNode('l', 'leaf', 'sh', { root: leafRoot }),
      scopeNode('s', 'search', 'l', {
        root: el(),
        // 上一任是那一层自己(召唤露面时先聚的是层),此刻它 inert 了。
        returnTo: { instanceId: 'sh', element: shelfRoot },
      }),
    )
    expect(isReachablyInteractive(t, t.get('l'))).toBe(false)
    expect(nearestInteractiveAncestorOf(t, t.get('s'))?.instanceId).toBe('r')
    expect(returnTargetOf(t, t.get('s'))).toEqual({ instanceId: 'r', element: box })
  })

  it('候选元素自己躺在 DOM 的 `[inert]` 容器里 → 跳过(树上没登记那只容器)', () => {
    const rootEl = el()
    const hidden = document.createElement('div')
    hidden.setAttribute('inert', '')
    const stale = document.createElement('button')
    hidden.append(stale)
    rootEl.append(hidden)
    const resting = document.createElement('textarea')
    rootEl.append(resting)
    const t = tree(
      scopeNode('r', 'root', null, {
        root: rootEl,
        lastFocused: stale,
        restingTarget: () => resting,
      }),
      scopeNode('s', 'search', 'r', { root: el() }),
    )
    expect(returnTargetOf(t, t.get('s'))).toEqual({ instanceId: 'r', element: resting })
  })

  it('父不在表上是合法中间态:不因它判死', () => {
    const t = tree(scopeNode('l', 'leaf', 'ghost', { root: el() }))
    expect(isReachablyInteractive(t, t.get('l'))).toBe(true)
  })
})

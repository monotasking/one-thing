import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusTree } from '../registry'

/**
 * **`FocusTree` 的状态表守卫**(三张表在 `registry.ts` 文件头)。
 *
 * 这一组钉的是那张表里每一格真的成立:换宿主保住 `lastFocused`、宿主打 inert
 * 等于结构变化、孤儿焦点不改路径、独占口吃掉一切、`reset()` 是唯一那口拆卸。
 *
 * **那道闸**:`policy.moveFocus` R0 缺省 false(只观察),**R1 起缺省 true**。
 * 所以这一组的 `afterEach` 把它还原成 true —— 还原成 false 的话,下一份用例
 * 就在一个产品里不存在的档位上跑。要验「关着时一个 `focus()` 都不发」的那条
 * 自己临时关掉再验,那是这道闸留着的唯一理由(真机上万一某条搬焦点的路有害,
 * 一句话退回只观察)。
 */

afterEach(() => {
  focusTree.reset()
  focusTree.policy.moveFocus = true
  document.body.innerHTML = ''
})

describe('闸', () => {
  it('R1 缺省搬焦点(R0 是 false,那一批只观察)', () => {
    expect(focusTree.policy.moveFocus).toBe(true)
  })
})

/**
 * 造一层**真的嵌套**:壳根 → 面根 → 内容。
 * 不许让两格作用域共用同一个根元素 —— 真机上它们本来就是套着的,
 * 共用一个元素会让「哪块面接住了这次焦点」变成一道平局题(判据见
 * `scopeAtElement` 的树深兜底),而那不是这一组要测的东西。
 */
function mount(...children: HTMLElement[]): { shell: HTMLElement; pane: HTMLElement } {
  const shell = document.createElement('div')
  const pane = document.createElement('div')
  pane.append(...children)
  shell.append(pane)
  document.body.append(shell)
  return { shell, pane }
}

/** 一个可聚焦的夹具元素。用 createElement 而不是 innerHTML 字符串:
 *  那些字符串会被 `ui:consume` 的裸钮规则当成手写按钮扫到(它按标签形状扫源文本)。 */
function focusable(id?: string): HTMLButtonElement {
  const b = document.createElement('button')
  if (id) b.id = id
  return b
}

/** 一小块带自己根元素的子面(跳转条那种)。 */
function subPane(id: string, ...children: HTMLElement[]): HTMLElement {
  const box = document.createElement('div')
  box.id = id
  box.append(...children)
  return box
}

describe('登记与路径', () => {
  it('登记 → 有节点;摘掉 → 没了', () => {
    const root = focusTree.register('root', null)
    expect(focusTree.nodes().size).toBe(1)
    root.unregister()
    expect(focusTree.nodes().size).toBe(0)
    // 幂等:再摘一次什么都不做(卸载序不保证只跑一次)。
    root.unregister()
    expect(focusTree.nodes().size).toBe(0)
  })

  it('activate 把第一响应者指过去,路径从根排到它', () => {
    const root = focusTree.register('root', null)
    const layer = focusTree.register('float-layer', root.instanceId)
    const viewer = focusTree.register('viewer', layer.instanceId)
    viewer.activate('open')
    expect(focusTree.activePath()).toEqual([
      root.instanceId,
      layer.instanceId,
      viewer.instanceId,
    ])
    expect(focusTree.current()?.scope).toBe('viewer')
  })

  it('祖先 inert、自己干净的那一格同样不许被 activateScope 选中(2026-09-12 架子收起保挂载)', () => {
    const root = focusTree.register('root', null)
    const shelf = focusTree.register('shelf-layer', root.instanceId, { inert: true })
    const leafRoot = document.createElement('div')
    document.body.append(leafRoot)
    const leaf = focusTree.register('leaf', shelf.instanceId)
    leaf.setRoot(leafRoot)
    // 反证:把 `activateScope` 里的 `isReachablyInteractive` 换回 `isInteractive` → 这一句答 true。
    expect(focusTree.activateScope('leaf')).toBe(false)
    leafRoot.remove()
  })

  it('inert 的那一格不许被 activate 选中', () => {
    const root = focusTree.register('root', null)
    const shelf = focusTree.register('shelf-layer', root.instanceId, { inert: true })
    shelf.activate()
    expect(focusTree.current()).toBeUndefined()
  })
})

describe('DOM 焦点(focusin)', () => {
  it('焦点落进一块面 → 它成为第一响应者,并记下 lastFocused', () => {
    const btn = focusable('b')
    const { shell, pane } = mount(btn)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const viewer = focusTree.register('viewer', root.instanceId)
    viewer.setRoot(pane)
    btn.focus()
    expect(focusTree.current()?.instanceId).toBe(viewer.instanceId)
    expect(focusTree.nodes().get(viewer.instanceId)?.lastFocused).toBe(btn)
  })

  it('**lastFocused 只记最内层那一格**,不往祖先上抹', () => {
    // 抹了的话:跳转条一开,查看器的 lastFocused 就变成跳转条的输入框;
    // 跳转条一卸载那个元素已经不连通,「回查看器上次那一行」当场落空。
    const row = focusable('row')
    const input = document.createElement('input')
    const barEl = subPane('bar', input)
    const { shell, pane } = mount(row, barEl)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const viewer = focusTree.register('viewer', root.instanceId)
    viewer.setRoot(pane)
    const jump = focusTree.register('jumpbar', viewer.instanceId)
    jump.setRoot(barEl)

    row.focus()
    input.focus()

    expect(focusTree.nodes().get(viewer.instanceId)?.lastFocused).toBe(row)
    expect(focusTree.nodes().get(jump.instanceId)?.lastFocused).toBe(input)
  })

  it('焦点掉出所有作用域(孤儿)→ **路径不变**', () => {
    // 第一响应者不会因为一个 DOM 节点消失而消失(§4.2)。
    const inside = focusable()
    const { shell, pane } = mount(inside)
    const outside = focusable()
    document.body.append(outside)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const viewer = focusTree.register('viewer', root.instanceId)
    viewer.setRoot(pane)
    inside.focus()
    expect(focusTree.current()?.instanceId).toBe(viewer.instanceId)

    outside.focus()
    expect(focusTree.current()?.instanceId).toBe(viewer.instanceId)
  })
})

describe('结构变化后的结算', () => {
  it('第一响应者卸载 → 路径**当场**缩回父,焦点**晚一个微任务**回父的 lastFocused', async () => {
    const row = focusable('row')
    const input = document.createElement('input')
    const barEl = subPane('bar', input)
    const { shell, pane } = mount(row, barEl)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const viewer = focusTree.register('viewer', root.instanceId)
    viewer.setRoot(pane)
    const jump = focusTree.register('jumpbar', viewer.instanceId)
    jump.setRoot(barEl)
    row.focus()
    input.focus()

    jump.unregister()
    /*
     * 结算拆成了两半(S4,判词在 `FocusTree.pendingUnregister`):**路径当场缩**
     * (读的人永远拿得到一段可交互的路径),**焦点回落晚一个微任务**(那一个微任务
     * 里同一个实例 id 要是又登记回来,这一摘就根本不算「走了」)。
     */
    expect(focusTree.current()?.instanceId).toBe(viewer.instanceId)
    expect(document.activeElement).not.toBe(row)
    await Promise.resolve()
    expect(document.activeElement).toBe(row)
  })

  it('闸关掉时路径照缩,但**一个 focus() 都不发**(这道闸留着的理由)', () => {
    focusTree.policy.moveFocus = false
    const input = document.createElement('input')
    const barEl = subPane('bar', input)
    const { shell, pane } = mount(focusable('row'), barEl)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const viewer = focusTree.register('viewer', root.instanceId)
    viewer.setRoot(pane)
    const jump = focusTree.register('jumpbar', viewer.instanceId)
    jump.setRoot(barEl)
    input.focus()
    const spy = vi.spyOn(HTMLElement.prototype, 'focus')

    jump.unregister()
    expect(focusTree.current()?.instanceId).toBe(viewer.instanceId)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('宿主打 inert = 结构变化:路径缩到最近可交互祖先(架子切 tab)', () => {
    const root = focusTree.register('root', null)
    const shelf = focusTree.register('shelf-layer', root.instanceId)
    const files = focusTree.register('files', shelf.instanceId)
    files.activate()
    expect(focusTree.current()?.instanceId).toBe(files.instanceId)

    shelf.update({ inert: true })
    expect(focusTree.current()?.instanceId).toBe(root.instanceId)
  })

  it('**换宿主不是重挂**:同一个实例换 root,lastFocused 活过这次搬家', () => {
    const a = focusable('a')
    const { shell, pane: shelfEl } = mount(a)
    const floatEl = document.createElement('div')
    shell.append(floatEl)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const viewer = focusTree.register('viewer', root.instanceId)
    viewer.setRoot(shelfEl)
    a.focus()
    expect(focusTree.nodes().get(viewer.instanceId)?.lastFocused).toBe(a)

    viewer.setRoot(floatEl)
    expect(focusTree.nodes().get(viewer.instanceId)?.lastFocused).toBe(a)
    expect(focusTree.nodes().get(viewer.instanceId)?.root).toBe(floatEl)
  })

  /*
   * ── 「一次重挂」不是「它走了」(S4,09-04)────────────────────────────────────
   * 判词与真机时间线写在 `FocusTree.pendingUnregister` 头上。这四条钉的是那条规矩
   * 的四个面:同 id 回来 = 没走过 / 真走了仍归还 / 归还与 I1 收回不双跳 /
   * 节点身上那几格活过重挂。
   */
  it('**同一个实例 id 在同一拍里注销再登记 = 它没走**:焦点一步不动,归还一句不发', async () => {
    const input = document.createElement('input')
    const paneEl = subPane('pane', input)
    const { shell } = mount(focusable('row'), paneEl)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const files = focusTree.register('files', root.instanceId, {}, 'files@same')
    files.setRoot(paneEl)
    input.focus()
    expect(focusTree.current()?.instanceId).toBe('files@same')

    // React 的模拟卸载 → 再挂载:同一拍里注销、再用**同一个 instanceId** 登记回来。
    files.unregister()
    const again = focusTree.register('files', root.instanceId, {}, 'files@same')
    again.setRoot(paneEl)
    // 路径当场就还回去了(焦点根本没搬过,所以路径也该回原样)。
    expect(focusTree.current()?.instanceId).toBe('files@same')
    await Promise.resolve()
    /*
     * 反证:把 `unregister` 里那段「延后 + 复活取消」换回当场 `settle()` → 这里红,
     * 读数是 `document.activeElement` = `#row`(结构归还把焦点送去了 root 的 lastFocused)。
     */
    expect(document.activeElement).toBe(input)
    expect(focusTree.current()?.instanceId).toBe('files@same')
  })

  it('复活的那一格**是原来那个节点**:lastFocused / root 都活过这次重挂', async () => {
    const input = document.createElement('input')
    const paneEl = subPane('pane', input)
    const { shell } = mount(paneEl)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const files = focusTree.register('files', root.instanceId, {}, 'files@keep')
    files.setRoot(paneEl)
    input.focus()

    files.unregister()
    focusTree.register('files', root.instanceId, {}, 'files@keep')
    await Promise.resolve()
    const node = focusTree.nodes().get('files@keep')
    expect(node?.lastFocused).toBe(input)
    expect(node?.root).toBe(paneEl)
  })

  it('**真的走了就照旧归还** —— 只是晚一个微任务(少了这一条,把归还整只删掉也能绿)', async () => {
    const row = focusable('row')
    const input = document.createElement('input')
    const paneEl = subPane('pane', input)
    const { shell } = mount(row, paneEl)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const files = focusTree.register('files', root.instanceId, {}, 'files@gone')
    files.setRoot(paneEl)
    row.focus()
    input.focus()

    files.unregister()
    await Promise.resolve()
    expect(document.activeElement).toBe(row)
  })

  /*
   * **归还与 I1 收回的次序**(任务点名要钉的那一条)。真卸载时 React 先跑卸载 effect
   * (`unregister` 在这里排下微任务)、**再**把 DOM 摘掉;摘掉那一刻焦点掉到 body,
   * `focusout`(`relatedTarget === null`)那一路也排一个微任务去 `recoverOrphanFocus`。
   * 两者都在微任务队列上,而归还**先排**,所以焦点只搬**一次**、落点是 `returnTargetOf`
   * 答的那个元素 —— 不是「先被收回到 root 的落点、归还再搬一次」的双跳。
   */
  it('归还排在 I1 收回**前面**:焦点只搬一次,落点是归还的那个元素(不双跳)', async () => {
    const row = focusable('row')
    const input = document.createElement('input')
    const paneEl = subPane('pane', input)
    const { shell } = mount(row, paneEl)
    shell.tabIndex = -1
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const files = focusTree.register('files', root.instanceId, {}, 'files@order')
    files.setRoot(paneEl)
    row.focus()
    input.focus()

    const spy = vi.spyOn(HTMLElement.prototype, 'focus')
    // ① 卸载 effect;② DOM 摘掉 + 那一发 relatedTarget 为空的 focusout。次序照 React 的。
    files.unregister()
    paneEl.remove()
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))

    await Promise.resolve()
    await Promise.resolve()
    expect(document.activeElement).toBe(row)
    // 只搬了一次 —— 双跳的话这里是 2(先 root 的落点,再归还)。
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('摘掉 onEscape 是**摘得掉**的(`undefined` 不等于「这次不改」)', () => {
    const root = focusTree.register('root', null, { onEscape: () => true })
    expect(focusTree.nodes().get(root.instanceId)?.onEscape).toBeTypeOf('function')
    root.update({ onEscape: null })
    expect(focusTree.nodes().get(root.instanceId)?.onEscape).toBeUndefined()
  })
})

describe('独占口与排障口', () => {
  it('capture 是单槽的,解除函数只解自己那一份', () => {
    const first = () => true
    const release = focusTree.capture(first)
    expect(focusTree.capturedHandler()).toBe(first)
    const second = () => false
    focusTree.capture(second)
    release() // 已经被顶掉了,解不到别人那一份
    expect(focusTree.capturedHandler()).toBe(second)
  })

  it('dump 说得出路径、独占与每一格的形', () => {
    const root = focusTree.register('root', null)
    const viewer = focusTree.register('viewer', root.instanceId, {
      commands: { 'view.find': () => {} },
    })
    viewer.activate('open')
    const shot = focusTree.dump()
    expect(shot.path).toEqual([root.instanceId, viewer.instanceId])
    expect(shot.reason).toBe('open')
    expect(shot.captured).toBe(false)
    expect(shot.nodes.find((n) => n.scope === 'viewer')?.keys).toEqual(['view.find'])
  })

  it('window.__focus.dump() 就是它(排障口按 __perf / __onethingLog 的惯例)', () => {
    focusTree.register('root', null)
    expect(window.__focus?.dump().nodes.length).toBe(1)
  })
})

describe('订阅与拆卸', () => {
  it('登记 / 激活 / 摘掉都会通知订阅者', () => {
    const seen = vi.fn()
    const off = focusTree.subscribe(seen)
    const root = focusTree.register('root', null)
    root.activate()
    root.unregister()
    expect(seen.mock.calls.length).toBeGreaterThanOrEqual(3)
    off()
  })

  it('reset() 是唯一那口拆卸:清表、清独占、拆监听,而且幂等', () => {
    const probe = focusable()
    const { shell } = mount(probe)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    focusTree.capture(() => true)

    focusTree.reset()
    focusTree.reset()
    expect(focusTree.nodes().size).toBe(0)
    expect(focusTree.capturedHandler()).toBeNull()
    expect(focusTree.activePath()).toEqual([])

    // 监听真拆了:reset 之后再落一次焦点,树不该长出任何东西。
    probe.focus()
    expect(focusTree.current()).toBeUndefined()
  })

  it('reset() 真的把两个 document 监听摘了(HMR dispose 就靠这一口)', () => {
    /*
     * 上一条从**行为**那头看不出这件事:表已经清空,监听还在也查不到东西。
     * 而热更后旧模块的监听留着,就是「两台树同时听 focusin、各自算各自的路径」——
     * 与 chat-source 那次「两台折叠器同时活着」同型,所以这一条从装 / 拆的**配对**
     * 那头钉。拆掉 reset 里那两句 removeEventListener,这一条当场红。
     */
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const watched = (calls: unknown[][]) =>
      calls.filter((c) => c[0] === 'focusin' || c[0] === 'focusout' || c[0] === 'pointerdown').length

    focusTree.register('root', null)
    expect(watched(add.mock.calls), '登记第一格时装上三个监听').toBe(3)
    focusTree.register('viewer', null)
    expect(watched(add.mock.calls), '第二格不再重复装(attach 幂等)').toBe(3)

    focusTree.reset()
    expect(watched(remove.mock.calls), 'reset 把三个都摘了').toBe(3)
    focusTree.reset()
    expect(watched(remove.mock.calls), '再 reset 一次不重复摘(幂等)').toBe(3)

    add.mockRestore()
    remove.mockRestore()
  })
})

/**
 * **I1 的三处收回**(设计 §4.1 修正段)。R0 只有 `settle()` 那一处,R1 补齐另外两处 ——
 * 少一处都不成立:焦点掉到 body 不发 `focusin`(所以要 `focusout`),被聚焦的元素
 * 被静默移除时连 `focusout` 都不发(所以派发器每次按键之前还要再问一次)。
 */
describe('孤儿焦点收回(I1)', () => {
  function tree(): { shell: HTMLElement; pane: HTMLElement; probe: HTMLButtonElement } {
    const probe = focusable('probe')
    const { shell, pane } = mount(probe)
    shell.tabIndex = -1
    pane.tabIndex = -1
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const viewer = focusTree.register('viewer', root.instanceId)
    viewer.setRoot(pane)
    return { shell, pane, probe }
  }

  it('焦点落回落点(第一响应者的根),不是留在 body 上', () => {
    const { pane, probe } = tree()
    probe.focus()
    expect(focusTree.current()?.scope).toBe('viewer')

    probe.blur()
    expect(document.activeElement).toBe(document.body)
    focusTree.recoverOrphanFocus()
    expect(document.activeElement).toBe(pane)
  })

  it('焦点没掉到 body 时一个字都不做(不许把正在用的焦点抢走)', () => {
    const { probe } = tree()
    probe.focus()
    focusTree.recoverOrphanFocus()
    expect(document.activeElement).toBe(probe)
  })

  it('第一响应者答不出落点时回 root 的根(树刚起来、或那一格没铺根)', () => {
    const shell = document.createElement('div')
    shell.tabIndex = -1
    document.body.append(shell)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    // 一格没铺根元素的作用域当第一响应者:它答不出落点。
    const viewer = focusTree.register('viewer', root.instanceId)
    viewer.activate()

    focusTree.recoverOrphanFocus()
    expect(document.activeElement).toBe(shell)
  })

  it('闸关掉时一个 focus() 都不发', () => {
    focusTree.policy.moveFocus = false
    const { probe } = tree()
    probe.focus()
    probe.blur()
    const spy = vi.spyOn(HTMLElement.prototype, 'focus')
    focusTree.recoverOrphanFocus()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('`focusout` 且 relatedTarget 为空 → 微任务之后收回(body 不发 focusin,这一处不能省)', async () => {
    const { pane, probe } = tree()
    probe.focus()
    probe.blur()
    // blur() 在 jsdom 里也发一发 focusout(relatedTarget 为 null),与真机同形。
    await Promise.resolve()
    expect(document.activeElement).toBe(pane)
  })

  it('正常的焦点转移(relatedTarget 有值)不触发收回 —— 否则每一次点击都会被拽回去', async () => {
    const { probe } = tree()
    const other = focusable('other')
    document.body.append(other)
    probe.focus()
    // 焦点从 probe 交给 other:真机上 focusout 的 relatedTarget 就是 other。
    other.focus()
    await Promise.resolve()
    expect(document.activeElement).toBe(other)
  })
})

/**
 * **瞬态口**(Tooltip 那一族:不占焦点、也没有一个包着触发元素的根)。
 * 它不是作用域,所以按登记序被问、且被问在活动路径之前(见 `registry.ts` 文件头)。
 */
describe('瞬态 Esc 口', () => {
  it('登记 → 在表上;解除函数摘掉它;摘两次是幂等的', () => {
    const off = focusTree.registerTransient(() => false)
    expect(focusTree.transientEscapeHandlers().length).toBe(1)
    off()
    off()
    expect(focusTree.transientEscapeHandlers()).toEqual([])
  })

  it('按登记序交出去(后登记的后问,与「后开的在上面」同向)', () => {
    const first = () => false
    const second = () => false
    focusTree.registerTransient(first)
    focusTree.registerTransient(second)
    expect(focusTree.transientEscapeHandlers()).toEqual([first, second])
  })

  it('reset() 把它一并清掉(HMR dispose 复用的就是这一口)', () => {
    focusTree.registerTransient(() => false)
    focusTree.reset()
    expect(focusTree.transientEscapeHandlers()).toEqual([])
  })
})

/**
 * `activate()` 不把第一响应者从**自己的后代**那里拽回来(R1 补)。
 * 病历:React 的 effect 子先于父跑,同一次提交里一起挂载的父子两层,
 * 父那一句 `activate` 会把层序整个倒过来。
 */
describe('activate:已经在我里面了就不往回拽', () => {
  it('第一响应者是我的后代 → activate 不改路径', () => {
    const root = focusTree.register('root', null)
    const dialog = focusTree.register('dialog', root.instanceId)
    const menu = focusTree.register('menu', dialog.instanceId)
    menu.activate('open')
    expect(focusTree.current()?.scope).toBe('menu')

    dialog.activate('open')
    expect(focusTree.current()?.scope).toBe('menu')
  })

  it('第一响应者在别的枝上 → 照常拽过来', () => {
    const root = focusTree.register('root', null)
    const stage = focusTree.register('stage-layer', root.instanceId)
    const dialog = focusTree.register('dialog', root.instanceId)
    stage.activate('open')
    dialog.activate('open')
    expect(focusTree.current()?.scope).toBe('dialog')
  })
})

describe('returnTo —— 换人那一刻记下上一任(§4.5 R1 裁定,R2 落地)', () => {
  /** 造一格真能拿焦点的输入框,挂在给定的根里。 */
  function boxIn(root: HTMLElement): HTMLInputElement {
    const box = document.createElement('input')
    root.append(box)
    return box
  }

  it('兄弟归还:检索面关掉,焦点回它开出来之前那个输入框', async () => {
    const shell = document.createElement('div')
    const composerRoot = document.createElement('div')
    const searchRoot = document.createElement('div')
    shell.append(composerRoot, searchRoot)
    document.body.append(shell)

    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const composer = focusTree.register('composer', root.instanceId)
    composer.setRoot(composerRoot)
    const box = boxIn(composerRoot)
    box.focus()
    expect(focusTree.current()?.scope).toBe('composer')

    // ⌘P:检索面是 root 的孩子,与 composer 是**兄弟** —— 父链到不了它。
    const search = focusTree.register('search', root.instanceId)
    search.setRoot(searchRoot)
    const field = boxIn(searchRoot)
    search.activate('open')
    field.focus()

    search.unregister()
    // 归还晚一个微任务(S4);路径那一半是同步的。
    await Promise.resolve()
    expect(document.activeElement).toBe(box)
  })

  it('收回(I1)**不算换人**:壳根接过焦点,壳根那一格不会记下一个 returnTo', () => {
    const shell = document.createElement('div')
    shell.tabIndex = -1
    const composerRoot = document.createElement('div')
    shell.append(composerRoot)
    document.body.append(shell)

    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const composer = focusTree.register('composer', root.instanceId)
    composer.setRoot(composerRoot)
    boxIn(composerRoot).focus()
    expect(focusTree.current()?.scope).toBe('composer')

    /*
     * 焦点掉到 body,而第一响应者此刻答不出落点(换宿主中途:根还没铺回来)——
     * 收回于是退到壳根那一格。**这一下不许写 returnTo**:它记下来的会是
     * 「开检索面之前我在壳根」,而事实是在那个输入框里(§4.5 裁定的原话)。
     */
    composer.setRoot(null)
    ;(document.activeElement as HTMLElement | null)?.blur()
    focusTree.recoverOrphanFocus()
    expect(document.activeElement).toBe(shell)

    const rootDump = focusTree.dump().nodes.find((n) => n.scope === 'root')
    // 反证:把 recoverOrphanFocus 里那层 withoutReturnSeat 拆掉 → 这里会是 composer 的实例 id。
    expect(rootDump?.returnTo).toBeNull()
  })

  it('pointerdown 抢根在今天的壳里**够不着**(作用域根自带 tabIndex,浏览器原生已经做完这件事)', () => {
    const shell = document.createElement('div')
    shell.tabIndex = -1
    const viewerRoot = document.createElement('div')
    viewerRoot.tabIndex = -1
    const body = document.createElement('pre')
    viewerRoot.append(body)
    shell.append(viewerRoot)
    document.body.append(shell)

    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const viewer = focusTree.register('viewer', root.instanceId)
    viewer.setRoot(viewerRoot)

    const grab = vi.spyOn(viewerRoot, 'focus')
    body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    /*
     * §4.6 那只 document 监听头一句就是「点在一个自己能接焦点的东西上 → 不插手」,
     * 判据是 `closest('…,[tabindex],…')` —— 而 R1 起**每一个作用域根都铺着
     * `tabIndex={-1}`**,所以这一句在壳里恒真:抢根那一路够不着。
     * 它并不是白留着:浏览器原生就把「点非可聚焦元素 → 焦点给最近的可聚焦祖先」
     * 做完了(那正是这条判据要让开的东西),而这一格守着「别有人为了让它跑起来
     * 去把 `[tabindex]` 从那串选择器里删掉」—— 删了就等于每一次点正文都抢一遍焦点。
     * 抢根**不算换人**(不写 returnTo)那一条因此是防御性的,记在 R2 交卷报里。
     */
    expect(grab).not.toHaveBeenCalled()
  })
})

describe('activateScope —— 说得出「哪一种面」,说不出「哪一份实例」', () => {
  it('一份都没有 → false,什么都不做', () => {
    focusTree.register('root', null).setRoot(document.createElement('div'))
    expect(focusTree.activateScope('viewer')).toBe(false)
  })

  it('还没铺根 / 正 inert 的那几份不算', () => {
    const shell = document.createElement('div')
    document.body.append(shell)
    const root = focusTree.register('root', null)
    root.setRoot(shell)

    const pending = focusTree.register('viewer', root.instanceId) // 没 setRoot
    expect(pending.instanceId).toBeTruthy()
    const hidden = focusTree.register('viewer', root.instanceId, { inert: true })
    const hiddenRoot = document.createElement('div')
    hiddenRoot.tabIndex = -1
    shell.append(hiddenRoot)
    hidden.setRoot(hiddenRoot)

    expect(focusTree.activateScope('viewer')).toBe(false)
  })

  it('多份可交互 → 取 MRU(最近在活动路径上那一份)', () => {
    const shell = document.createElement('div')
    document.body.append(shell)
    const root = focusTree.register('root', null)
    root.setRoot(shell)

    const mk = () => {
      const el = document.createElement('div')
      el.tabIndex = -1
      shell.append(el)
      const handle = focusTree.register('viewer', root.instanceId)
      handle.setRoot(el)
      return { handle, el }
    }
    const a = mk()
    const b = mk()
    a.handle.activate('open')
    b.handle.activate('open')
    root.activate('open') // 焦点离开两份查看器

    expect(focusTree.activateScope('viewer')).toBe(true)
    // 最近用过的是 b。反证:把 MRU 换成「取第一个」→ 这里会是 a。
    expect(document.activeElement).toBe(b.el)
  })

  it('owner 给了就精确取那一份(同一种 layer 的好几扇)', () => {
    const shell = document.createElement('div')
    document.body.append(shell)
    const root = focusTree.register('root', null)
    root.setRoot(shell)

    const mk = (owner: string) => {
      const el = document.createElement('div')
      el.tabIndex = -1
      shell.append(el)
      const handle = focusTree.register('float-layer', root.instanceId, { owner })
      handle.setRoot(el)
      return { handle, el }
    }
    const files = mk('files')
    const sessions = mk('sessions')
    sessions.handle.activate('open') // MRU 指向 sessions
    root.activate('open')

    expect(focusTree.activateScope('float-layer', { owner: 'files' })).toBe(true)
    expect(document.activeElement).toBe(files.el)
    expect(focusTree.activateScope('float-layer', { owner: 'nobody' })).toBe(false)
  })
})

describe('layer 的落点 = 第一个可交互子作用域(设计 §4.1 那张表)', () => {
  function mountLayer(): {
    layer: ReturnType<typeof focusTree.register>
    pane: HTMLElement
    layerEl: HTMLElement
  } {
    const shell = document.createElement('div')
    shell.tabIndex = -1
    const layerEl = document.createElement('div')
    layerEl.tabIndex = -1
    const pane = document.createElement('div')
    pane.tabIndex = -1
    layerEl.append(pane)
    shell.append(layerEl)
    document.body.append(shell)

    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const layer = focusTree.register('float-layer', root.instanceId, { owner: 'files' })
    layer.setRoot(layerEl)
    const viewer = focusTree.register('viewer', layer.instanceId)
    viewer.setRoot(pane)
    return { layer, pane, layerEl }
  }

  it('激活一层 → 焦点进它装着的那块面,不是停在层的根上', () => {
    const { layer, pane } = mountLayer()
    layer.activate('placement')
    /*
     * 反证:把 `entryOf` 摘掉(activate 直接用 `restingElementOf(node)`)→ 焦点
     * 停在层的根上,那块面不在活动路径上,紧接着按 ⌘F 一样落空 ——
     * 「切 tab / 开面 / 挪位置之后键盘立刻可用」当场只兑现一半。
     */
    expect(document.activeElement).toBe(pane)
    expect(focusTree.current()?.scope).toBe('viewer')
  })

  it('层**登记了落点闭包却答 null** → 照样回落到子作用域(09-04 修的 R2 偏离)', () => {
    const shell = document.createElement('div')
    const layerEl = document.createElement('div')
    layerEl.tabIndex = -1
    const pane = document.createElement('div')
    pane.tabIndex = -1
    layerEl.append(pane)
    shell.append(layerEl)
    document.body.append(shell)

    const root = focusTree.register('root', null)
    root.setRoot(shell)
    /*
     * **这就是 `FocusScope` 交给树的形**:那三个声明走 ref、不进依赖表,所以它给
     * 每一格都无条件登记一个闭包,prop 缺席时那个闭包答 null。
     *
     * 反证:把 `entryOf` 的判据改回 `!at.restingTarget`(闭包在不在)→ 这一条
     * 当场红,焦点停在 `layerEl` 上 —— 而那正是 R2 之后全壳每一次 `activate(layer)`
     * 的实况(设计 §4.1 那行「进入落点 = 第一个可交互子作用域」整条是死码)。
     */
    const layer = focusTree.register('float-layer', root.instanceId, {
      restingTarget: () => null,
    })
    layer.setRoot(layerEl)
    focusTree.register('viewer', layer.instanceId).setRoot(pane)

    layer.activate('placement')
    expect(document.activeElement).toBe(pane)
    expect(focusTree.current()?.scope).toBe('viewer')
  })

  it('层声明的落点**已经离开文档** → 也回落(答不出就是答不出)', () => {
    const shell = document.createElement('div')
    const layerEl = document.createElement('div')
    layerEl.tabIndex = -1
    const pane = document.createElement('div')
    pane.tabIndex = -1
    layerEl.append(pane)
    shell.append(layerEl)
    document.body.append(shell)
    // 造出来但从不挂进文档 —— `isConnected` 是 false。
    const orphan = document.createElement('input')

    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const layer = focusTree.register('float-layer', root.instanceId, {
      restingTarget: () => orphan,
    })
    layer.setRoot(layerEl)
    focusTree.register('viewer', layer.instanceId).setRoot(pane)

    layer.activate('placement')
    expect(document.activeElement).toBe(pane)
  })

  it('层自己声明了落点就听它的(宿主的显式意见优先于这条缺省规矩)', () => {
    const shell = document.createElement('div')
    const layerEl = document.createElement('div')
    layerEl.tabIndex = -1
    const box = document.createElement('input')
    const pane = document.createElement('div')
    pane.tabIndex = -1
    layerEl.append(box, pane)
    shell.append(layerEl)
    document.body.append(shell)

    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const layer = focusTree.register('float-layer', root.instanceId, {
      restingTarget: () => box,
    })
    layer.setRoot(layerEl)
    const viewer = focusTree.register('viewer', layer.instanceId)
    viewer.setRoot(pane)

    layer.activate('placement')
    expect(document.activeElement).toBe(box)
  })

  it('孩子正 inert(架子后台那一层里的那份)→ 退回层的根', () => {
    const { layer, layerEl } = mountLayer()
    const inertChild = [...focusTree.nodes().values()].find((n) => n.scope === 'viewer')
    expect(inertChild).toBeTruthy()
    focusTree.dump() // 只为读一眼,不改状态
    // 把那块面打成不可交互(架子切到后台的形)。
    const handle = focusTree.register('viewer', layer.instanceId, { inert: true })
    handle.setRoot(document.createElement('div'))
    // 原来那份也 inert 掉,层里于是一个可交互的孩子都没有。
    if (inertChild) inertChild.inert = true
    layer.activate('placement')
    expect(document.activeElement).toBe(layerEl)
  })
})

/**
 * **召唤问树的那一口**(S1,设计 §14)。
 *
 * `isOwnerActive` 回答第四态的判据:「焦点此刻在不在这块面里」。第四态本身
 * (09-04 改判成**隐藏**)不再需要树上的第二口 —— 面一收,层就卸载,焦点由
 * 既有的结构归还(`settle` → `returnTargetOf`)自己回去。
 */
describe('召唤:isOwnerActive', () => {
  /** 壳根 + 一扇替 `owner` 摆着的层 + 层里一块面 + 壳根上一个输入框。 */
  function mountOwned(owner: string) {
    const shell = document.createElement('div')
    shell.tabIndex = -1
    document.body.append(shell)
    const root = focusTree.register('root', null)
    root.setRoot(shell)

    const layerEl = document.createElement('div')
    layerEl.tabIndex = -1
    shell.append(layerEl)
    const layer = focusTree.register('float-layer', root.instanceId, { owner })
    layer.setRoot(layerEl)

    // 层的落点 = 第一个可交互子作用域的根,所以这块面的根要自己可聚焦。
    const paneEl = document.createElement('div')
    paneEl.tabIndex = -1
    layerEl.append(paneEl)
    const pane = focusTree.register('viewer', layer.instanceId)
    pane.setRoot(paneEl)

    const composer = focusable('composer')
    shell.append(composer)
    const region = focusTree.register('composer', root.instanceId)
    region.setRoot(composer)

    return { shell, root, layer, layerEl, pane, paneEl, composer }
  }

  it('isOwnerActive:焦点进那一层才答 true;换到别处当场变 false', () => {
    const { layer, composer } = mountOwned('files')
    expect(focusTree.isOwnerActive('files')).toBe(false)
    layer.activate('open')
    expect(focusTree.isOwnerActive('files')).toBe(true)
    // 问的是 owner 不是 scope id —— 没人替 'sessions' 摆着。
    expect(focusTree.isOwnerActive('sessions')).toBe(false)
    // 焦点真的走开(`root.activate` 走不动:第一响应者是它的后代,那一句会早退)。
    composer.focus()
    expect(focusTree.isOwnerActive('files')).toBe(false)
  })

  it('isOwnerActive:inert 的那一层不算(架子后台那一份)', () => {
    const { layer } = mountOwned('files')
    layer.activate('open')
    expect(focusTree.isOwnerActive('files')).toBe(true)
    layer.update({ inert: true })
    // 反证:`activePath()` 那一句不缩路径 → 这里仍答 true,于是召唤一块藏在
    // 后台 tab 里的面会被判成第四态「隐藏」—— 一按就把它收回 Dock,永远露不出来。
    expect(focusTree.isOwnerActive('files')).toBe(false)
  })

})

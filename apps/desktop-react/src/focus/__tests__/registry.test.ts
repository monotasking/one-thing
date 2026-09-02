import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusTree } from '../registry'

/**
 * **`FocusTree` 的状态表守卫**(三张表在 `registry.ts` 文件头)。
 *
 * 这一组钉的是那张表里每一格真的成立:换宿主保住 `lastFocused`、宿主打 inert
 * 等于结构变化、孤儿焦点不改路径、独占口吃掉一切、`reset()` 是唯一那口拆卸。
 *
 * **R0 的闸**:`policy.moveFocus` 缺省 false —— 本批只观察不搬焦点。所以每条
 * 「焦点真的被送到哪儿」的用例都自己把闸打开再验,同时另有一条验它关着时
 * 一个 `focus()` 都不发(那正是「零可感知变化」在单测里的形)。
 */

afterEach(() => {
  focusTree.reset()
  focusTree.policy.moveFocus = false
  document.body.innerHTML = ''
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
  it('第一响应者卸载 → 路径缩回父,焦点回父的 lastFocused(闸开着时)', () => {
    focusTree.policy.moveFocus = true
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
    expect(focusTree.current()?.instanceId).toBe(viewer.instanceId)
    expect(document.activeElement).toBe(row)
  })

  it('闸关着(R0 缺省)时路径照缩,但**一个 focus() 都不发**', () => {
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
      keyHandlers: { find: () => {} },
    })
    viewer.activate('open')
    const shot = focusTree.dump()
    expect(shot.path).toEqual([root.instanceId, viewer.instanceId])
    expect(shot.reason).toBe('open')
    expect(shot.captured).toBe(false)
    expect(shot.nodes.find((n) => n.scope === 'viewer')?.keys).toEqual(['find'])
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
      calls.filter((c) => c[0] === 'focusin' || c[0] === 'pointerdown').length

    focusTree.register('root', null)
    expect(watched(add.mock.calls), '登记第一格时装上两个监听').toBe(2)
    focusTree.register('viewer', null)
    expect(watched(add.mock.calls), '第二格不再重复装(attach 幂等)').toBe(2)

    focusTree.reset()
    expect(watched(remove.mock.calls), 'reset 把两个都摘了').toBe(2)
    focusTree.reset()
    expect(watched(remove.mock.calls), '再 reset 一次不重复摘(幂等)').toBe(2)

    add.mockRestore()
    remove.mockRestore()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnchorNodeCache, scanAnchorNodes } from './anchor-nodes'

/**
 * 锚点节点表的结构缓存(G 线 P4-a ②)。
 *
 * 缓存最怕的是**陈** —— 所以这一组的主角是「结构变了,下一次调用必须看得见」,
 * 省钱那一半(结构没变就不扫)只钉一条。
 */

function column(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

/** 一行账本消息:与 `ChatStream` 一样挂 `data-message-id`。 */
function landedRow(parent: HTMLElement, id: string): HTMLElement {
  const row = document.createElement('article')
  row.setAttribute('data-message-id', id)
  parent.appendChild(row)
  return row
}

const msgs = (...ids: string[]) => ids.map((id) => ({ id }))

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('AnchorNodeCache', () => {
  it('新消息落账之后,下一次调用能找到它(在飞那一格原节点上长出 data-message-id)', () => {
    const el = column()
    landedRow(el, 'u1')
    landedRow(el, 'a1')
    /* 在飞的那一格:同一个节点,落账前**不带** data-message-id(`UserBubble` 的形)。 */
    const pending = document.createElement('article')
    el.appendChild(pending)

    const cache = new AnchorNodeCache()
    const before = cache.nodesFor(el, { messages: msgs('u1', 'a1'), windowStart: undefined })
    expect(before.has('u2')).toBe(false)

    /* 落账那一次提交:DOM 上长出属性,账本上多出这一条 —— 同一个 React 提交里的两半。 */
    pending.setAttribute('data-message-id', 'u2')
    const after = cache.nodesFor(el, { messages: msgs('u1', 'a1', 'u2'), windowStart: undefined })
    expect(after.get('u2')).toBe(pending)
  })

  it('id 序列没变(流式期间每帧一只新数组)→ 不重扫,交回同一张表', () => {
    const el = column()
    landedRow(el, 'u1')
    landedRow(el, 'a1')
    const cache = new AnchorNodeCache()
    const first = cache.nodesFor(el, { messages: msgs('u1', 'a1'), windowStart: 0 })
    const spy = vi.spyOn(el, 'querySelectorAll')
    /* 活的那一条换了对象、数组也是新的 —— id 序列一格没动。 */
    const again = cache.nodesFor(el, { messages: msgs('u1', 'a1'), windowStart: 0 })
    expect(again).toBe(first)
    expect(spy).not.toHaveBeenCalled()
  })

  it('窗口往前扩 / 换容器 / 同长度换了一条 → 都重扫', () => {
    const el = column()
    landedRow(el, 'u1')
    const cache = new AnchorNodeCache()
    cache.nodesFor(el, { messages: msgs('u0', 'u1'), windowStart: 1 })

    /* 窗口扩到 0:上面多摆出一行。 */
    const older = document.createElement('article')
    older.setAttribute('data-message-id', 'u0')
    el.prepend(older)
    expect(cache.nodesFor(el, { messages: msgs('u0', 'u1'), windowStart: 0 }).has('u0')).toBe(true)

    /* 同样长度,最后一条换了人(重试:旧回复删掉、新回复同一拍进来)。 */
    el.lastElementChild?.setAttribute('data-message-id', 'u1b')
    expect(cache.nodesFor(el, { messages: msgs('u0', 'u1b'), windowStart: 0 }).has('u1b')).toBe(true)

    /* 容器重挂:节点全是新的。 */
    const next = column()
    landedRow(next, 'u0')
    landedRow(next, 'u1b')
    const table = cache.nodesFor(next, { messages: msgs('u0', 'u1b'), windowStart: 0 })
    expect(table.get('u0')?.parentElement).toBe(next)
  })

  it('invalidate 之后必重扫(兜底那一格:节点离开了文档)', () => {
    const el = column()
    const row = landedRow(el, 'u1')
    const cache = new AnchorNodeCache()
    cache.nodesFor(el, { messages: msgs('u1'), windowStart: undefined })
    row.remove()
    const fresh = landedRow(el, 'u1')
    cache.invalidate()
    expect(cache.nodesFor(el, { messages: msgs('u1'), windowStart: undefined }).get('u1')).toBe(fresh)
  })
})

describe('scanAnchorNodes', () => {
  it('只收挂着 data-message-id 的节点', () => {
    const el = column()
    landedRow(el, 'a')
    el.appendChild(document.createElement('article'))
    expect([...scanAnchorNodes(el).keys()]).toEqual(['a'])
  })
})

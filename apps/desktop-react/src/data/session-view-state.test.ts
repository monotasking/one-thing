import { afterEach, describe, expect, it } from 'vitest'
import {
  applyScrollAnchor,
  dropSessionViewState,
  forgetSessionViewStates,
  measureScrollAnchor,
  readSessionScrollAnchor,
  readSessionViewState,
  resetSessionViewStates,
  saveSessionScrollAnchor,
  sessionViewStateKeys,
} from './session-view-state'

/**
 * 会话视图状态的判据(C1 · §5.2)。
 *
 * ── jsdom 证得了什么、证不了什么 ─────────────────────────────────────────
 * jsdom **没有排版**:`getBoundingClientRect` 恒为一堆 0,`scrollHeight` /
 * `clientHeight` 也不会因为塞了几条消息就变。所以这里量法那两只函数是拿
 * **喂进去的矩形**跑的(逐个节点打桩),证的是**算术与判据**:哪一条算「还露着」、
 * offset 怎么算、锚点用回去时 `scrollTop` 落在哪。
 *
 * 「切回来之后眼睛看到的还是那一行」只有真机门说得出来 —— 见
 * `scripts/gate-continuity.mjs`(本批只写不跑,判例 09-04)。
 */

afterEach(() => resetSessionViewStates())

/**
 * 打一个**物理自洽**的桩容器:jsdom 没有排版,所以矩形由这里现算 ——
 * 行的矩形 = 容器上缘 + 它在内容里的位置 − 已经滚掉的那一段。
 * 不这么算的话「量出来再用回去」那条往返用例会以一个假的坐标系空过。
 */
function stubContainer(options: {
  top?: number
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
  rows?: { id: string; contentTop: number; height: number }[]
}): HTMLElement {
  const {
    top = 100,
    scrollTop = 0,
    scrollHeight = 1000,
    clientHeight = 400,
    rows = [],
  } = options
  const el = document.createElement('div')
  document.body.appendChild(el)
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  el.scrollTop = scrollTop
  el.getBoundingClientRect = () => ({ top, bottom: top + clientHeight }) as DOMRect
  for (const row of rows) {
    const node = document.createElement('article')
    node.setAttribute('data-message-id', row.id)
    node.getBoundingClientRect = () =>
      ({
        top: top + row.contentTop - el.scrollTop,
        bottom: top + row.contentTop + row.height - el.scrollTop,
      }) as DOMRect
    el.appendChild(node)
  }
  return el
}

describe('这张表:一条会话一份记录', () => {
  it('写 / 读:记下的锚点原样读得回来', () => {
    saveSessionScrollAnchor('s1', { messageId: 'm7', offset: -32 })
    expect(readSessionScrollAnchor('s1')).toEqual({ messageId: 'm7', offset: -32 })
    expect(readSessionViewState('s1').scrollAnchor).toEqual({ messageId: 'm7', offset: -32 })
    // 没记过的那条答的是一份空的,不是 throw、也不是别人的记录。
    expect(readSessionScrollAnchor('s2')).toBeUndefined()
    expect(readSessionViewState('s2')).toEqual({})
  })

  it('两条会话各记各的 —— 记 B 不动 A', () => {
    saveSessionScrollAnchor('s1', { messageId: 'm1', offset: 0 })
    saveSessionScrollAnchor('s2', 'bottom')
    expect(readSessionScrollAnchor('s1')).toEqual({ messageId: 'm1', offset: 0 })
    expect(readSessionScrollAnchor('s2')).toBe('bottom')
  })

  it('量不出来(undefined)不当一次写:老实留着上一次的真读数', () => {
    saveSessionScrollAnchor('s1', { messageId: 'm3', offset: 12 })
    saveSessionScrollAnchor('s1', undefined)
    expect(readSessionScrollAnchor('s1')).toEqual({ messageId: 'm3', offset: 12 })
  })

  it('空串是一格合法的键(「还没绑会话」那一态),不是缺席', () => {
    saveSessionScrollAnchor('', 'bottom')
    expect(sessionViewStateKeys()).toContain('')
  })

  it('会话没了:那份记录一起清掉', () => {
    saveSessionScrollAnchor('s1', 'bottom')
    saveSessionScrollAnchor('s2', 'bottom')
    dropSessionViewState('s1')
    expect(sessionViewStateKeys()).toEqual(['s2'])

    forgetSessionViewStates(['s2', '压根没记过的一条'])
    expect(sessionViewStateKeys()).toEqual([])
  })

  it('整表重置清空(HMR 退役复用的就是这一口)', () => {
    saveSessionScrollAnchor('s1', 'bottom')
    resetSessionViewStates()
    expect(sessionViewStateKeys()).toEqual([])
  })
})

describe('锚点:量出来', () => {
  it('贴底优先 —— 在底就记 bottom,不记成「停在最后一条上」', () => {
    const el = stubContainer({
      scrollTop: 600,
      scrollHeight: 1000,
      clientHeight: 400,
      rows: [{ id: 'm9', contentTop: 700, height: 180 }],
    })
    expect(measureScrollAnchor(el)).toBe('bottom')
  })

  it('离底时取**视口里最上面那条还露着的**;整条翻过去的跳过', () => {
    const el = stubContainer({
      top: 100,
      scrollTop: 200,
      scrollHeight: 1000,
      clientHeight: 400,
      rows: [
        // 下缘正好落在容器上缘上,整条都在上面 —— 翻过去了。
        { id: 'm1', contentTop: 80, height: 120 },
        // 上缘在容器上缘之上、下缘还露着 —— 就是它,offset 为负。
        { id: 'm2', contentTop: 160, height: 180 },
        { id: 'm3', contentTop: 340, height: 160 },
      ],
    })
    expect(measureScrollAnchor(el)).toEqual({ messageId: 'm2', offset: -40 })
  })

  it('容器已经离场:答 undefined(那时读到的矩形全是 0,记下去就是说谎)', () => {
    const el = stubContainer({ scrollTop: 200, rows: [{ id: 'm1', contentTop: 160, height: 100 }] })
    el.remove()
    expect(measureScrollAnchor(el)).toBeUndefined()
  })

  it('离底但树上一条消息都没有:答 undefined', () => {
    const el = stubContainer({ scrollTop: 200 })
    expect(measureScrollAnchor(el)).toBeUndefined()
  })
})

describe('锚点:用回去', () => {
  it('bottom = 落底', () => {
    const el = stubContainer({ scrollTop: 0, scrollHeight: 1000 })
    expect(applyScrollAnchor(el, 'bottom')).toBe(true)
    expect(el.scrollTop).toBe(1000)
  })

  it('消息锚点:落到「那一条的上缘距容器上缘正好是 offset」的位置', () => {
    /*
     * m2 在内容里的位置是 160;要它的上缘离容器上缘 -40,
     * scrollTop 就该是 160 - (-40) = 200 —— 从别处(0)一步落过去。
     */
    const el = stubContainer({
      top: 100,
      scrollTop: 0,
      rows: [{ id: 'm2', contentTop: 160, height: 180 }],
    })
    expect(applyScrollAnchor(el, { messageId: 'm2', offset: -40 })).toBe(true)
    expect(el.scrollTop).toBe(200)
  })

  it('那条消息不在树上:如实回 false,一个像素都不动', () => {
    const el = stubContainer({ scrollTop: 123, rows: [{ id: 'm2', contentTop: 160, height: 180 }] })
    expect(applyScrollAnchor(el, { messageId: '被压缩折进去的那一条', offset: 0 })).toBe(false)
    expect(el.scrollTop).toBe(123)
  })

  it('量出来的锚点用回去是恒等(同一份排版,来回一趟不漂)', () => {
    const el = stubContainer({
      top: 100,
      scrollTop: 200,
      rows: [
        { id: 'm1', contentTop: 80, height: 120 },
        { id: 'm2', contentTop: 160, height: 180 },
      ],
    })
    const anchor = measureScrollAnchor(el)
    expect(anchor).toBeDefined()
    el.scrollTop = 0
    expect(applyScrollAnchor(el, anchor!)).toBe(true)
    expect(el.scrollTop).toBe(200)
  })
})

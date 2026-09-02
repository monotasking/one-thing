import { describe, expect, it } from 'vitest'
import { focusablesIn, tabStopWithin } from '../tab-trap'

/**
 * **模态圈禁的判据**(纯函数,零监听)。
 *
 * 这两只是从 `ui/a11y/focus-trap.ts` 搬过来的(R0 搬,R1 那只文件整个退役)。
 * 搬而不引的理由写在 `tab-trap.ts` 文件头:树里需要的只是**判据**——「按 Tab
 * 该停在哪」——由那一个派发器现问现答,不再多一个 document 监听。
 * 这一组是那只文件退役时它带走的用例,一条不少。
 */

describe('focusablesIn', () => {
  it('按文档序收可聚焦元素;disabled / aria-hidden 的不算', () => {
    /*
     * 用 `createElement` 造夹具而不是写一串 innerHTML:那种字符串会被
     * `ui:consume` 的裸钮规则当成手写按钮扫到(它按标签形状扫源文本)——
     * 与 `registry.test.ts` 里那条注释同一个理由。
     */
    const host = document.createElement('div')
    const make = (tag: string, id: string, attrs: Record<string, string> = {}) => {
      const el = document.createElement(tag)
      el.id = id
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
      return el
    }
    const hidden = make('span', 'wrap', { 'aria-hidden': 'true' })
    hidden.append(make('button', 'c'))
    host.append(
      make('button', 'a'),
      make('button', 'b', { disabled: '' }),
      hidden,
      make('a', 'd', { href: '#x' }),
      make('div', 'e', { tabindex: '-1' }),
      make('div', 'f', { tabindex: '0' }),
    )
    document.body.appendChild(host)
    expect(focusablesIn(host).map((el) => el.id)).toEqual(['a', 'd', 'f'])
    host.remove()
  })

  it('`[tabindex="-1"]` 不在表里 —— 它是「可编程聚焦、不进 Tab 序」', () => {
    const host = document.createElement('div')
    const box = document.createElement('div')
    box.tabIndex = -1
    host.append(box)
    document.body.appendChild(host)
    expect(focusablesIn(host)).toEqual([])
    host.remove()
  })
})

describe('tabStopWithin', () => {
  function panel(): { box: HTMLElement; items: HTMLButtonElement[] } {
    const box = document.createElement('div')
    box.tabIndex = -1
    const items = [0, 1, 2].map(() => document.createElement('button'))
    box.append(...items)
    document.body.append(box)
    return { box, items }
  }

  it('停在容器自己身上算「首项之前」:往前进首项,往后进末项', () => {
    const { box, items } = panel()
    expect(tabStopWithin(box, box, false)).toBe(items[0])
    expect(tabStopWithin(box, box, true)).toBe(items[2])
    box.remove()
  })

  it('末项之后回首项、首项之前回末项;中间那几步不归它管(交给浏览器)', () => {
    const { box, items } = panel()
    expect(tabStopWithin(box, items[2], false)).toBe(items[0])
    expect(tabStopWithin(box, items[0], true)).toBe(items[2])
    expect(tabStopWithin(box, items[1], false)).toBe(null)
    expect(tabStopWithin(box, items[1], true)).toBe(null)
    box.remove()
  })

  it('焦点跑到圈外面了:下一下 Tab 把它拽回来', () => {
    const { box, items } = panel()
    const outside = document.createElement('button')
    document.body.append(outside)
    expect(tabStopWithin(box, outside, false)).toBe(items[0])
    expect(tabStopWithin(box, outside, true)).toBe(items[2])
    outside.remove()
    box.remove()
  })

  it('一个可聚焦元素都没有的容器:原地不动,焦点留在容器上', () => {
    const box = document.createElement('div')
    box.tabIndex = -1
    box.append(document.createTextNode('只有一段说明文字'))
    document.body.append(box)
    expect(tabStopWithin(box, box, false)).toBe(box)
    expect(tabStopWithin(box, box, true)).toBe(box)
    box.remove()
  })
})

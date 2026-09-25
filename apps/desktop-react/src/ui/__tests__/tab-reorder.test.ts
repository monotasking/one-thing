import { afterEach, describe, expect, it } from 'vitest'
import { tabStripChoreo } from '../tab-reorder'

/**
 * **撕下的那一格展回来是瞬时的**(09-25)。
 *
 * `data-torn` 把原位折成 0 宽,带 120ms 的宽度过渡。reset 之后紧跟着的两个读者 ——
 * 拖回自己那条条时的 `lift()`、取消时 `settle()` 的 FLIP —— 都要**停稳之后**的位置;
 * 让它跑过渡的话,它们量到的是过渡中途,换序插入点与滑入终点都偏一截。
 *
 * jsdom 不排版,所以这里守的是那条「先关过渡、摘属性、强制一次排版、再把过渡还回去」
 * 的次序:排版那一刻(读 `offsetWidth`)过渡必须是关着的,而且属性已经摘了。
 */

afterEach(() => {
  document.body.innerHTML = ''
})

function strip(): { list: HTMLElement; tab: HTMLElement } {
  document.body.innerHTML = `
    <div role="tablist">
      <div role="tab" data-tab-id="a"></div>
      <div role="tab" data-tab-id="b"></div>
    </div>`
  const list = document.querySelector<HTMLElement>('[role="tablist"]')!
  const tab = document.querySelector<HTMLElement>('[data-tab-id="b"]')!
  return { list, tab }
}

describe('tabStripChoreo.reset', () => {
  it('撕下的那一格:摘掉 data-torn 时过渡是关着的,排完一次版再还回去', () => {
    const { list, tab } = strip()
    const choreo = tabStripChoreo(list)
    choreo.tear('b')
    expect(tab.dataset.torn).toBe('')

    const seen: { transition: string; torn: boolean }[] = []
    Object.defineProperty(tab, 'offsetWidth', {
      configurable: true,
      get() {
        seen.push({ transition: tab.style.transition, torn: 'torn' in tab.dataset })
        return 120
      },
    })
    choreo.reset()

    expect(seen).toEqual([{ transition: 'none', torn: false }])
    expect(tab.style.transition).toBe('')
    expect('torn' in tab.dataset).toBe(false)
  })

  it('没撕过就不碰任何一格的过渡', () => {
    const { list, tab } = strip()
    tab.style.transition = 'opacity 1s'
    tabStripChoreo(list).reset()
    expect(tab.style.transition).toBe('opacity 1s')
  })
})

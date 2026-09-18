import { afterEach, describe, expect, it } from 'vitest'
import { measureDropGeometry } from '../drop-geometry'
import type { StripBox } from '../drop'

/**
 * **屏幕上此刻有哪几块矩形**(`workbench/drop-geometry.ts`)。这一组只守一件事:
 * 一片叶的檐**画的是内容自带的头**时,它照样是一条能收东西的条(U1-fix,2026-09-18 用户报
 * 「待办窗没有 tab 了,拖不进 tab header」)。
 *
 * jsdom 里每个盒子都是 0×0,而量法拿零身量当「此刻不在屏幕上」—— 所以矩形逐个喂进去。
 */

function place(el: Element, rect: { left: number; top: number; width: number; height: number }): void {
  Object.assign(el, {
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => rect }),
  })
}

/** 一棵最小的树:一个区 → 一片叶的格 → 那片叶的檐。檐里装什么由调用方给。 */
function mount(chromeInner: string): void {
  document.body.innerHTML = `
    <div data-pane-region="float:todo">
      <div data-pane-slot="leaf-1">
        <div data-pane-chrome="leaf-1">${chromeInner}</div>
      </div>
    </div>`
  place(document.querySelector('[data-pane-slot]')!, { left: 300, top: 100, width: 600, height: 400 })
  place(document.querySelector('[data-pane-chrome]')!, { left: 300, top: 100, width: 600, height: 36 })
  for (const el of document.querySelectorAll('[role="tablist"], [data-strip-header]')) {
    place(el, { left: 300, top: 100, width: 560, height: 36 })
  }
  for (const el of document.querySelectorAll('[data-tab-id]')) {
    if (!el.hasAttribute('data-strip-header')) place(el, { left: 300, top: 100, width: 120, height: 36 })
  }
}

afterEach(() => { document.body.innerHTML = '' })

describe('一条檐收不收东西', () => {
  it('画标签的那一档:每一格各是一格,活动的那一格从 aria-selected 读', () => {
    mount(`<div role="tablist">
      <div data-tab-id="panel:a" aria-selected="false"></div>
      <div data-tab-id="panel:b" aria-selected="true"></div>
    </div>`)
    const strips = measureDropGeometry().strips ?? []
    const [strip] = strips
    expect(strip.leafId).toBe('leaf-1')
    expect(strip.tabs.map((tab) => tab.id)).toEqual(['panel:a', 'panel:b'])
    expect(strip.activeAt).toBe(1)
    expect(strip.header).toBeUndefined()
  })

  it('画自带头的那一档:头就是唯一那一格,而且它是活动的', () => {
    mount('<div data-strip-header="" data-tab-id="panel:todo"></div>')
    const strips: readonly StripBox[] = measureDropGeometry().strips ?? []
    expect(strips).toHaveLength(1)
    // `header: true` = 「这条条画的是自带的头」:预示改画一层薄膜(判词在 `useContentDrag`)。
    expect(strips[0]).toMatchObject({ leafId: 'leaf-1', activeAt: 0, header: true })
    expect(strips[0].tabs.map((tab) => tab.id)).toEqual(['panel:todo'])
    // 条的地就是那条头:拖到头上落得进这片叶(从前这里一条条都没有)。
    expect(strips[0].rect).toMatchObject({ left: 300, top: 100, width: 560 })
  })

  it('一格装了几份照旧从 `data-tab-slots` 读', () => {
    mount('<div data-strip-header="" data-tab-id="panel:todo" data-tab-slots="2"></div>')
    expect((measureDropGeometry().strips ?? [])[0].tabs[0].slots).toBe(2)
  })

  it('头没说自己是哪一格 → 不当条(宁可没有落点,也不落到一个说不出身份的格上)', () => {
    mount('<div data-strip-header=""></div>')
    expect(measureDropGeometry().strips ?? []).toHaveLength(0)
  })
})

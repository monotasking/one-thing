// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  isWindowDragExcludedTarget,
  shouldStartWindowDrag,
  windowDragOffset,
} from '../todo-window-drag'

/**
 * 手动拖窗只有两处会出错:**判据**(按钮被顺手拖走)和**位移**(漂移)。
 * 两处都是纯函数,所以两处都在这里钉住。
 */
function surface(html: string): HTMLElement {
  const host = document.createElement('div')
  host.className = 'mode-rail'
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

describe('todo window manual drag', () => {
  describe('interactive-target exclusion', () => {
    it('excludes buttons, inputs and contenteditable, plus anything inside them', () => {
      const host = surface(`
        <button class="rail-button"><span class="icon">i</span></button>
        <input class="find-input" />
        <div contenteditable="true"><span class="word">w</span></div>
        <div role="button"><span class="cap">c</span></div>
      `)

      for (const selector of ['.icon', '.find-input', '.word', '.cap']) {
        expect(isWindowDragExcludedTarget(host.querySelector(selector))).toBe(true)
      }
    })

    it('lets the empty parts of the rail and the header through', () => {
      const host = surface('<span class="rail-label">TODO</span><h1 class="window-title">草稿纸</h1>')

      expect(isWindowDragExcludedTarget(host)).toBe(false)
      expect(isWindowDragExcludedTarget(host.querySelector('.rail-label'))).toBe(false)
      expect(isWindowDragExcludedTarget(host.querySelector('.window-title'))).toBe(false)
    })

    it('honours the manual .no-window-drag opt-out', () => {
      const host = surface('<div class="no-window-drag"><span class="inner">x</span></div>')
      expect(isWindowDragExcludedTarget(host.querySelector('.inner'))).toBe(true)
    })

    it('treats a missing target as draggable rather than throwing', () => {
      expect(isWindowDragExcludedTarget(null)).toBe(false)
      expect(isWindowDragExcludedTarget(undefined)).toBe(false)
    })
  })

  describe('drag start gate', () => {
    const plain = () => surface('<span class="rail-label">TODO</span>').querySelector('.rail-label')

    it('starts on the primary button over an empty surface', () => {
      expect(shouldStartWindowDrag({ button: 0, target: plain(), screenX: 0, screenY: 0 })).toBe(true)
    })

    it('never starts on the secondary / middle button', () => {
      expect(shouldStartWindowDrag({ button: 2, target: plain(), screenX: 0, screenY: 0 })).toBe(false)
      expect(shouldStartWindowDrag({ button: 1, target: plain(), screenX: 0, screenY: 0 })).toBe(false)
    })

    it('never starts on ctrl + primary — that is the macOS context menu', () => {
      expect(shouldStartWindowDrag({ button: 0, ctrlKey: true, target: plain(), screenX: 0, screenY: 0 }))
        .toBe(false)
    })

    it('never starts on a control', () => {
      const host = surface('<button class="rail-button"><span class="icon">i</span></button>')
      expect(shouldStartWindowDrag({
        button: 0,
        target: host.querySelector('.icon'),
        screenX: 0,
        screenY: 0,
      })).toBe(false)
    })
  })

  describe('offset', () => {
    it('measures from the press point, not from the previous frame', () => {
      const origin = { screenX: 800, screenY: 400 }
      expect(windowDragOffset(origin, { screenX: 812, screenY: 388 })).toEqual({ dx: 12, dy: -12 })
      // 第二帧仍然相对**同一个**起点 —— 累计量,不是帧间增量。
      expect(windowDragOffset(origin, { screenX: 830, screenY: 400 })).toEqual({ dx: 30, dy: 0 })
    })

    it('keeps negative screen coordinates intact (display to the left of the main one)', () => {
      expect(windowDragOffset({ screenX: -100, screenY: -50 }, { screenX: -400, screenY: -10 }))
        .toEqual({ dx: -300, dy: 40 })
    })
  })
})

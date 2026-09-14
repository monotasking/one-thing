import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installWindowFocusSource,
  reportWindowBlur,
  resetWindowFocus,
  subscribeWindowBlur,
  windowFocusSource,
} from '../window-focus'

/**
 * **「窗口失焦」只有一个产地**(2026-09-15;病历整段在 `focus/window-focus.ts` 头上)。
 *
 * 反证:把 `onDomBlur` 里那句 `if (source === 'dom')` 挖掉 → 「宿主接管」那条红
 * (DOM blur 又算数了,正是浏览器 tab 拖不出来的病);把 `installWindowFocusSource`
 * 的归还挖掉 → 「归还」那条红。
 */
afterEach(() => resetWindowFocus())

describe('focus/window-focus', () => {
  it('没有宿主源:DOM blur 就是窗口 blur', () => {
    const fn = vi.fn()
    subscribeWindowBlur(fn)
    expect(windowFocusSource()).toBe('dom')
    window.dispatchEvent(new Event('blur'))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('宿主接管:DOM blur 不算,只有宿主报的那一发算', () => {
    const fn = vi.fn()
    subscribeWindowBlur(fn)
    const restore = installWindowFocusSource()
    expect(windowFocusSource()).toBe('host')
    window.dispatchEvent(new Event('blur'))
    expect(fn).not.toHaveBeenCalled()
    reportWindowBlur()
    expect(fn).toHaveBeenCalledTimes(1)
    restore()
  })

  it('归还之后 DOM blur 又算数;归还幂等', () => {
    const fn = vi.fn()
    subscribeWindowBlur(fn)
    const restore = installWindowFocusSource()
    restore()
    restore()
    expect(windowFocusSource()).toBe('dom')
    window.dispatchEvent(new Event('blur'))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('退订之后不再收到;reset 把一切清干净', () => {
    const fn = vi.fn()
    const off = subscribeWindowBlur(fn)
    off()
    window.dispatchEvent(new Event('blur'))
    expect(fn).not.toHaveBeenCalled()
    subscribeWindowBlur(fn)
    resetWindowFocus()
    window.dispatchEvent(new Event('blur'))
    expect(fn).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureBrowserPort } from '../../../data/browser-port'
import { resetWindowFocus, subscribeWindowBlur, windowFocusSource } from '../../../focus/window-focus'
import { startWindowFocusDownlink } from '../window-focus-downlink'
import type { BrowserPort, NativeViewPush } from '../../../data/browser-port'

/**
 * **桌面上「窗口失焦」由主进程推**(2026-09-15;病历在 `focus/window-focus.ts`)。
 * 反证:把 `startWindowFocusDownlink` 里那句 `installWindowFocusSource()` 挖掉 →
 * 第一条红(DOM blur 又算数了)。
 */
function installBridge(): (message: NativeViewPush) => void {
  let handler: ((message: NativeViewPush) => void) | undefined
  const port: BrowserPort = {
    ready: () => Promise.resolve(undefined),
    read: () => Promise.resolve({ kind: 'ok', value: {} }),
    do: () => Promise.resolve({ kind: 'ok', text: '' }),
    onResourceEvent: () => () => undefined,
    nativeView: {
      send: () => {},
      on: (next) => {
        handler = next
        return () => {
          handler = undefined
        }
      },
    },
  }
  configureBrowserPort(port)
  return (message) => handler?.(message)
}

afterEach(() => {
  configureBrowserPort(undefined)
  resetWindowFocus()
})

describe('window-focus-downlink', () => {
  it('有桥:DOM blur 不算,主进程推 window-blur 才算;拆卸后归还 DOM 源', () => {
    const push = installBridge()
    const fn = vi.fn()
    subscribeWindowBlur(fn)
    const off = startWindowFocusDownlink()
    expect(windowFocusSource()).toBe('host')
    window.dispatchEvent(new Event('blur'))
    expect(fn).not.toHaveBeenCalled()
    push({ kind: 'blur', viewId: 'v1' })
    expect(fn).not.toHaveBeenCalled()
    push({ kind: 'window-blur' })
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    expect(windowFocusSource()).toBe('dom')
  })

  it('没有桥(web 壳):什么都不装,DOM blur 照旧', () => {
    const fn = vi.fn()
    subscribeWindowBlur(fn)
    const off = startWindowFocusDownlink()
    expect(windowFocusSource()).toBe('dom')
    window.dispatchEvent(new Event('blur'))
    expect(fn).toHaveBeenCalledTimes(1)
    off()
  })
})

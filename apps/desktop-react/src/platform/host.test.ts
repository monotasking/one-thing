import { afterEach, describe, expect, it, vi } from 'vitest'
import { onSystemThemeChanged, systemTheme } from './host'

/**
 * 宿主能力(C1)—— 只有一格:系统明暗。
 *
 * 验的是**行为逐字照搬**:同一个媒体查询、同一个「读不到就当 dark」的兜底、
 * 同一个「没有 matchMedia 就交一颗 noop 退订」。这三条是从 Vue 渲染层那份 web
 * 实现搬过来的,搬家不许顺手改语义。
 */

type Listener = () => void

interface FakeMedia {
  matches: boolean
  listeners: Set<Listener>
}

function installMatchMedia(prefersLight: boolean): Map<string, FakeMedia> {
  const table = new Map<string, FakeMedia>()
  const impl = (query: string): unknown => {
    let media = table.get(query)
    if (!media) {
      media = {
        matches: query.includes('light') ? prefersLight : !prefersLight,
        listeners: new Set(),
      }
      table.set(query, media)
    }
    const current = media
    return {
      get matches() {
        return current.matches
      },
      addEventListener: (_: string, listener: Listener) => current.listeners.add(listener),
      removeEventListener: (_: string, listener: Listener) => current.listeners.delete(listener),
    }
  }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: impl,
  })
  return table
}

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia')
  vi.restoreAllMocks()
})

describe('platform/host:系统明暗', () => {
  it('问的是 light —— 匹配即 light', () => {
    installMatchMedia(true)
    expect(systemTheme()).toBe('light')
  })

  it('不匹配 light 就是 dark', () => {
    installMatchMedia(false)
    expect(systemTheme()).toBe('dark')
  })

  it('没有 matchMedia 时当 dark ——「读不到」与「用户选了浅色」是两件事', () => {
    Reflect.deleteProperty(window, 'matchMedia')
    expect(systemTheme()).toBe('dark')
  })

  it('订阅挂在 dark 那条查询上,响的时候交出去的是 systemTheme() 的读数', () => {
    const table = installMatchMedia(false)
    const seen: string[] = []
    const off = onSystemThemeChanged(theme => seen.push(theme))

    const dark = table.get('(prefers-color-scheme: dark)')
    expect(dark).toBeDefined()
    dark?.listeners.forEach(listener => listener())
    expect(seen).toEqual(['dark'])

    // 系统换到浅色:同一条监听,读数跟着 light 那条查询走。
    const light = table.get('(prefers-color-scheme: light)')
    if (light) light.matches = true
    dark?.listeners.forEach(listener => listener())
    expect(seen).toEqual(['dark', 'light'])

    off()
    expect(dark?.listeners.size).toBe(0)
  })

  it('没有 matchMedia 时交一颗 noop 退订 —— 订不上就是订不上,不假装', () => {
    Reflect.deleteProperty(window, 'matchMedia')
    const off = onSystemThemeChanged(() => {
      throw new Error('不该响')
    })
    expect(() => off()).not.toThrow()
  })
})

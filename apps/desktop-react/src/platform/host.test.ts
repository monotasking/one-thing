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

/*
 * 第二格(第④步批 1,决策 D278 / D280):只在用户屏幕上发生的事。判据只有一句 —— preload 上有没有
 * `clientAction`;没有它的客户端(浏览器壳)答结构化的「做不了」,不抛、不静默。
 */
describe('client actions', () => {
  const win = window as unknown as { onethingHost?: unknown }
  afterEach(() => {
    delete win.onethingHost
  })

  it('浏览器壳(没有 clientAction):canRunClientActions 答 false,打开 / 定位答 unsupported,对话框答 unavailable', async () => {
    const { canRunClientActions, openLocalPath, revealLocalPath, showNativeOpenDialog } = await import('./host')
    expect(canRunClientActions()).toBe(false)
    await expect(openLocalPath('/a')).resolves.toEqual({ ok: false, reason: 'unsupported' })
    await expect(revealLocalPath('/a')).resolves.toEqual({ ok: false, reason: 'unsupported' })
    await expect(showNativeOpenDialog({ properties: ['openDirectory'] })).resolves.toEqual({ canceled: true, filePaths: [], unavailable: true })
  })

  it('桌面(有 clientAction):动作原样交给宿主,结局照答', async () => {
    const seen: unknown[] = []
    win.onethingHost = {
      clientAction: async (action: { kind: string }) => {
        seen.push(action)
        if (action.kind === 'showOpenDialog') return { canceled: false, filePaths: ['/picked'] }
        if (action.kind === 'openPath') return { ok: false, error: 'no app' }
        return { ok: true }
      },
    }
    const { canRunClientActions, openLocalPath, revealLocalPath, showNativeOpenDialog } = await import('./host')
    expect(canRunClientActions()).toBe(true)
    await expect(revealLocalPath('/a')).resolves.toEqual({ ok: true })
    await expect(openLocalPath('/b')).resolves.toEqual({ ok: false, reason: 'failed', error: 'no app' })
    await expect(showNativeOpenDialog({ title: 't' })).resolves.toEqual({ canceled: false, filePaths: ['/picked'] })
    expect(seen).toEqual([
      { kind: 'revealPath', path: '/a' },
      { kind: 'openPath', path: '/b' },
      { kind: 'showOpenDialog', request: { title: 't' } },
    ])
  })
})

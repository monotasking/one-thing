/**
 * 后台标签页释放。
 *  - service / tab:释放后网页进程关闭,标签页保留;再次可见时按原地址重新加载,
 *    不再发送「标签页已打开」事件;
 *  - layout:只在标签页隐藏时计时,被浮层遮挡不算隐藏;
 *  - holder:隐藏足够久、没有播放声音、网页已加载,三个条件都满足才释放。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserSessionPolicy } from '../session-policy.js'
import { BrowserService } from '../service.js'
import { NativeViewLayout } from '../layout.js'
import { BROWSER_HIBERNATE_AFTER_MS, createBrowserMemoryHolder, type HibernatableTab } from '../memory-holder.js'

describe('BrowserService.hibernate', () => {
  let store: string
  beforeEach(() => { store = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-hibernate-')) })
  afterEach(() => { fs.rmSync(store, { recursive: true, force: true }) })

  function build() {
    const loads: string[] = []
    const closed: number[] = []
    const listeners: Array<Map<string, (...args: unknown[]) => void>> = []
    const observer = {
      onOpened: vi.fn(), onClosed: vi.fn(), onNavigated: vi.fn(), onLoading: vi.fn(),
      onMaterialized: vi.fn(), onDematerialized: vi.fn(), onFind: vi.fn(), onSpawned: vi.fn(), onSpawnBlocked: vi.fn(),
    }
    const service = new BrowserService({
      sessionPolicy: new BrowserSessionPolicy(() => ({
        getUserAgent: () => 'X', setUserAgent: () => {},
        setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {},
        clearStorageData: () => Promise.resolve(),
      })),
      tabsPath: path.join(store, 'tabs.json'),
      persistDelayMs: 0,
      createView: () => {
        const index = listeners.length
        const on = new Map<string, (...args: unknown[]) => void>()
        listeners.push(on)
        let destroyed = false
        return {
          webContents: {
            on: (event: string, listener: (...args: unknown[]) => void) => { on.set(event, listener) },
            setWindowOpenHandler: () => {},
            loadURL: async (url: string) => { loads.push(url) },
            reload: () => {}, stop: () => {}, focus: () => {},
            close: () => { destroyed = true; closed.push(index) },
            isDestroyed: () => destroyed,
            executeJavaScript: async () => '',
            capturePage: async () => ({ isEmpty: () => true, toDataURL: () => '' }),
            isCurrentlyAudible: () => false,
            navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: () => {}, goForward: () => {} },
          },
          setBounds: () => {}, setVisible: () => {},
        } as never
      },
      observer,
    })
    return { service, observer, loads, closed, listeners }
  }

  it('releases the process, keeps the tab, and reloads the same address when it becomes visible again', async () => {
    const { service, observer, loads, closed } = build()
    const tab = service.open({ url: 'https://a.test' })
    await vi.waitFor(() => expect(loads).toEqual(['https://a.test']))

    expect(service.hibernate(tab.id)).toBe(true)
    expect(closed).toEqual([0])
    expect(observer.onDematerialized).toHaveBeenCalledWith(tab.id)
    expect(service.get(tab.id)!.materialized).toBe(false)
    expect(service.list().map(row => row.id)).toEqual([tab.id])
    expect(service.get(tab.id)!.state.url).toBe('https://a.test')
    expect(service.get(tab.id)!.state.canGoBack).toBe(false)
    // 标签页已释放时再次释放:不做任何操作。
    expect(service.hibernate(tab.id)).toBe(false)

    service.materialize(tab.id)
    await vi.waitFor(() => expect(loads).toEqual(['https://a.test', 'https://a.test']))
    // 视图重新创建时会再次触发 onMaterialized,但「标签页已打开」只发送一次。
    expect(observer.onMaterialized).toHaveBeenCalledTimes(2)
    expect(observer.onOpened).toHaveBeenCalledTimes(1)
    expect(service.get(tab.id)!.hibernationCount).toBe(1)
  })

  it('ignores late events from the released process', async () => {
    const { service, listeners } = build()
    const tab = service.open({ url: 'https://a.test' })
    service.hibernate(tab.id)
    listeners[0].get('page-title-updated')?.({}, 'ghost title')
    listeners[0].get('render-process-gone')?.()
    expect(service.get(tab.id)!.state.title).not.toBe('ghost title')
    expect(service.get(tab.id)!.state.error).toBeUndefined()
  })
})

describe('NativeViewLayout.hiddenForMs', () => {
  function view() {
    return { setBounds: () => {}, setVisible: () => {}, webContents: { isDestroyed: () => false, capturePage: async () => ({ isEmpty: () => true, toDataURL: () => '' }) } }
  }
  const host = { addChildView: () => {}, removeChildView: () => {} }
  const bounds = { x: 0, y: 0, width: 10, height: 10 }

  it('counts only while the shell says hidden; occluded still counts as seen', async () => {
    let now = 1000
    const layout = new NativeViewLayout(host as never, () => {}, () => now)
    layout.register('a', view() as never)
    now = 1500
    expect(layout.hiddenForMs('a')).toBe(500)
    layout.applyFrame({ viewId: 'a', bounds, visible: true, z: 0 })
    expect(layout.hiddenForMs('a')).toBeUndefined()
    await layout.occlude('a')
    expect(layout.hiddenForMs('a')).toBeUndefined()
    layout.unocclude('a')
    now = 2000
    layout.applyFrame({ viewId: 'a', bounds, visible: false, z: 0 })
    now = 2600
    expect(layout.hiddenForMs('a')).toBe(600)
    expect(layout.hiddenForMs('never-registered')).toBeUndefined()
  })
})

describe('browser memory holder', () => {
  function tab(id: string, over: Partial<HibernatableTab> = {}): HibernatableTab {
    return { id, materialized: true, audible: false, hibernationCount: 0, ...over }
  }

  it('releases only hidden-long-enough, silent, live tabs — soft waits longer than hard', () => {
    const hidden: Record<string, number | undefined> = {
      visible: undefined,
      recent: 2 * 60_000,
      old: 20 * 60_000,
      playing: 20 * 60_000,
      lazy: 20 * 60_000,
    }
    const tabs = [tab('visible'), tab('recent'), tab('old'), tab('playing', { audible: true }), tab('lazy', { materialized: false })]
    const hibernate = vi.fn((_tabId: string) => true)
    const holder = createBrowserMemoryHolder({ tabs: () => tabs, hiddenForMs: id => hidden[id], hibernate })

    expect(holder.usage()).toMatchObject({ entries: 4, unit: 'views', detail: { tabs: 5, hidden: 3, audible: 1 } })
    expect(holder.trim!('soft')).toEqual({ releasedEntries: 1 })
    expect(hibernate.mock.calls.map(call => call[0])).toEqual(['old'])
    hibernate.mockClear()
    expect(holder.trim!('hard')).toEqual({ releasedEntries: 2 })
    expect(hibernate.mock.calls.map(call => call[0])).toEqual(['recent', 'old'])
    expect(BROWSER_HIBERNATE_AFTER_MS.soft).toBeGreaterThan(BROWSER_HIBERNATE_AFTER_MS.hard)
  })
})

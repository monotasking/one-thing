/**
 * **页面自己开出来的那一格**(2026-09-12 真机报障的修法;`window.open` /
 * `target=_blank` / ⌘-click)。
 *
 * 报障的读数:在搜索结果页点一条 `target=_blank` 的链接 → 主进程照
 * `decideWindowOpen` 建了一格 tab、视图 materialize 了、页面真的在跑 —— 而屏幕上
 * 一片叶都没有(用户账本 16 格 tab 里 14 格 YouTube,活动那格是一段正在放的视频)。
 * 「点了没反应」「页面跑到不知道哪儿去了」「关不掉」是同一件事的三种说法。
 *
 * 这份用例钉的是主进程那一半:**这一格出生的那一刻就说得出「它是谁开的」**
 * (`onSpawned` → `spawned` 事实)。壳那一半在
 * `src/data/__tests__/browser-spawn.test.ts`,真机那一半在 `gate:browser` ⑲。
 *
 * 一条 `import … from 'electron'` 都没有(与同目录别的用例同一条结构判据)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResourceEventHub } from '@onething/core/resource'
import { BrowserSessionPolicy } from '../session-policy.js'
import { BrowserService, SPAWN_BURST, SPAWN_WINDOW_MS } from '../service.js'
import { BrowserResourceProvider, type BrowserOps, type BrowserTabView } from '../resource-provider.js'
import { browserResourceSpec } from '../resource-spec.js'

describe('页面开出来的 tab:出生那一刻就说得出「谁开的」', () => {
  let store: string
  let tabsPath: string
  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-spawn-'))
    tabsPath = path.join(store, 'browser', 'tabs.json')
  })
  afterEach(() => { fs.rmSync(store, { recursive: true, force: true }) })

  /** 视图工厂把 `setWindowOpenHandler` 收下来 —— 于是「页面开一扇窗」这一下调得动。 */
  function build() {
    const openers: ((details: { url: string; disposition?: string }) => unknown)[] = []
    const observer = {
      onOpened: vi.fn(), onClosed: vi.fn(), onNavigated: vi.fn(), onLoading: vi.fn(),
      onMaterialized: vi.fn(), onDematerialized: vi.fn(), onFind: vi.fn(), onSpawned: vi.fn(), onSpawnBlocked: vi.fn(),
    }
    const sessionPolicy = new BrowserSessionPolicy(() => ({
      getUserAgent: () => 'X Electron/1 Y', setUserAgent: () => {},
      setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {},
      clearStorageData: () => Promise.resolve(),
    }))
    const service = new BrowserService({
      sessionPolicy,
      tabsPath,
      persistDelayMs: 0,
      createView: () => ({
        webContents: {
          on: () => {},
          setWindowOpenHandler: (handler: (d: { url: string; disposition?: string }) => unknown) => {
            openers.push(handler)
          },
          loadURL: async () => {}, reload: () => {}, stop: () => {}, focus: () => {}, close: () => {},
          isDestroyed: () => false, executeJavaScript: async () => '',
          capturePage: async () => ({ isEmpty: () => true, toDataURL: () => '' }),
          findInPage: () => 1, stopFindInPage: () => {},
          navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} },
        },
        setBounds: () => {}, setVisible: () => {},
      }) as never,
      observer,
    })
    return { service, observer, openers }
  }

  it('前台开:表里多一格,而且 `onSpawned` 带着开它的那一格', () => {
    const { service, observer, openers } = build()
    const opener = service.open({ url: 'https://search.test/q' })
    expect(openers).toHaveLength(1)

    openers[0]({ url: 'https://video.test/watch', disposition: 'foreground-tab' })

    expect(service.list()).toHaveLength(2)
    expect(observer.onSpawned).toHaveBeenCalledTimes(1)
    const [state, openerId] = observer.onSpawned.mock.calls[0]
    expect(openerId).toBe(opener.id)
    expect(state.url).toBe('https://video.test/watch')
    // 前台那一格就是活动那一格(「前台」的定义),身份跟着开它的那一格走。
    expect(service.activeId).toBe(state.id)
    expect(state.profile).toBe(opener.profile)
  })

  it('**后台开(⌘-click)照样说**——它不 materialize,靠 `onOpened` 永远等不到它', () => {
    const { service, observer, openers } = build()
    const opener = service.open({ url: 'https://search.test/q' })
    observer.onOpened.mockClear()

    openers[0]({ url: 'https://video.test/watch', disposition: 'background-tab' })

    expect(observer.onSpawned).toHaveBeenCalledTimes(1)
    // 视图没建 = 没有 `opened`;报障那条路正是从这里漏出去的。
    expect(observer.onOpened).not.toHaveBeenCalled()
    expect(service.activeId).toBe(opener.id)
  })

  it('拒掉的那一族(非 http(s))不建 tab,也不发这条事实', () => {
    const { service, observer, openers } = build()
    service.open({ url: 'https://search.test/q' })
    openers[0]({ url: 'file:///etc/passwd' })
    openers[0]({ url: 'mailto:a@b.c' })
    expect(service.list()).toHaveLength(1)
    expect(observer.onSpawned).not.toHaveBeenCalled()
  })

  it('provider 发的载荷逐格对着自述(`background` 由 `active` 推出来)', () => {
    const hub = new ResourceEventHub()
    const seen: { event: string; payload: unknown }[] = []
    hub.watch('browser:', (fact) => { seen.push({ event: fact.event, payload: fact.payload }) })
    const ops = { list: () => [], activeId: () => null, has: () => true } as unknown as BrowserOps
    const provider = new BrowserResourceProvider(ops)
    provider.attach(hub)

    const tab = { id: 't2', url: 'https://video.test/watch', title: '', loading: false, canGoBack: false, canGoForward: false, profile: 'default', active: true } as BrowserTabView
    provider.emitSpawned(tab, 't1')
    provider.emitSpawned({ ...tab, id: 't3', active: false }, 't1')

    provider.emitSpawnBlocked('t1', 'https://evil.test/9')
    expect(seen.map((s) => s.event)).toEqual(['spawned', 'spawned', 'spawnBlocked'])
    // **发在 opener 的地址上** —— 被拦的那一格根本没出生。
    expect(seen[2].payload).toEqual({ openerId: 't1', url: 'https://evil.test/9' })
    expect(seen[0].payload).toEqual({ id: 't2', url: 'https://video.test/watch', openerId: 't1', background: false })
    expect(seen[1].payload).toEqual({ id: 't3', url: 'https://video.test/watch', openerId: 't1', background: true })
  })

  /*
   * **配额**(判词在 `service.ts` 的 `SPAWN_BURST` 上)。假时钟:这一格的真实现
   * 就是 `Date.now()` 的滑动窗,不值得为它注入一个时钟端口。
   */
  it('同一页连开:第 4 发被拒,而且拒的那一下**说得出口**', () => {
    vi.useFakeTimers()
    try {
      const { service, observer, openers } = build()
      service.open({ url: 'https://evil.test/loop' })
      for (let i = 0; i < 5; i += 1) openers[0]({ url: `https://evil.test/${i}` })
      // 1 格 opener + 3 格准开 = 4;第 4、5 发被拦。
      expect(service.list()).toHaveLength(1 + SPAWN_BURST)
      expect(observer.onSpawned).toHaveBeenCalledTimes(SPAWN_BURST)
      expect(observer.onSpawnBlocked).toHaveBeenCalledTimes(2)
      expect(observer.onSpawnBlocked.mock.calls[0][1]).toBe('https://evil.test/3')
    } finally {
      vi.useRealTimers()
    }
  })

  it('窗口过去了就放行 —— 它是速率闸,不是总量闸', () => {
    vi.useFakeTimers()
    try {
      const { service, observer, openers } = build()
      service.open({ url: 'https://ok.test/' })
      for (let i = 0; i < 4; i += 1) openers[0]({ url: `https://ok.test/${i}` })
      expect(observer.onSpawnBlocked).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(SPAWN_WINDOW_MS + 1)
      openers[0]({ url: 'https://ok.test/later' })
      expect(observer.onSpawnBlocked).toHaveBeenCalledTimes(1)
      expect(observer.onSpawned).toHaveBeenCalledTimes(SPAWN_BURST + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('自述里有这两条,而且各自那几格都必填', () => {
    const spec = browserResourceSpec.events?.spawned
    expect(spec).toBeDefined()
    expect((spec?.payload as { required?: string[] }).required?.sort())
      .toEqual(['background', 'id', 'openerId', 'url'])
    const blocked = browserResourceSpec.events?.spawnBlocked
    expect(blocked).toBeDefined()
    expect((blocked?.payload as { required?: string[] }).required?.sort())
      .toEqual(['openerId', 'url'])
  })
})

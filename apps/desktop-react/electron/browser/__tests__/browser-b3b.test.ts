/**
 * B3-b 主进程半边的单元用例:**身份(profile)**。
 *
 * 与 B1-a / B3-a 那两份逐字同一条结构判据:**一条 `import … from 'electron'`
 * 都没有**。分区工厂、视图工厂、单槽广播器全是结构化端口,喂的是记调用的替身。
 *
 * 三件被钉死的事(每一件都配一条反证,写在它自己的注里):
 *  ① `profile` → 分区名,而且 `webPreferencesFor` 拿的是那一格的 session;
 *  ② `open` **不点名身份时取缺省**,而缺省是**现问**的(改设置不必重启);
 *  ③ 删一格身份的两步**次序**:先关 tab,再清分区。
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings } from '@shared/ipc/settings'
import type {
  SettingsEvent,
  SettingsEventBroadcaster,
} from '@onething/backend/wiring/settings/events.js'

import {
  BrowserSessionPolicy,
  browserPartitionFor,
  type BrowserSessionLike,
} from '../session-policy.js'
import { BrowserService } from '../service.js'
import {
  BrowserProfileReconciler,
  installBrowserProfilesWatcher,
  profileTableFromSettings,
} from '../profiles.js'
import { browserResourceSpec } from '../resource-spec.js'
import { BrowserResourceProvider, type BrowserOps, type BrowserTabView } from '../resource-provider.js'

/* ── 替身 ──────────────────────────────────────────────────────────────── */

function fakeSession() {
  return {
    ua: 'X Electron/41.1.1 Safari/537.36',
    cleared: 0,
    getUserAgent(): string { return this.ua },
    setUserAgent(next: string) { this.ua = next },
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    clearStorageData(): Promise<void> { this.cleared += 1; return Promise.resolve() },
  }
}

function fakeView() {
  return {
    webContents: {
      on: () => {}, setWindowOpenHandler: () => {}, loadURL: async () => {},
      reload: () => {}, stop: () => {}, focus: () => {}, close: () => {},
      isDestroyed: () => false, executeJavaScript: async () => '',
      capturePage: async () => ({ isEmpty: () => true, toDataURL: () => '' }),
      findInPage: () => 0, stopFindInPage: () => {},
      navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} },
    },
    setBounds: () => {}, setVisible: () => {},
  }
}

function settingsWith(browser: Partial<NonNullable<AppSettings['browser']>>): Pick<AppSettings, 'browser'> {
  return {
    browser: {
      cdp: { enabled: false, port: 9333 },
      profiles: [{ id: 'default', name: '' }],
      defaultProfile: 'default',
      searchEngine: 'google',
      ...browser,
    } as NonNullable<AppSettings['browser']>,
  }
}

/* ── ① 分区 ───────────────────────────────────────────────────────────── */

describe('身份 → 分区', () => {
  it('每格身份一个持久分区,而且 webPreferences 拿的是那一格的 session', () => {
    const made: string[] = []
    const byPartition = new Map<string, ReturnType<typeof fakeSession>>()
    const policy = new BrowserSessionPolicy((partition) => {
      made.push(partition)
      const session = fakeSession()
      byPartition.set(partition, session)
      return session
    })

    const a = policy.webPreferencesFor('default')
    const b = policy.webPreferencesFor('work')

    expect(made).toEqual(['persist:browser-default', 'persist:browser-work'])
    expect(browserPartitionFor('work')).toBe('persist:browser-work')
    // 两格身份拿到的是**两个**session —— 同一个就是同一套 cookie,身份根本没隔开。
    expect(a.session).not.toBe(b.session)
    expect(a.session).toBe(byPartition.get('persist:browser-default'))
    expect(b.session).toBe(byPartition.get('persist:browser-work'))
  })

  it('清一格分区**不把它从表里摘掉**(摘了下一次会把 UA / 权限 / 下载监听再挂一遍)', async () => {
    const made: string[] = []
    const one = fakeSession()
    const policy = new BrowserSessionPolicy((partition) => { made.push(partition); return one })
    policy.sessionFor('work')
    await policy.clear('work')
    policy.sessionFor('work')
    expect(made).toEqual(['persist:browser-work'])
    expect(one.cleared).toBe(1)
  })

  it('没建过的分区也清得着(上一次启动建过,盘上就可能有它的数据)', async () => {
    const one = fakeSession()
    const policy = new BrowserSessionPolicy(() => one)
    await policy.clear('never-used')
    expect(one.cleared).toBe(1)
  })
})

/* ── ② open 的缺省身份 ────────────────────────────────────────────────── */

describe('open 的缺省身份', () => {
  function build(defaultProfile: () => string) {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-b3b-'))
    const service = new BrowserService({
      sessionPolicy: new BrowserSessionPolicy(() => fakeSession()),
      tabsPath: path.join(store, 'browser', 'tabs.json'),
      persistDelayMs: 0,
      defaultProfile,
      createView: () => fakeView() as never,
      observer: {
        onOpened: vi.fn(), onClosed: vi.fn(), onNavigated: vi.fn(), onLoading: vi.fn(),
        onMaterialized: vi.fn(), onDematerialized: vi.fn(), onFind: vi.fn(), onSpawned: vi.fn(), onSpawnBlocked: vi.fn(),
      },
    })
    return { service, cleanup: () => fs.rmSync(store, { recursive: true, force: true }) }
  }

  /**
   * **反证**:把 `service.open` 里那一句 `?? this.options.defaultProfile?.()` 拆掉
   * (直接落 `DEFAULT_BROWSER_PROFILE`)→ 这一条当场红。
   */
  it('不点名 → 取缺省;点名 → 用点名的那一格', () => {
    const { service, cleanup } = build(() => 'work')
    try {
      expect(service.open().profile).toBe('work')
      expect(service.open({ profile: 'personal' }).profile).toBe('personal')
    } finally { cleanup() }
  })

  it('缺省是**现问**的:设置里改完,下一格新 tab 就跟着变(不必重启)', () => {
    let current = 'default'
    const { service, cleanup } = build(() => current)
    try {
      expect(service.open().profile).toBe('default')
      current = 'work'
      expect(service.open().profile).toBe('work')
    } finally { cleanup() }
  })

  it('`open` 那条做法的自述里有 profile,而且它到得了 ops', async () => {
    const openParams = browserResourceSpec.ops.open?.params.properties as
      | Record<string, unknown>
      | undefined
    expect(openParams?.profile).toBeTruthy()

    const opened: unknown[] = []
    const tab: BrowserTabView = {
      id: 't1', url: '', title: '', loading: false, canGoBack: false, canGoForward: false,
      active: true, profile: 'work',
    }
    const ops = {
      list: () => [tab], activeId: () => 't1',
      open: (init: unknown) => { opened.push(init); return tab },
      navigate: () => {}, back: () => {}, forward: () => {}, reload: () => {},
      activate: () => {}, close: () => {}, has: () => true,
      readText: async () => '', capture: async () => undefined, get: () => tab,
      respondPermission: () => true,
    } as unknown as BrowserOps
    const provider = new BrowserResourceProvider(ops)
    const ctx = { principal: { kind: 'user' } } as never
    const intent = await provider.plan('open', null, { url: 'https://a.test/', profile: 'work' }, ctx)
    await provider.apply('open', intent, { emit: () => {} } as never)
    expect(opened).toEqual([{ url: 'https://a.test/', background: false, profile: 'work' }])
  })

  /**
   * **不点名就是不点名**:provider **不**在自己这一层回落成 `default` ——
   * 回落那一格事实住在 service(它现问设置)。两处都回落 = 同一句话两个产地,
   * 而其中一个赶不上用户刚改过的设置。
   */
  it('不点名时 payload 里根本没有 profile 这一格(回落归 service)', async () => {
    const opened: Array<Record<string, unknown>> = []
    const tab: BrowserTabView = {
      id: 't1', url: '', title: '', loading: false, canGoBack: false, canGoForward: false,
      active: true, profile: 'default',
    }
    const ops = {
      list: () => [tab], activeId: () => 't1',
      open: (init: Record<string, unknown>) => { opened.push(init); return tab },
      navigate: () => {}, back: () => {}, forward: () => {}, reload: () => {},
      activate: () => {}, close: () => {}, has: () => true,
      readText: async () => '', capture: async () => undefined, get: () => tab,
      respondPermission: () => true,
    } as unknown as BrowserOps
    const provider = new BrowserResourceProvider(ops)
    const ctx = { principal: { kind: 'user' } } as never
    const intent = await provider.plan('open', null, {}, ctx)
    await provider.apply('open', intent, { emit: () => {} } as never)
    expect('profile' in opened[0]!).toBe(false)
  })
})

/* ── ③ 删一格身份:先关 tab,再清分区 ─────────────────────────────────── */

describe('删一格身份', () => {
  it('**次序是判据**:先关掉它的 tab,再清它的分区', async () => {
    const calls: string[] = []
    const reconciler = new BrowserProfileReconciler(
      { ids: ['default', 'work'], defaultProfile: 'default' },
      {
        closeTabs: (profile) => { calls.push(`close:${profile}`); return 2 },
        clearPartition: async (profile) => { calls.push(`clear:${profile}`) },
      },
    )
    const gone = await reconciler.apply({ ids: ['default'], defaultProfile: 'default' })
    expect(gone).toEqual(['work'])
    /*
     * **反证**:把 `BrowserProfileReconciler.apply` 里那两句对调(先 `await
     * clearPartition` 再 `closeTabs`)→ 这一条当场红。判词整段在 `profiles.ts`
     * 的文件头上:一片还活着的视图会在清完之后把登录态写回去,于是「清掉了」
     * 变成「清掉了一半」。
     */
    expect(calls).toEqual(['close:work', 'clear:work'])
  })

  it('新增与改名对主进程什么都不是(分区懒建、名字只活在屏幕上)', async () => {
    const calls: string[] = []
    const reconciler = new BrowserProfileReconciler(
      { ids: ['default'], defaultProfile: 'default' },
      {
        closeTabs: (profile) => { calls.push(`close:${profile}`); return 0 },
        clearPartition: async (profile) => { calls.push(`clear:${profile}`) },
      },
    )
    expect(await reconciler.apply({ ids: ['default', 'work'], defaultProfile: 'work' })).toEqual([])
    expect(calls).toEqual([])
  })

  it('清分区砸了不往上抛(一次保存设置不该被它炸掉),但报得出来', async () => {
    const errors: string[] = []
    const reconciler = new BrowserProfileReconciler(
      { ids: ['a', 'b'], defaultProfile: 'a' },
      {
        closeTabs: () => 0,
        clearPartition: async () => { throw new Error('disk on fire') },
        onError: (profile) => { errors.push(profile) },
      },
    )
    await expect(reconciler.apply({ ids: ['a'], defaultProfile: 'a' })).resolves.toEqual(['b'])
    expect(errors).toEqual(['b'])
  })
})

/* ── 名册的读法与那只 watcher ─────────────────────────────────────────── */

describe('profileTableFromSettings', () => {
  it('空名册读成出厂那一格 —— 否则下一拍 reconciler 会把每一格身份都当成被删了', () => {
    expect(profileTableFromSettings({})).toEqual({ ids: ['default'], defaultProfile: 'default' })
    expect(profileTableFromSettings(settingsWith({ profiles: [] }))).toEqual({
      ids: ['default'], defaultProfile: 'default',
    })
  })

  it('缺省身份不在名册里 → 落回第一行', () => {
    const table = profileTableFromSettings(
      settingsWith({ profiles: [{ id: 'work', name: '' }], defaultProfile: 'gone' }),
    )
    expect(table).toEqual({ ids: ['work'], defaultProfile: 'work' })
  })
})

describe('installBrowserProfilesWatcher', () => {
  function slot() {
    let held: SettingsEventBroadcaster | null = null
    return {
      get: () => held,
      set: (next: SettingsEventBroadcaster | null) => { held = next },
      emit: (settings: Pick<AppSettings, 'browser'>) => {
        held?.({ type: 'settings:changed', settings: settings as AppSettings } satisfies SettingsEvent)
      },
    }
  }

  it('开场只记账**不 reconcile**(没有「上一份」可比);之后每次变更折一次', async () => {
    const s = slot()
    const calls: string[] = []
    const tables: string[] = []
    const off = installBrowserProfilesWatcher({
      readSettings: () => settingsWith({
        profiles: [{ id: 'default', name: '' }, { id: 'work', name: '' }],
        defaultProfile: 'work',
      }),
      getBroadcaster: s.get,
      setBroadcaster: s.set,
      onTable: (table) => tables.push(table.defaultProfile),
      closeTabs: (profile) => { calls.push(`close:${profile}`); return 1 },
      clearPartition: async (profile) => { calls.push(`clear:${profile}`) },
    })
    // 开场:记了账,一格都没清。
    expect(tables).toEqual(['work'])
    expect(calls).toEqual([])

    s.emit(settingsWith({ profiles: [{ id: 'default', name: '' }], defaultProfile: 'default' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['close:work', 'clear:work'])
    expect(tables).toEqual(['work', 'default'])

    off()
    expect(s.get()).toBeNull()
  })

  it('单槽端口**串联**不覆盖:前一个照样被叫到,摘掉时原样装回去', () => {
    const s = slot()
    const before = vi.fn()
    s.set(before)
    const off = installBrowserProfilesWatcher({
      readSettings: () => settingsWith({}),
      getBroadcaster: s.get,
      setBroadcaster: s.set,
      closeTabs: () => 0,
      clearPartition: async () => {},
    })
    s.emit(settingsWith({}))
    expect(before).toHaveBeenCalledTimes(1)
    off()
    expect(s.get()).toBe(before)
  })
})

/* ── service.closeProfileTabs ─────────────────────────────────────────── */

describe('closeProfileTabs', () => {
  it('只关那一格身份的 tab,走的是同一只 `close`(于是事件 / 落盘照旧)', () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-b3b-close-'))
    const closed: string[] = []
    const service = new BrowserService({
      sessionPolicy: new BrowserSessionPolicy(() => fakeSession() as BrowserSessionLike),
      tabsPath: path.join(store, 'browser', 'tabs.json'),
      persistDelayMs: 0,
      createView: () => fakeView() as never,
      observer: {
        onOpened: vi.fn(), onClosed: (id: string) => { closed.push(id) }, onNavigated: vi.fn(),
        onLoading: vi.fn(), onMaterialized: vi.fn(), onDematerialized: vi.fn(), onFind: vi.fn(), onSpawned: vi.fn(), onSpawnBlocked: vi.fn(),
      },
    })
    try {
      const a = service.open({ profile: 'work' })
      const b = service.open({ profile: 'default', background: true })
      const c = service.open({ profile: 'work', background: true })

      expect(service.closeProfileTabs('work')).toBe(2)
      expect(closed.sort()).toEqual([a.id, c.id].sort())
      expect(service.list().map((row) => row.id)).toEqual([b.id])
    } finally {
      service.dispose()
      fs.rmSync(store, { recursive: true, force: true })
    }
  })
})

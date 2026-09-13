/**
 * B3-a 的单元用例:**页内查找 / 网页权限询问 / 下载落地**。
 *
 * 与 B1-a 那份逐字同一条结构判据:**一条 `import … from 'electron'` 都没有**。
 * 三件事的每一个 Electron 触点在被测模块那一侧都是结构化端口(webContents、
 * session、DownloadItem、计时器、文件系统),这里喂的是记调用的替身。
 */
import { describe, expect, it, vi } from 'vitest'
import { assertResourceSpec } from '@onething/core/resource'

import { beginsNewFindSession, foldFoundInPage } from '../find.js'
import {
  ASKABLE_WEB_PERMISSIONS,
  WebPermissionBroker,
  decideWebPermission,
} from '../permission.js'
import {
  BrowserSessionPolicy,
  originOfPermissionRequest,
  type BrowserSessionLike,
} from '../session-policy.js'
import {
  installBrowserDownloads,
  resolveDownloadDirectory,
  resolveDownloadPath,
  splitFileName,
  type NativeDownloadItem,
} from '../download.js'
import { parseNativeViewRequest } from '../native-view-ipc.js'
import { browserResourceSpec } from '../resource-spec.js'
import {
  BrowserPermissionNotUserError,
  BrowserPermissionParamsError,
  BrowserPermissionRequestUnknownError,
  BrowserResourceProvider,
  type BrowserOps,
  type BrowserTabView,
} from '../resource-provider.js'
import { BrowserTab } from '../tab.js'

// ── 查找:折算与「接着找还是重找」 ─────────────────────────────────────────

describe('found-in-page 折算', () => {
  it('正常一发:序号与总数原样带出(1 起)', () => {
    expect(foldFoundInPage({ activeMatchOrdinal: 3, matches: 17 })).toEqual({ active: 3, total: 17 })
  })

  it('零命中 = 两格都 0,不是「上一次那个数」', () => {
    expect(foldFoundInPage({ activeMatchOrdinal: 0, matches: 0 })).toEqual({ active: 0, total: 0 })
  })

  it('只给总数(中间结果)→ 序号留 0,让读数那一格自己决定怎么说', () => {
    expect(foldFoundInPage({ matches: 9 })).toEqual({ active: 0, total: 9 })
  })

  it('序号夹到总数以内;认不出的载荷 = 零命中而不是抛', () => {
    expect(foldFoundInPage({ activeMatchOrdinal: 99, matches: 4 })).toEqual({ active: 4, total: 4 })
    expect(foldFoundInPage(null)).toEqual({ active: 0, total: 0 })
    expect(foldFoundInPage('nope')).toEqual({ active: 0, total: 0 })
  })

  it('**`findNext` 的意思与名字是反的**:true = 开一段新会话(判词在 find.ts)', () => {
    // 第一发(没有上一个词)= 新会话。**这一条就是 gate ⑫ 判红那一次的反证**:
    // 写反了它,第一发查找会「接着一段不存在的会话」,Chromium 答 matches: 0。
    expect(beginsNewFindSession(undefined, 'abc')).toBe(true)
    // 词一样 = 接着上一段走(那才是「下一处」)。
    expect(beginsNewFindSession('abc', 'abc')).toBe(false)
    expect(beginsNewFindSession('abc', 'abd')).toBe(true)
    // 空词永远答 false ——它根本不该走到 findInPage。
    expect(beginsNewFindSession('abc', '')).toBe(false)
  })
})

// ── 查找:一格 tab 上真的打出去了什么 ─────────────────────────────────────

interface FakeContents {
  calls: string[]
  listeners: Map<string, (...args: never[]) => void>
}

function buildTab(init: { url?: string } = {}) {
  const calls: string[] = []
  const listeners = new Map<string, (...args: never[]) => void>()
  const finds: { text: string; forward: boolean; findNext: boolean }[] = []
  const webContents = {
    on: (event: string, listener: (...args: never[]) => void) => { listeners.set(event, listener) },
    setWindowOpenHandler: () => {},
    loadURL: async () => {},
    reload: () => {}, stop: () => {}, focus: () => {}, close: () => {},
    isDestroyed: () => false,
    executeJavaScript: async () => '',
    capturePage: async () => ({ isEmpty: () => true, toDataURL: () => '' }),
    findInPage: (text: string, options?: { forward?: boolean; findNext?: boolean }) => {
      finds.push({ text, forward: options?.forward !== false, findNext: options?.findNext === true })
      calls.push(`find:${text}`)
      return finds.length
    },
    stopFindInPage: (action: string) => { calls.push(`stop:${action}`) },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} },
  }
  const onFind = vi.fn()
  const tab = new BrowserTab(
    { id: 't1', profile: 'default', ...(init.url ? { url: init.url } : {}) },
    {
      createView: () => ({ webContents, setBounds: () => {}, setVisible: () => {} }) as never,
      preferencesFor: () => ({}) as never,
      observer: { onState: () => {}, onOpened: () => {}, onWindowOpen: () => {}, onFind },
    },
  )
  return { tab, finds, onFind, fake: { calls, listeners } as FakeContents }
}

describe('BrowserTab 的查找', () => {
  it('没有视图 = 什么都不做(一次查找不该把惰性视图建出来)', () => {
    const { tab, finds } = buildTab()
    tab.findInPage('abc')
    expect(finds).toEqual([])
    expect(tab.materialized).toBe(false)
  })

  it('第一发开新会话(findNext=true),同词第二发接着走(false);换词又开新的', () => {
    const { tab, finds } = buildTab()
    tab.materialize()
    tab.findInPage('abc')
    tab.findInPage('abc')
    tab.findInPage('abd')
    expect(finds).toEqual([
      { text: 'abc', forward: true, findNext: true },
      { text: 'abc', forward: true, findNext: false },
      { text: 'abd', forward: true, findNext: true },
    ])
  })

  it('往上找 = forward:false;空词折成 stopFindInPage(不是「找一个空串」)', () => {
    const { tab, finds, fake } = buildTab()
    tab.materialize()
    tab.findInPage('abc', { forward: false })
    expect(finds[0]).toEqual({ text: 'abc', forward: false, findNext: true })
    tab.findInPage('')
    expect(fake.calls).toContain('stop:clearSelection')
    expect(finds).toHaveLength(1)
  })

  it('换了一页就忘掉上一个词 —— 下一下 ↵ 是「在这一页从头找」', () => {
    const { tab, finds, fake } = buildTab()
    tab.materialize()
    tab.findInPage('abc')
    fake.listeners.get('did-navigate')?.(undefined as never, 'https://b.test' as never)
    tab.findInPage('abc')
    // 换了一页 = 忘掉上一个词 → 两发都是「开新会话」,而不是第二发去接一段
    // 属于上一页的会话。
    expect(finds.map((f) => f.findNext)).toEqual([true, true])
  })

  it('`found-in-page` 每一发都折了往外报(中间结果与定稿都算)', () => {
    const { tab, onFind, fake } = buildTab()
    tab.materialize()
    fake.listeners.get('found-in-page')?.(undefined as never, { matches: 2 } as never)
    fake.listeners.get('found-in-page')?.(undefined as never, { activeMatchOrdinal: 1, matches: 5 } as never)
    expect(onFind.mock.calls.map((c) => c[1])).toEqual([
      { active: 0, total: 2 },
      { active: 1, total: 5 },
    ])
  })
})

describe('那条通道认得出 find / findStop', () => {
  it('两个动词各自的形;空词合法(它的意思是「别找了」)', () => {
    expect(parseNativeViewRequest({ verb: 'find', viewId: 't1', text: 'abc', forward: false }))
      .toEqual({ verb: 'find', viewId: 't1', text: 'abc', forward: false })
    expect(parseNativeViewRequest({ verb: 'find', viewId: 't1', text: '' }))
      .toEqual({ verb: 'find', viewId: 't1', text: '', forward: true })
    expect(parseNativeViewRequest({ verb: 'findStop', viewId: 't1' }))
      .toEqual({ verb: 'findStop', viewId: 't1' })
  })

  it('拼错的载荷静默丢掉,不让主进程抛', () => {
    expect(parseNativeViewRequest({ verb: 'find', viewId: 't1' })).toBeUndefined()
    expect(parseNativeViewRequest({ verb: 'find', text: 'abc' })).toBeUndefined()
    expect(parseNativeViewRequest({ verb: 'findStop' })).toBeUndefined()
  })
})

// ── 权限:哪一族能问 ──────────────────────────────────────────────────────

describe('网页权限三档', () => {
  it('能问的那一族逐格答 ask', () => {
    for (const permission of ASKABLE_WEB_PERMISSIONS) {
      expect(decideWebPermission(permission)).toBe('ask')
    }
  })

  it('点名拒的三格 + 认不出来的一律 deny', () => {
    for (const permission of ['display-capture', 'fullscreen', 'openExternal', 'unknown', 'idle-detection', '']) {
      expect(decideWebPermission(permission)).toBe('deny')
    }
  })

  it('来源:origin 优先、拼不出就原样、都没有就空串(不编一个出来)', () => {
    expect(originOfPermissionRequest({ securityOrigin: 'https://a.test' })).toBe('https://a.test')
    expect(originOfPermissionRequest({ requestingUrl: 'https://b.test/x?y=1' })).toBe('https://b.test')
    expect(originOfPermissionRequest({ requestingUrl: 'not a url' })).toBe('not a url')
    expect(originOfPermissionRequest(undefined)).toBe('')
  })
})

function fakeSession(): BrowserSessionLike & {
  request?: (wc: unknown, permission: string, cb: (granted: boolean) => void, details?: unknown) => void
} {
  const row = {
    getUserAgent: () => 'X Electron/1 Y',
    setUserAgent: () => {},
    setPermissionRequestHandler: (handler: never) => { row.request = handler as never },
    setPermissionCheckHandler: () => {},
    clearStorageData: () => Promise.resolve(),
  } as BrowserSessionLike & {
    request?: (wc: unknown, permission: string, cb: (granted: boolean) => void, details?: unknown) => void
  }
  return row
}

describe('分区上的权限处理器', () => {
  it('没有注入 ask = 逐格全拒(B1-a 的行为逐字不变)', async () => {
    const created = fakeSession()
    const policy = new BrowserSessionPolicy(() => created)
    policy.sessionFor()
    const answers: boolean[] = []
    created.request?.({}, 'geolocation', (granted) => answers.push(granted))
    created.request?.({}, 'notifications', (granted) => answers.push(granted))
    expect(answers).toEqual([false, false])
  })

  it('能问的走 ask;其余一格都不问、当场拒', async () => {
    const created = fakeSession()
    const asked: string[] = []
    const policy = new BrowserSessionPolicy(() => created, {
      ask: (request) => { asked.push(request.permission); return Promise.resolve(true) },
    })
    policy.sessionFor()
    const answers: boolean[] = []
    created.request?.({}, 'geolocation', (granted) => answers.push(granted), { securityOrigin: 'https://a.test' })
    created.request?.({}, 'display-capture', (granted) => answers.push(granted))
    await Promise.resolve()
    await Promise.resolve()
    expect(asked).toEqual(['geolocation'])
    expect(answers).toEqual([false, true])
  })

  it('ask 自己炸了也要落一句拒 —— 一次永远不回的 callback 会把页面挂死', async () => {
    const created = fakeSession()
    const policy = new BrowserSessionPolicy(() => created, {
      ask: () => Promise.reject(new Error('boom')),
    })
    policy.sessionFor()
    const answers: boolean[] = []
    created.request?.({}, 'media', (granted) => answers.push(granted))
    await Promise.resolve()
    await Promise.resolve()
    expect(answers).toEqual([false])
  })

  it('每一格 profile 建出来那一刻交给 onSession 一次(下载监听挂在那儿)', () => {
    const seen: string[] = []
    const policy = new BrowserSessionPolicy(() => fakeSession(), {
      onSession: (_session, partition) => { seen.push(partition) },
    })
    policy.sessionFor()
    policy.sessionFor()
    policy.sessionFor('work')
    expect(seen).toEqual(['persist:browser-default', 'persist:browser-work'])
  })
})

// ── 权限:那台 broker ─────────────────────────────────────────────────────

function buildBroker(over: { timeoutMs?: number } = {}) {
  const asks: unknown[] = []
  const resolved: { requestId: string; allow: boolean; reason: string }[] = []
  let fire: (() => void) | undefined
  const broker = new WebPermissionBroker({
    onAsk: (event) => asks.push(event),
    onResolved: (event) => resolved.push({ requestId: event.requestId, allow: event.allow, reason: event.reason }),
    setTimer: (run) => { fire = run; return 1 },
    clearTimer: () => { fire = undefined },
    mintId: () => `p${asks.length + 1}`,
    ...over,
  })
  return { broker, asks, resolved, timeout: () => fire?.() }
}

describe('WebPermissionBroker', () => {
  it('问一次 → 发一条事实;人答了 → 那一问结了,答案落回 Promise', async () => {
    const { broker, asks, resolved } = buildBroker()
    const answer = broker.ask({ tabId: 't1', permission: 'geolocation', origin: 'https://a.test' })
    expect(asks).toEqual([{ tabId: 't1', requestId: 'p1', permission: 'geolocation', origin: 'https://a.test' }])
    expect(broker.respond('p1', true)).toBe(true)
    await expect(answer).resolves.toBe(true)
    expect(resolved).toEqual([{ requestId: 'p1', allow: true, reason: 'answered' }])
  })

  it('**超时按拒算,而且那一下也是一条事实**(拆掉它 → 卡永远举着、页面永远等)', async () => {
    const { broker, resolved, timeout } = buildBroker()
    const answer = broker.ask({ tabId: 't1', permission: 'media', origin: '' })
    timeout()
    await expect(answer).resolves.toBe(false)
    expect(resolved).toEqual([{ requestId: 'p1', allow: false, reason: 'timeout' }])
    expect(broker.pendingCount).toBe(0)
  })

  it('答第二遍认不出来,答 false(两边差一拍,不是一次错误)', async () => {
    const { broker } = buildBroker()
    const answer = broker.ask({ tabId: 't1', permission: 'midi', origin: '' })
    expect(broker.respond('p1', false)).toBe(true)
    expect(broker.respond('p1', true)).toBe(false)
    await expect(answer).resolves.toBe(false)
  })

  it('tab 没了 / 关张 → 它身上悬着的每一问按拒结掉', async () => {
    const { broker, resolved } = buildBroker()
    const a = broker.ask({ tabId: 't1', permission: 'midi', origin: '' })
    const b = broker.ask({ tabId: 't2', permission: 'midi', origin: '' })
    broker.withdrawTab('t1')
    await expect(a).resolves.toBe(false)
    expect(resolved).toEqual([{ requestId: 'p1', allow: false, reason: 'gone' }])
    broker.dispose()
    await expect(b).resolves.toBe(false)
    // 关张之后再问,答的是拒而不是悬着。
    await expect(broker.ask({ tabId: 't3', permission: 'midi', origin: '' })).resolves.toBe(false)
  })
})

// ── 下载 ─────────────────────────────────────────────────────────────────

describe('下载落地', () => {
  const join = (dir: string, name: string) => `${dir}/${name}`

  it('名字拆法:最后一个点,开头那个点不算', () => {
    expect(splitFileName('a.zip')).toEqual({ stem: 'a', ext: '.zip' })
    expect(splitFileName('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: '.gz' })
    expect(splitFileName('.gitignore')).toEqual({ stem: '.gitignore', ext: '' })
    expect(splitFileName('README')).toEqual({ stem: 'README', ext: '' })
  })

  it('**重名加序号,不覆盖**(覆盖是一次静默的数据丢失)', () => {
    const taken = new Set(['/d/a.zip', '/d/a (1).zip'])
    expect(resolveDownloadPath('/d', 'a.zip', (p) => taken.has(p), join)).toBe('/d/a (2).zip')
    expect(resolveDownloadPath('/d', 'b.zip', (p) => taken.has(p), join)).toBe('/d/b.zip')
    // 空名字不落成一个没有名字的文件。
    expect(resolveDownloadPath('/d', '  ', () => false, join)).toBe('/d/download')
  })

  it('门那一格覆盖只在 `ONETHING_GATE_` 前缀下生效', () => {
    expect(resolveDownloadDirectory('/home/me/Downloads', {})).toEqual({
      dir: '/home/me/Downloads', override: false,
    })
    expect(resolveDownloadDirectory('/home/me/Downloads', { ONETHING_GATE_DOWNLOADS_DIR: '/tmp/x' })).toEqual({
      dir: '/tmp/x', override: true,
    })
  })

  it('三态各发一次;落点是去重之后那个名字,而且不弹系统面板', () => {
    let willDownload: ((e: unknown, item: NativeDownloadItem, wc: unknown) => void) | undefined
    const session = {
      on: (event: string, listener: never) => { if (event === 'will-download') willDownload = listener },
      removeListener: () => {},
    }
    const events: unknown[] = []
    installBrowserDownloads(session as never, {
      directory: () => '/d',
      tabIdOf: (wc) => (wc === 'wc1' ? 't1' : undefined),
      exists: (p) => p === '/d/a.zip',
      join,
      onEvent: (event) => events.push(event),
    })
    let saved = ''
    let done: ((e: unknown, state: string) => void) | undefined
    const item: NativeDownloadItem = {
      getFilename: () => 'a.zip',
      setSavePath: (p) => { saved = p },
      on: () => {},
      once: (event, listener) => { if (event === 'done') done = listener as never },
    }
    willDownload?.(undefined, item, 'wc1')
    expect(saved).toBe('/d/a (1).zip')
    expect(events).toEqual([{ tabId: 't1', filename: 'a.zip', state: 'started', path: '/d/a (1).zip' }])
    done?.(undefined, 'completed')
    expect(events.at(-1)).toEqual({ tabId: 't1', filename: 'a.zip', state: 'done', path: '/d/a (1).zip' })
  })

  it('取消 / 中断都说同一句话(failed);认不出 tab 的那一发照样落盘、只是不发事件', () => {
    let willDownload: ((e: unknown, item: NativeDownloadItem, wc: unknown) => void) | undefined
    const session = { on: (_e: string, l: never) => { willDownload = l }, removeListener: () => {} }
    const events: { state: string }[] = []
    installBrowserDownloads(session as never, {
      directory: () => '/d',
      tabIdOf: (wc) => (wc === 'wc1' ? 't1' : undefined),
      exists: () => false,
      join,
      onEvent: (event) => events.push(event),
    })
    let done: ((e: unknown, state: string) => void) | undefined
    const make = (): NativeDownloadItem => ({
      getFilename: () => 'b.zip',
      setSavePath: () => {},
      on: () => {},
      once: (event, listener) => { if (event === 'done') done = listener as never },
    })
    willDownload?.(undefined, make(), 'wc1')
    done?.(undefined, 'cancelled')
    expect(events.map((e) => e.state)).toEqual(['started', 'failed'])

    let savedForeign = ''
    willDownload?.(undefined, { ...make(), setSavePath: (p) => { savedForeign = p } }, 'wc-unknown')
    expect(savedForeign).toBe('/d/b.zip')
    expect(events.map((e) => e.state)).toEqual(['started', 'failed'])
  })
})

// ── 自述与 provider:`respondPermission` ──────────────────────────────────

function fakeTabView(): BrowserTabView {
  return {
    id: 't1', url: 'https://example.com', title: 'Example', loading: false,
    canGoBack: false, canGoForward: false, active: true, profile: 'default', zoomLevel: 0,
  }
}

function opsWithPermissions(answered: string[] = []) {
  const tab = fakeTabView()
  const ops: BrowserOps = {
    list: () => [tab],
    activeId: () => 't1',
    open: () => tab,
    navigate: () => {}, back: () => {}, forward: () => {}, reload: () => {},
    activate: () => {}, close: () => {}, zoom: () => {},
    has: (id) => id === 't1',
    readText: async () => '',
    capture: async () => undefined,
    get: (id) => (id === 't1' ? tab : undefined),
    respondPermission: (requestId, allow) => {
      if (requestId !== 'p1') return false
      answered.push(`${requestId}:${allow}`)
      return true
    },
  }
  return ops
}

const planCtx = (kind: 'user' | 'agent' | 'system') => ({
  principal: kind === 'user'
    ? { kind: 'user' as const, id: 'local' }
    : kind === 'agent'
      ? { kind: 'agent' as const, id: 'a1' }
      : { kind: 'system' as const, id: 's1' },
  invocation: {} as never,
  abort: {} as never,
  sandbox: undefined,
  now: () => 0,
}) as never

describe('自述:B3-a 新加的那几行', () => {
  it('契约照样过;做法九条(K3 加 `zoom`)、事实九条(2026-09-12 加 `spawned` / `spawnBlocked`)', () => {
    expect(assertResourceSpec(browserResourceSpec)).toBeUndefined()
    expect(Object.keys(browserResourceSpec.ops).sort()).toEqual([
      'activate', 'back', 'close', 'forward', 'navigate', 'open', 'reload', 'respondPermission',
      'zoom',
    ])
    expect(Object.keys(browserResourceSpec.events).sort()).toEqual([
      'closed', 'download', 'loading', 'navigated', 'opened',
      'permissionRequested', 'permissionResolved', 'spawnBlocked', 'spawned',
    ])
  })

  it('**查找一个字都没进自述**(它是视图状态,判词在 resource-spec 文件头)', () => {
    const words = JSON.stringify(browserResourceSpec)
    expect(Object.keys(browserResourceSpec.ops)).not.toContain('find')
    expect(Object.keys(browserResourceSpec.reads)).not.toContain('find')
    expect(Object.keys(browserResourceSpec.events)).not.toContain('find')
    expect(words.includes('findInPage')).toBe(false)
  })
})

describe('respondPermission', () => {
  it('**非用户主体一律拒,而且在 plan 期就拒**(AI 替网页放权限是越权)', async () => {
    const provider = new BrowserResourceProvider(opsWithPermissions())
    for (const kind of ['agent', 'system'] as const) {
      await expect(
        provider.plan('respondPermission', { scheme: 'browser', path: 't1' }, { requestId: 'p1', allow: true }, planCtx(kind)),
      ).rejects.toBeInstanceOf(BrowserPermissionNotUserError)
    }
  })

  it('用户主体:零效果的 Intent,apply 打到 ops 上', async () => {
    const answered: string[] = []
    const provider = new BrowserResourceProvider(opsWithPermissions(answered))
    const intent = await provider.plan(
      'respondPermission', { scheme: 'browser', path: 't1' }, { requestId: 'p1', allow: true }, planCtx('user'),
    )
    expect(intent.effects).toEqual([])
    const result = await provider.apply('respondPermission', intent, {
      emit: () => {},
    } as never)
    expect(answered).toEqual(['p1:true'])
    expect(result.content[0]).toMatchObject({ type: 'text' })
  })

  it('参数缺一格 = 一句说得出口的拒绝;`allow` 必须是真布尔', async () => {
    const provider = new BrowserResourceProvider(opsWithPermissions())
    const ref = { scheme: 'browser', path: 't1' }
    await expect(provider.plan('respondPermission', ref, { allow: true }, planCtx('user')))
      .rejects.toBeInstanceOf(BrowserPermissionParamsError)
    await expect(provider.plan('respondPermission', ref, { requestId: 'p1' }, planCtx('user')))
      .rejects.toBeInstanceOf(BrowserPermissionParamsError)
  })

  it('答一问早就没了的 → 抛一句实话,不静默', async () => {
    const provider = new BrowserResourceProvider(opsWithPermissions())
    const intent = await provider.plan(
      'respondPermission', { scheme: 'browser', path: 't1' }, { requestId: 'gone', allow: false }, planCtx('user'),
    )
    await expect(provider.apply('respondPermission', intent, { emit: () => {} } as never))
      .rejects.toBeInstanceOf(BrowserPermissionRequestUnknownError)
  })

  it('三条新事实各发一次,地址是那一格 tab', () => {
    const provider = new BrowserResourceProvider(opsWithPermissions())
    const seen: { ref: unknown; event: string; payload: unknown }[] = []
    provider.attach({
      emit: (ref: unknown, event: string, payload: unknown) => seen.push({ ref, event, payload }),
    } as never)
    provider.emitPermissionRequested({ tabId: 't1', requestId: 'p1', permission: 'geolocation', origin: 'https://a.test' })
    provider.emitPermissionResolved({ tabId: 't1', requestId: 'p1', allow: false, reason: 'timeout' })
    provider.emitDownload({ tabId: 't1', filename: 'a.zip', state: 'done', path: '/d/a.zip' })
    expect(seen.map((row) => row.event)).toEqual(['permissionRequested', 'permissionResolved', 'download'])
    expect(seen.every((row) => (row.ref as { path: string }).path === 't1')).toBe(true)
  })
})

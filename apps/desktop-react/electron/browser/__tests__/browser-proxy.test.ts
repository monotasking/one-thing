/**
 * 内嵌浏览器这一侧的代理用例(2026-09-12)。
 *
 * 报障的形状:app 自己那格 session 有代理、**浏览器分区没有** → 标签直连出网 →
 * 被墙的站 TLS 握手被关(主进程日志成串 `net_error -100`)。三条判据各钉一处:
 *
 *   ① 一格分区**建出来那一拍**就交给代理策略(不是事后补一遍);
 *   ② 第一发 `loadURL` **等**回放落地(旧壳 `whenBrowserPartitionReady` 判例:
 *      回放没落地就发请求 = 直连一发,泄露直连 IP);
 *   ③ 策略**建出来的每一格都登记**(多 profile 一格不落)。
 *
 * 零 `import … from 'electron'`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BrowserSessionPolicy,
  browserPartitionFor,
  type BrowserProxyPort,
  type BrowserSessionLike,
} from '../session-policy.js'
import { BrowserService } from '../service.js'

function fakeSession(): BrowserSessionLike {
  return {
    getUserAgent: () => 'X Electron/1 Y',
    setUserAgent: () => {},
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
    clearStorageData: () => Promise.resolve(),
  }
}

/** 一只记调用的代理端口。`hold` 为真时回放**不落地**(用来量「等不等」)。 */
function fakeProxyPort(hold = false) {
  const registered: BrowserSessionLike[] = []
  const settle: Array<() => void> = []
  const port: BrowserProxyPort = {
    register(session) {
      registered.push(session)
      if (!hold) return Promise.resolve()
      return new Promise<void>(resolve => { settle.push(resolve) })
    },
  }
  return { port, registered, settle: () => { for (const r of settle) r() } }
}

describe('BrowserSessionPolicy —— 分区建出来就登记代理', () => {
  it('① 新分区建出来那一拍调 register,而 `ready` 就是那一发', async () => {
    const proxy = fakeProxyPort()
    const created = fakeSession()
    const policy = new BrowserSessionPolicy(() => created, { proxy: proxy.port })

    // 还没人取过 session:没有分区,也就没有登记。
    expect(proxy.registered).toHaveLength(0)
    policy.sessionFor('work')
    expect(proxy.registered).toEqual([created])
    await expect(policy.ready('work')).resolves.toBeUndefined()
  })

  it('③ 策略建出来的**每一格** profile 都登记(多 profile 一格不落),同一格不重复登记', () => {
    const proxy = fakeProxyPort()
    const made: string[] = []
    const policy = new BrowserSessionPolicy(partition => {
      made.push(partition)
      return fakeSession()
    }, { proxy: proxy.port })

    policy.sessionFor('default')
    policy.sessionFor('work')
    policy.sessionFor('default') // 缓存命中 —— 既不重建也不重登记
    expect(made).toEqual([browserPartitionFor('default'), browserPartitionFor('work')])
    expect(proxy.registered).toHaveLength(2)
  })

  it('② 回放没落地,`ready` 就不落地', async () => {
    const proxy = fakeProxyPort(true)
    const policy = new BrowserSessionPolicy(() => fakeSession(), { proxy: proxy.port })
    policy.sessionFor('default')

    let done = false
    void policy.ready('default').then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    proxy.settle()
    await policy.ready('default')
    expect(done).toBe(true)
  })

  it('回放砸了 `ready` 照样落地 —— 一格没有代理好过一格永远白屏', async () => {
    const policy = new BrowserSessionPolicy(() => fakeSession(), {
      proxy: { register: () => Promise.reject(new Error('setProxy failed')) },
    })
    policy.sessionFor('default')
    await expect(policy.ready('default')).resolves.toBeUndefined()
  })

  it('没注入代理端口 = 这台宿主不管代理,`ready` 立刻答应(单测与老装配点照旧)', async () => {
    const policy = new BrowserSessionPolicy(() => fakeSession())
    policy.sessionFor('default')
    await expect(policy.ready('default')).resolves.toBeUndefined()
    await expect(policy.ready('never-created')).resolves.toBeUndefined()
  })
})

describe('BrowserTab —— 第一发 loadURL 等回放落地', () => {
  let store: string
  beforeEach(() => { store = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-proxy-')) })
  afterEach(() => { fs.rmSync(store, { recursive: true, force: true }) })

  function build(proxy: BrowserProxyPort) {
    const loads: string[] = []
    const sessionPolicy = new BrowserSessionPolicy(() => fakeSession(), { proxy })
    const service = new BrowserService({
      sessionPolicy,
      tabsPath: path.join(store, 'browser', 'tabs.json'),
      persistDelayMs: 10_000,
      createView: () => ({
        webContents: {
          on: () => {}, setWindowOpenHandler: () => {},
          loadURL: async (url: string) => { loads.push(url) },
          reload: () => {}, stop: () => {}, focus: () => {}, close: () => {},
          isDestroyed: () => false, executeJavaScript: async () => '',
          capturePage: async () => ({ isEmpty: () => true, toDataURL: () => '' }),
          findInPage: () => 0, stopFindInPage: () => {},
          navigationHistory: {
            canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {},
          },
        },
        setBounds: () => {}, setVisible: () => {},
      }) as never,
      observer: {
        onOpened: vi.fn(), onClosed: vi.fn(), onNavigated: vi.fn(), onLoading: vi.fn(),
        onMaterialized: vi.fn(), onDematerialized: vi.fn(), onFind: vi.fn(),
      },
    })
    return { service, loads }
  }

  it('② 回放在飞的时候一个字节都不发;落地之后才 loadURL', async () => {
    const proxy = fakeProxyPort(true)
    const { service, loads } = build(proxy.port)

    // 开一格前台 tab:视图建出来了(于是分区也建出来、登记过了),但**没有发请求**。
    service.open({ url: 'https://blocked.example' })
    await Promise.resolve()
    await Promise.resolve()
    expect(loads).toEqual([])

    proxy.settle()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(loads).toEqual(['https://blocked.example'])
    service.dispose()
  })

  it('回放已经落地 = 照常加载(这条门不会把正常那一路挡住)', async () => {
    const proxy = fakeProxyPort()
    const { service, loads } = build(proxy.port)
    service.open({ url: 'https://ok.example' })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(loads).toEqual(['https://ok.example'])
    service.dispose()
  })
})

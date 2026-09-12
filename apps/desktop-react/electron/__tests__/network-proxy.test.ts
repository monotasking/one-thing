/**
 * `ShellProxyPolicy` 的单元用例(2026-09-12)。
 *
 * **一条 `import … from 'electron'` 都没有** —— 与 `electron/browser/__tests__/` 同
 * 一条纪律:被测模块那一侧每个 Electron 触点都是结构化端口,这里喂的是记调用的替身。
 *
 * 四件事值得钉:配置怎么折(三档)、`apply` 是不是真的走到了**每一格**、登记那一刻
 * 会不会**当场回放**、以及 bypass 的归一。前三件正是这次报障的三个可能落点。
 */
import { describe, expect, it } from 'vitest'

import {
  ShellProxyPolicy,
  normalizeBypassRules,
  type ElectronProxyConfig,
  type ElectronProxySessionLike,
} from '../network-proxy.js'

function fakeSession() {
  const calls: ElectronProxyConfig[] = []
  const session: ElectronProxySessionLike & { calls: ElectronProxyConfig[] } = {
    calls,
    setProxy(config) { calls.push(config); return Promise.resolve() },
  }
  return session
}

describe('ShellProxyPolicy.fromSettings —— 设置折成 Electron 的配置', () => {
  it('关着 = direct', () => {
    expect(ShellProxyPolicy.fromSettings({ enabled: false, url: 'http://127.0.0.1:7890' }))
      .toEqual({ mode: 'direct' })
    expect(ShellProxyPolicy.fromSettings(undefined)).toEqual({ mode: 'direct' })
  })

  it('合法 = fixed_servers,而且 proxyRules **没有**尾随斜杠(ERR_NO_SUPPORTED_PROXIES 判例)', () => {
    const config = ShellProxyPolicy.fromSettings({
      enabled: true,
      url: 'http://127.0.0.1:7890',
      bypassRules: 'localhost;127.0.0.1, ::1 ; *.local',
    })
    expect(config).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:7890',
      proxyBypassRules: 'localhost;127.0.0.1;::1;*.local',
    })
    // 反过来那一半:`new URL(...).toString()` 会补一个 `/`,而那正是 Chromium 判非法的那一格。
    expect(new URL('http://127.0.0.1:7890').toString()).toBe('http://127.0.0.1:7890/')
  })

  it('socks5 也走 fixed_servers(协议原样带过去)', () => {
    expect(ShellProxyPolicy.fromSettings({ enabled: true, url: 'socks5://127.0.0.1:7890' }))
      .toEqual({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:7890', proxyBypassRules: '' })
  })

  it('非法 = 回直连,而且**说出口**(静默直连是那条看不懂的 TLS 错的温床)', () => {
    const said: string[] = []
    expect(ShellProxyPolicy.fromSettings({ enabled: true, url: 'not a url' }, e => { said.push(e) }))
      .toEqual({ mode: 'direct' })
    expect(said).toHaveLength(1)
    // 开着但 URL 是空串,同一档。
    expect(ShellProxyPolicy.fromSettings({ enabled: true, url: '' })).toEqual({ mode: 'direct' })
  })
})

describe('normalizeBypassRules', () => {
  it('分号与逗号同权,空项与空格丢掉', () => {
    expect(normalizeBypassRules(' a ; ,b,, c ')).toBe('a;b;c')
    expect(normalizeBypassRules(undefined)).toBe('')
    expect(normalizeBypassRules('')).toBe('')
    // `<-loopback>` 是 Chromium 的「**别**默认放过 localhost」规则 —— 归一不许吃掉它
    // (门 ⑱ 靠它才量得到「请求真的走了代理」)。
    expect(normalizeBypassRules('<-loopback>')).toBe('<-loopback>')
  })
})

describe('ShellProxyPolicy.apply —— 每一张网络面都要套上', () => {
  it('defaultSession + 每一个已登记的分区,一个不落', async () => {
    const def = fakeSession()
    const a = fakeSession()
    const b = fakeSession()
    const policy = new ShellProxyPolicy({ defaultSession: () => def })
    policy.register(a)
    policy.register(b)
    expect(policy.registeredCount).toBe(2)

    const config: ElectronProxyConfig = {
      mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890', proxyBypassRules: '',
    }
    await policy.apply(config)
    expect(def.calls).toEqual([config])
    expect(a.calls).toEqual([config])
    expect(b.calls).toEqual([config])
    expect(policy.config).toEqual(config)
  })

  it('dispatcher 缓存照旧在 apply 里清掉(provider 那半边的网络面)', async () => {
    let cleared = 0
    const policy = new ShellProxyPolicy({
      defaultSession: () => fakeSession(),
      clearDispatcherCache: () => { cleared += 1 },
    })
    await policy.apply({ mode: 'direct' })
    await policy.apply({ mode: 'direct' })
    expect(cleared).toBe(2)
  })

  it('一格套不上不该让别的几格也不套 —— 逐格 try/catch,而且说出是哪一格', async () => {
    const good = fakeSession()
    const bad: ElectronProxySessionLike = { setProxy: () => Promise.reject(new Error('gone')) }
    const where: string[] = []
    const policy = new ShellProxyPolicy({
      defaultSession: () => fakeSession(),
      onError: w => { where.push(w) },
    })
    policy.register(bad)
    policy.register(good)
    await policy.apply({ mode: 'direct' })
    expect(good.calls).toEqual([{ mode: 'direct' }])
    expect(where).toEqual(['partition'])
  })

  it('注销之后那一格不再跟着重套', async () => {
    const one = fakeSession()
    const policy = new ShellProxyPolicy({ defaultSession: () => fakeSession() })
    const reg = policy.register(one)
    reg.unregister()
    reg.unregister() // 幂等
    expect(policy.registeredCount).toBe(0)
    await policy.apply({ mode: 'direct' })
    expect(one.calls).toEqual([])
  })
})

describe('ShellProxyPolicy.register —— 登记就是回放', () => {
  it('已经有配置 = **当场回放**,而且 ready 等的就是那一发', async () => {
    const policy = new ShellProxyPolicy({ defaultSession: () => fakeSession() })
    const config: ElectronProxyConfig = {
      mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890', proxyBypassRules: '',
    }
    await policy.apply(config)

    // 「最后一次 apply 之后很久才建出来的那一格」:没有回放它就直连。
    let landed = false
    const late: ElectronProxySessionLike = {
      setProxy: () => new Promise(resolve => { setTimeout(() => { landed = true; resolve() }, 5) }),
    }
    const reg = policy.register(late)
    expect(landed).toBe(false)
    await reg.ready
    expect(landed).toBe(true)
  })

  it('还没 apply 过 = 立刻答应(没有配置可回放,不是一次等待)', async () => {
    const policy = new ShellProxyPolicy({ defaultSession: () => fakeSession() })
    const one = fakeSession()
    await policy.register(one).ready
    expect(one.calls).toEqual([])
  })
})

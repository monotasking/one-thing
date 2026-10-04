import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { workspaceId?: string }>(),
  oauthProviders: new Set<string>(),
  spaces: [] as Array<{ id: string; name: string; createdAt: number }>,
  /** 记下 refreshTokenIfNeeded 收到的 (providerId, target),用来证明刷新落在对的 entry 上。 */
  refreshCalls: [] as Array<{ providerId: string; target: unknown }>,
  refreshImpl: (async () => ({ accessToken: 'refreshed', expiresAt: 0, tokenType: 'Bearer' })) as
    (providerId: string, target: unknown) => Promise<unknown>,
  /** 空间那一份生效设置(批 6 读 `providers[<订阅家>].subscriptionFallback` 与开关)。 */
  spaceSettings: {} as Record<string, unknown>,
}))

vi.mock('@onething/backend/auth/auth-process-service', () => ({
  getAuthService: () => ({
    refreshTokenIfNeeded: (providerId: string, target: unknown) => {
      mocks.refreshCalls.push({ providerId, target })
      return mocks.refreshImpl(providerId, target)
    },
  }),
}))

vi.mock('../../settings/settings-store.js', () => ({ getSettings: () => ({}), getSpaceSettings: () => mocks.spaceSettings }))

vi.mock('../../session/session-store.js', async () => {
  const { DEFAULT_SPACE_ID, isValidSpaceId } = await import('@onething/backend/space/space-types')
  return {
    resolveSessionSpaceId: (id: string | undefined | null) => {
      const workspaceId = id ? mocks.sessions.get(id)?.workspaceId : undefined
      return workspaceId && isValidSpaceId(workspaceId) ? workspaceId : DEFAULT_SPACE_ID
    },
  }
})

// providers 收口第二部分:替身打在服务商入口上(被测代码经入口拿这几个名字),其余名字保留原件。
vi.mock('@onething/backend/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@onething/backend/provider')>()),
  requiresOAuth: (id: string) => mocks.oauthProviders.has(id),
  getProviderInfo: (id: string) => ({ id, name: id.toUpperCase() }),
}))

vi.mock('@onething/backend/space/space-store', () => ({
  getSpacesStore: () => ({ list: () => mocks.spaces }),
}))

import type { AgentProvider } from '@onething/backend/agent-loop'
import {
  getSpaceProviderCredentials,
  resetSpaceCredentialRotationForTests,
  resetSpaceCredentialsCacheForTests,
  writeSpaceCredentials,
  type SpaceCredentialEntry,
} from '../credentials-pool.js'
import { setRootDirForTests } from '@onething/backend/space/space-persistence'
import { createSessionCredentialRotator } from '../credentials-rotation.js'

let tmpDir: string

function entry(id: string, over: Partial<SpaceCredentialEntry> = {}): SpaceCredentialEntry {
  return { id, label: id, authType: 'apiKey', apiKey: `sk-${id}`, source: 'user', ...over }
}

/** 记下每次重建 provider 时收到的凭证 —— 「重试真的重新走了解析」靠它证明。 */
interface ReprovisionOverride {
  apiKey?: string
  baseUrl?: string
  oauthToken?: { accessToken: string }
  spaceCredential?: { spaceId?: string; entryId?: string; authType?: string }
}

function trackingReprovision() {
  const seen: ReprovisionOverride[] = []
  const fn = (override: ReprovisionOverride): AgentProvider | undefined => {
    seen.push(override)
    return { id: 'rebuilt' } as unknown as AgentProvider
  }
  return { seen, fn }
}

function quotaError(): Error {
  return Object.assign(
    new Error('deepseek agent loop API error: 429 {"error":{"code":"insufficient_quota"}}'),
    { data: { statusCode: 429 } },
  )
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-rotator-'))
  setRootDirForTests(tmpDir)
  resetSpaceCredentialsCacheForTests()
  resetSpaceCredentialRotationForTests()
  mocks.sessions = new Map([['s1', { workspaceId: 'work' }], ['s-default', {}]])
  mocks.oauthProviders = new Set(['codex'])
  mocks.spaces = [
    { id: 'default', name: '默认空间', createdAt: 0 },
    { id: 'work', name: '工作', createdAt: 1 },
  ]
  mocks.refreshCalls = []
  mocks.spaceSettings = {}
  mocks.refreshImpl = async () => ({ accessToken: 'refreshed', expiresAt: 0, tokenType: 'Bearer' })
})

afterEach(() => {
  setRootDirForTests(null)
  resetSpaceCredentialsCacheForTests()
  resetSpaceCredentialRotationForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function seedPool(policy: string, entries: SpaceCredentialEntry[]): void {
  writeSpaceCredentials('work', { providers: { deepseek: { entries, policy } } })
}

function paymentRequiredError(): Error {
  return Object.assign(
    new Error('deepseek agent loop API error: 402 {"error":{"message":"Insufficient Balance"}}'),
    { data: { statusCode: 402 } },
  )
}

describe('挂不挂钩子:没有可换的就根本不挂', () => {
  it('默认空间没有池 —— 与别的空间同一条判据,不是按空间早退', () => {
    const rotator = createSessionCredentialRotator({
      sessionId: 's-default',
      providerId: 'deepseek',
      currentEntryId: 'a',
      reprovision: trackingReprovision().fn,
    })
    expect(rotator).toBeUndefined()
  })

  it('本次没命中任何 entry(未配置 —— 那是起流前置拦截的事)', () => {
    seedPool('priority-failover', [entry('a'), entry('b')])
    expect(createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'deepseek',
      reprovision: trackingReprovision().fn,
    })).toBeUndefined()
  })

  it('池里只有一条 —— 换来换去还是它', () => {
    seedPool('priority-failover', [entry('a')])
    expect(createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'deepseek',
      currentEntryId: 'a',
      reprovision: trackingReprovision().fn,
    })).toBeUndefined()
  })
})

describe('默认空间也轮换(它早已并入同一份密钥池)', () => {
  it('两把密钥,第一把 402 之后选中第二把', async () => {
    writeSpaceCredentials('default', {
      providers: { deepseek: { entries: [entry('a'), entry('b')], policy: 'priority-failover' } },
    })
    const reprovision = trackingReprovision()
    const rotator = createSessionCredentialRotator({
      sessionId: 's-default',
      providerId: 'deepseek',
      currentEntryId: 'a',
      reprovision: reprovision.fn,
    })
    expect(rotator).toBeDefined()

    const rotation = await rotator!(paymentRequiredError(), 1)
    expect(rotation?.reason).toContain('配额耗尽')
    expect(reprovision.seen).toEqual([{
      apiKey: 'sk-b',
      baseUrl: undefined,
      spaceCredential: { spaceId: 'default', entryId: 'b', authType: 'apiKey' },
    }])
    // 402 的冷却落在第一把上,第二把干净。
    resetSpaceCredentialsCacheForTests()
    const entries = getSpaceProviderCredentials('default', 'deepseek')?.entries ?? []
    expect(entries[0].cooldownUntil).toBeGreaterThan(Date.now())
    expect(entries[1].cooldownUntil).toBeUndefined()
  })
})

describe('轮换:分类 → 写冷却 → 重新解析 → 重建 provider', () => {
  it('配额耗尽:冷却写盘,换到下一条,重建时带的是**新**凭证', async () => {
    seedPool('priority-failover', [entry('a'), entry('b', { baseUrl: 'https://b.example' })])
    const reprovision = trackingReprovision()
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'deepseek',
      currentEntryId: 'a',
      reprovision: reprovision.fn,
    })!
    expect(rotator).toBeDefined()

    const rotation = await rotator(quotaError(), 1)
    expect(rotation).toBeDefined()
    expect(rotation?.reason).toContain('配额耗尽')
    // 重新解析确实发生了,而且拿到的是第二把钥匙(含它自己的端点)。
    // 归属标记跟着换手一起走(批 B6):后续的中途刷新要写回**新**那条 entry。
    expect(reprovision.seen).toEqual([{
      apiKey: 'sk-b',
      baseUrl: 'https://b.example',
      spaceCredential: { spaceId: 'work', entryId: 'b', authType: 'apiKey' },
    }])

    // 冷却落了盘 —— 重启不忘。
    resetSpaceCredentialsCacheForTests()
    const entries = getSpaceProviderCredentials('work', 'deepseek')?.entries ?? []
    expect(entries[0].cooldownUntil).toBeGreaterThan(Date.now())
    expect(entries[1].cooldownUntil).toBeUndefined()
  })

  it('限流的冷却比配额短(两者都换,但代价不同)', async () => {
    seedPool('priority-failover', [entry('a'), entry('b')])
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'deepseek',
      currentEntryId: 'a',
      reprovision: trackingReprovision().fn,
    })!
    await rotator(new Error('Claude agent loop API error: 429 {"type":"rate_limit_error"}'), 1)
    const cooled = getSpaceProviderCredentials('work', 'deepseek')?.entries[0].cooldownUntil ?? 0
    expect(cooled - Date.now()).toBeLessThanOrEqual(60_000)
  })

  it('**unknown 一律不换,也不写冷却** —— 程序性错误不该烧穿整池', async () => {
    seedPool('priority-failover', [entry('a'), entry('b')])
    const reprovision = trackingReprovision()
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'deepseek',
      currentEntryId: 'a',
      reprovision: reprovision.fn,
    })!

    const rotation = await rotator(
      new Error('deepseek agent loop API error: 400 {"error":{"message":"Invalid tool schema"}}'),
      1,
    )
    expect(rotation).toBeUndefined()
    expect(reprovision.seen).toHaveLength(0)
    expect(getSpaceProviderCredentials('work', 'deepseek')?.entries[0].cooldownUntil)
      .toBeUndefined()
  })

  it('transient(5xx / 网络断)也不换 —— 那是服务端的事,与钥匙无关', async () => {
    seedPool('priority-failover', [entry('a'), entry('b')])
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'deepseek',
      currentEntryId: 'a',
      reprovision: trackingReprovision().fn,
    })!
    expect(await rotator(new Error('fetch failed'), 1)).toBeUndefined()
    expect(await rotator(new Error('deepseek agent loop API error: 503 busy'), 1)).toBeUndefined()
    expect(getSpaceProviderCredentials('work', 'deepseek')?.entries[0].cooldownUntil)
      .toBeUndefined()
  })

  it('连续轮换会顺着池子往下走,不会在同一条上打转', async () => {
    seedPool('priority-failover', [entry('a'), entry('b'), entry('c')])
    const reprovision = trackingReprovision()
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'deepseek',
      currentEntryId: 'a',
      reprovision: reprovision.fn,
    })!
    await rotator(quotaError(), 1)
    await rotator(quotaError(), 2)
    expect(reprovision.seen.map(seen => seen.apiKey)).toEqual(['sk-b', 'sk-c'])
  })

  it('全池冷却之后停手 —— 把原错误交回去,不假装还能换', async () => {
    seedPool('priority-failover', [entry('a'), entry('b')])
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'deepseek',
      currentEntryId: 'a',
      reprovision: trackingReprovision().fn,
    })!
    expect(await rotator(quotaError(), 1)).toBeDefined()
    expect(await rotator(quotaError(), 2)).toBeUndefined()
  })
})

/* ── OAuth 型凭证的轮换(批 B6)────────────────────────────────────────────── */

function oauthEntry(id: string, over: Partial<SpaceCredentialEntry> = {}): SpaceCredentialEntry {
  return {
    id,
    label: id,
    authType: 'oauth',
    oauthToken: { accessToken: `at-${id}`, expiresAt: Date.now() + 3_600_000, tokenType: 'Bearer' },
    source: 'user',
    ...over,
  }
}

function seedOAuthPool(policy: string, entries: SpaceCredentialEntry[]): void {
  writeSpaceCredentials('work', { providers: { codex: { entries, policy } } })
  resetSpaceCredentialsCacheForTests()
}

describe('OAuth 型池的轮换(批 B6)', () => {
  it('换到下一个账号之前**先刷新它的 token**,重建时带的是刷出来的那一个', async () => {
    seedOAuthPool('priority-failover', [oauthEntry('a'), oauthEntry('b')])
    mocks.refreshImpl = async () => ({ accessToken: 'fresh-b', expiresAt: 0, tokenType: 'Bearer' })
    const reprovision = trackingReprovision()
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'codex',
      currentEntryId: 'a',
      reprovision: reprovision.fn,
    })!
    expect(rotator).toBeDefined()

    const rotation = await rotator(quotaError(), 1)
    expect(rotation).toBeDefined()

    // 刷新问的是**目标那条 entry**,不是「当前会话属于哪个 provider」这种含糊坐标。
    expect(mocks.refreshCalls).toEqual([
      { providerId: 'codex', target: { kind: 'space', spaceId: 'work', entryId: 'b' } },
    ])
    expect(reprovision.seen).toEqual([{
      oauthToken: { accessToken: 'fresh-b', expiresAt: 0, tokenType: 'Bearer' },
      baseUrl: undefined,
      spaceCredential: { spaceId: 'work', entryId: 'b', authType: 'oauth' },
    }])
    // 换的是 token,不是 key —— apiKey 一个字都不该出现。
    expect(reprovision.seen[0].apiKey).toBeUndefined()
  })

  it('下一个账号刷不动(refresh 被拒)→ 给它写 auth-invalid 冷却并放弃这一轮', async () => {
    seedOAuthPool('priority-failover', [oauthEntry('a'), oauthEntry('b')])
    mocks.refreshImpl = async () => {
      throw Object.assign(new Error('Token refresh failed: 400'), { statusCode: 400 })
    }
    const reprovision = trackingReprovision()
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'codex',
      currentEntryId: 'a',
      reprovision: reprovision.fn,
    })!

    await expect(rotator(quotaError(), 1)).resolves.toBeUndefined()
    expect(reprovision.seen).toEqual([])

    resetSpaceCredentialsCacheForTests()
    const entries = getSpaceProviderCredentials('work', 'codex')?.entries ?? []
    // a 是配额冷却(5 分钟),b 是 auth-invalid 冷却(24 小时)—— 两者都落了盘。
    expect(entries[0].cooldownUntil).toBeGreaterThan(Date.now())
    expect(entries[1].cooldownUntil).toBeGreaterThan(Date.now() + 23 * 60 * 60_000)
  })
})

/**
 * 批 E:轮换边界是插件策略**唯一被 await 的**那条路 —— 也是「这个用完用另一个」
 * 的主场。这里钉三件事:它真的被问到、问到的 ctx 带着 attempt 与失败分类、
 * 策略缺席/坏掉时轮换照常回落内置 failover。
 */
describe('批 E:轮换边界上的插件策略', () => {
  beforeEach(async () => {
    const registry = await import('../credentials-strategy.js')
    registry.resetPluginCredentialStrategiesForTests()
    registry.resetAppPluginCredentialStrategyHostForTests()
    registry.configureAppPluginCredentialStrategyHost()
    const health = await import('../../plugin-contract/plugin-contract-health.js')
    health.resetPluginRuntimeHealthForTests()
  })

  afterEach(async () => {
    const registry = await import('../credentials-strategy.js')
    registry.resetAppPluginCredentialStrategyHostForTests()
    registry.resetPluginCredentialStrategiesForTests()
  })

  it('问策略、带上 attempt 与上一条的失败分类,并按它换手', async () => {
    const registry = await import('../credentials-strategy.js')
    seedPool('plugin:balancer:least-used', [entry('a'), entry('b'), entry('c')])
    const seen: Array<{ attempt: number; lastFailure: unknown; ids: string[] }> = []
    registry.registerPluginCredentialStrategy('balancer', {
      name: 'least-used',
      title: 'Least used',
      select: ctx => {
        seen.push({
          attempt: ctx.attempt,
          lastFailure: ctx.lastFailure,
          ids: ctx.entries.map(e => e.id),
        })
        return 'c'
      },
    })

    const reprovision = trackingReprovision()
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'deepseek',
      currentEntryId: 'a',
      reprovision: reprovision.fn,
    })!

    const rotation = await rotator(quotaError(), 1)

    expect(rotation).toBeTruthy()
    expect(reprovision.seen[0].spaceCredential?.entryId).toBe('c')
    expect(reprovision.seen[0].apiKey).toBe('sk-c')
    // 候选集已剔掉刚被写冷却的 a —— 策略拿不到一条冷却中的 entry。
    expect(seen).toEqual([{
      attempt: 2,
      lastFailure: { entryId: 'a', kind: 'quota-exhausted', status: 429 },
      ids: ['b', 'c'],
    }])
  })

  it('策略缺席 = 回落内置 failover,轮换照常发生', async () => {
    seedPool('plugin:ghost:none', [entry('a'), entry('b')])
    const reprovision = trackingReprovision()
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'deepseek',
      currentEntryId: 'a',
      reprovision: reprovision.fn,
    })!

    await expect(rotator(quotaError(), 1)).resolves.toBeTruthy()
    expect(reprovision.seen[0].spaceCredential?.entryId).toBe('b')
  })

  it('策略抛错 = 回落 + 记熔断,起流一点不受影响', async () => {
    const registry = await import('../credentials-strategy.js')
    const health = await import('../../plugin-contract/plugin-contract-health.js')
    seedPool('plugin:flaky:boom', [entry('a'), entry('b')])
    registry.registerPluginCredentialStrategy('flaky', {
      name: 'boom',
      title: 'Boom',
      select: () => { throw new Error('nope') },
    })

    const reprovision = trackingReprovision()
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'deepseek',
      currentEntryId: 'a',
      reprovision: reprovision.fn,
    })!

    await expect(rotator(quotaError(), 1)).resolves.toBeTruthy()
    expect(reprovision.seen[0].spaceCredential?.entryId).toBe('b')
    expect(health.getPluginRuntimeHealth('flaky')?.lastError).toContain('nope')
  })

  it('策略指了一条冷却中的 entry = 回落(候选集里本来就没有它)', async () => {
    const registry = await import('../credentials-strategy.js')
    seedPool('plugin:stale:pick-a', [entry('a'), entry('b')])
    registry.registerPluginCredentialStrategy('stale', {
      name: 'pick-a',
      title: 'Pick a',
      // a 刚刚因为配额耗尽被写了冷却 —— 指它就是指一个不在候选集里的 id。
      select: () => 'a',
    })

    const reprovision = trackingReprovision()
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'deepseek',
      currentEntryId: 'a',
      reprovision: reprovision.fn,
    })!

    await expect(rotator(quotaError(), 1)).resolves.toBeTruthy()
    expect(reprovision.seen[0].spaceCredential?.entryId).toBe('b')
  })
})

describe('轮转 v2:沿候选序列走,订阅用完接同家 API(批 6 §9.1)', () => {
  // 真的内置两家:codex(订阅,oauth)↔ openai(API)。manifest 自述 sibling,这里一个名字都不判。
  function seedFamily(oauthEntries: SpaceCredentialEntry[], apiEntries: SpaceCredentialEntry[]): void {
    writeSpaceCredentials('work', {
      providers: {
        codex: { entries: oauthEntries, policy: 'single' },
        openai: { entries: apiEntries, policy: 'priority-failover' },
      },
    })
  }
  const account = (id: string, over: Partial<SpaceCredentialEntry> = {}) =>
    entry(id, { authType: 'oauth', apiKey: undefined, oauthToken: { accessToken: `at-${id}` }, ...over })

  it('A 配额耗尽 → B;B 也耗尽 → 同家 API 第一把,换家并说「按 API 计费」', async () => {
    seedFamily([account('A'), account('B')], [entry('k1', { baseUrl: 'https://api.example/v1' })])
    const reprovision = trackingReprovision()
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'codex',
      currentEntryId: 'A',
      providerConfig: { model: 'gpt-5.5', baseUrl: 'https://chatgpt.example/codex', headers: { 'x-codex': '1' } },
      reprovision: reprovision.fn as never,
    })!
    expect(rotator).toBeDefined()

    const first = await rotator(quotaError(), 1)
    expect(first?.reason).toContain('配额耗尽')
    expect(reprovision.seen[0]).toMatchObject({
      oauthToken: { accessToken: 'refreshed' },
      spaceCredential: { spaceId: 'work', entryId: 'B', authType: 'oauth' },
    })
    expect((reprovision.seen[0] as { providerId?: string }).providerId).toBeUndefined()

    const second = await rotator(quotaError(), 2)
    expect(second?.reason).toBe('订阅额度已用完,这一轮按 API 计费')
    const crossed = reprovision.seen[1] as ReprovisionOverride & { providerId?: string; config?: Record<string, unknown> }
    expect(crossed.providerId).toBe('openai')
    expect(crossed.apiKey).toBe('sk-k1')
    expect(crossed.spaceCredential).toMatchObject({
      spaceId: 'work', entryId: 'k1', authType: 'apiKey', route: { providerId: 'openai', reason: 'sibling-api' },
    })
    // 端点一族整族换成那一家的;模型一族留用户选的那一家的。
    expect(crossed.config).toMatchObject({ model: 'gpt-5.5', apiKey: 'sk-k1', baseUrl: 'https://api.example/v1' })
    expect(crossed.config?.headers).toBeUndefined()

    // 两个账号都写上了冷却;API 那把干净。
    resetSpaceCredentialsCacheForTests()
    const accounts = getSpaceProviderCredentials('work', 'codex')?.entries ?? []
    expect(accounts.every(item => (item.cooldownUntil ?? 0) > Date.now())).toBe(true)
    expect(getSpaceProviderCredentials('work', 'openai')?.entries[0].cooldownUntil).toBeUndefined()
  })

  it('请求旋钮跟家走:同家换手仍是首次那家的袋,接力到 API 换成 API 家自己设置里的袋', async () => {
    seedFamily([account('A'), account('B')], [entry('k1')])
    mocks.spaceSettings = {
      ai: { providers: { openai: { providerOptions: { request: { verbosity: 'low' } } } } },
    }
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'codex',
      currentEntryId: 'A',
      providerConfig: { model: 'gpt-5.5', providerOptions: { request: { verbosity: 'high' } } } as never,
      reprovision: trackingReprovision().fn as never,
    })!

    const sameFamily = await rotator(quotaError(), 1)
    expect(sameFamily?.providerOptions).toEqual({ codex: { verbosity: 'high' } })

    const crossed = await rotator(quotaError(), 2)
    // 键是接下来真收请求的那一家;订阅家那一格不跟过去(新 provider 本来也只读自己那一格)。
    expect(crossed?.providerOptions).toEqual({ openai: { verbosity: 'low' } })
  })

  it('开关关(providers.codex.subscriptionFallback = false)→ 订阅用完就停手,不接 API', () => {
    seedFamily([account('A')], [entry('k1')])
    mocks.spaceSettings = { ai: { providers: { codex: { model: 'm', selectedModels: [], subscriptionFallback: false } } } }
    // 只有 A 一条 + 开关关 = 序列最多走到一条 → 钩子不挂。
    expect(createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'codex',
      currentEntryId: 'A',
      reprovision: trackingReprovision().fn as never,
    })).toBeUndefined()
    // 同一个池、开关开(缺席 = 开)→ 挂。
    mocks.spaceSettings = {}
    expect(createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'codex',
      currentEntryId: 'A',
      reprovision: trackingReprovision().fn as never,
    })).toBeDefined()
  })

  it('发送前就已接力到 API(currentProviderId = openai):下一把仍在 API 那一池里换,不再换家', async () => {
    seedFamily([account('A', { cooldownUntil: Date.now() + 3_600_000, cooldownReason: 'quota' })], [entry('k1'), entry('k2')])
    const reprovision = trackingReprovision()
    const rotator = createSessionCredentialRotator({
      sessionId: 's1',
      providerId: 'codex',
      currentProviderId: 'openai',
      currentEntryId: 'k1',
      reprovision: reprovision.fn as never,
    })!
    const rotation = await rotator(paymentRequiredError(), 1)
    expect(rotation?.reason).toContain('配额耗尽')
    const seen = reprovision.seen[0] as ReprovisionOverride & { providerId?: string }
    expect(seen.providerId).toBeUndefined()
    expect(seen.apiKey).toBe('sk-k2')
    expect(seen.spaceCredential).toMatchObject({ entryId: 'k2', route: { providerId: 'openai' } })
  })
})

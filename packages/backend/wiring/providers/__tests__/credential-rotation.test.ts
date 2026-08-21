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
}))

vi.mock('../../auth/auth-service.js', () => ({
  authService: {
    refreshTokenIfNeeded: (providerId: string, target: unknown) => {
      mocks.refreshCalls.push({ providerId, target })
      return mocks.refreshImpl(providerId, target)
    },
  },
}))

vi.mock('../../../stores/settings.js', () => ({ getSettings: () => ({}) }))

vi.mock('../../../stores/sessions.js', async () => {
  const { DEFAULT_SPACE_ID, isValidSpaceId } = await import('@onething/runtime/spaces/types')
  return {
    resolveSessionSpaceId: (id: string | undefined | null) => {
      const workspaceId = id ? mocks.sessions.get(id)?.workspaceId : undefined
      return workspaceId && isValidSpaceId(workspaceId) ? workspaceId : DEFAULT_SPACE_ID
    },
  }
})

vi.mock('../registry.js', () => ({
  requiresOAuth: (id: string) => mocks.oauthProviders.has(id),
  getProviderInfo: (id: string) => ({ id, name: id.toUpperCase() }),
}))

vi.mock('@onething/runtime/spaces/store', () => ({
  getSpacesStore: () => ({ list: () => mocks.spaces }),
}))

import type { AgentProvider } from '@onething/core/agent-loop'
import {
  getSpaceProviderCredentials,
  resetSpaceCredentialRotationForTests,
  resetSpaceCredentialsCacheForTests,
  writeSpaceCredentials,
  type SpaceCredentialEntry,
} from '@onething/runtime/spaces/credentials'
import { setRootDirForTests } from '@onething/runtime/spaces/persistence'
import { createSessionCredentialRotator } from '../credential-rotation.js'

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

describe('挂不挂钩子:没有可换的就根本不挂', () => {
  it('默认空间(凭证源是 settings.ai,无池)', () => {
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
    const registry = await import('../credential-strategy.js')
    registry.resetPluginCredentialStrategiesForTests()
    registry.resetAppPluginCredentialStrategyHostForTests()
    registry.configureAppPluginCredentialStrategyHost()
    const health = await import('@onething/runtime/plugins/health')
    health.resetPluginRuntimeHealthForTests()
  })

  afterEach(async () => {
    const registry = await import('../credential-strategy.js')
    registry.resetAppPluginCredentialStrategyHostForTests()
    registry.resetPluginCredentialStrategiesForTests()
  })

  it('问策略、带上 attempt 与上一条的失败分类,并按它换手', async () => {
    const registry = await import('../credential-strategy.js')
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
    const registry = await import('../credential-strategy.js')
    const health = await import('@onething/runtime/plugins/health')
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
    const registry = await import('../credential-strategy.js')
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

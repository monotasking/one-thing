/**
 * 批 E 插件凭证策略注册表 —— 装配层(声明门 / 脱敏 / 超时 / 熔断 / 拆除)。
 *
 * 验收的重点全在**红线**上:插件看不见钥匙、策略坏掉不阻塞起流、拆掉之后
 * 用户的选择还在。「它能挑对一次」反而是最不值得多写的一条。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CORE_PLUGIN_FAILURE_THRESHOLD,
  PLUGIN_CREDENTIAL_ENTRY_FIELDS,
  PLUGIN_PERMISSION_CREDENTIAL_STRATEGY,
  PLUGIN_REGISTRY_POLICY,
  type CorePluginCredentialStrategyContext,
} from '@onething/core/plugins'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-cred-strategy-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

/** 账本是**佐料不是前提**:这里只喂一份固定记录,免得测试去碰真磁盘。 */
const ledgerRecords: unknown[] = []

vi.mock('../../usage/index.js', () => ({
  getUsageLedger: () => ({
    readRecordsInRange: async () => ledgerRecords,
  }),
}))

const bus = { emitGlobal: () => {}, onGlobal: () => () => {}, onAnySession: () => () => {} }

async function load() {
  vi.resetModules()
  const [api, registry, health, logging] = await Promise.all([
    import('../../plugins/api.js'),
    import('../credential-strategy.js'),
    import('@onething/runtime/plugins/health'),
    // `vi.resetModules()` 之后每次 load 都是一份新的 logging 单例 —— 捕获必须从
    // **同一份**里拿,否则收的是别的 root(L4)。
    import('../../logging/index.js'),
  ])
  registry.resetPluginCredentialStrategiesForTests()
  health.resetPluginRuntimeHealthForTests()
  ledgerRecords.length = 0
  return { api, registry, health, logging }
}

function makeApi(
  mods: Awaited<ReturnType<typeof load>>,
  pluginId: string,
  permissions: string[],
) {
  return mods.api.createPluginAPI(pluginId, bus as never, {} as never, {
    declaredPermissions: permissions,
  })
}

/** 一条真实形状的 entry —— **带着钥匙原文**,正是脱敏要拦下的东西。 */
function entry(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    label: `key ${id}`,
    authType: 'apiKey' as const,
    apiKey: `sk-secret-${id}`,
    source: 'user',
    baseUrl: `https://${id}.example.com`,
    apiMode: 'coding',
    ...extra,
  }
}

describe('批 E 凭证策略 —— 注册与声明门', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('registers under a namespaced policy value', async () => {
    const mods = await load()
    const { api } = makeApi(mods, 'balancer', [PLUGIN_PERMISSION_CREDENTIAL_STRATEGY])

    api.registerCredentialStrategy({
      name: 'least-used',
      title: '用得最少的优先',
      description: '按近 24h token 量挑最闲的那把。',
      select: ctx => ctx.entries[0].id,
    })

    // 与 registerTool / registerIMConnector / registerDeepLinkAction 同构:
    // 插件占不到一个全局名字,更抢不到三个内置策略名(它们不含冒号)。
    expect(mods.registry.listPluginCredentialStrategies()).toEqual([{
      policy: 'plugin:balancer:least-used',
      pluginId: 'balancer',
      name: 'least-used',
      title: '用得最少的优先',
      description: '按近 24h token 量挑最闲的那把。',
    }])
    expect(mods.registry.isPluginCredentialStrategyAvailable('plugin:balancer:least-used')).toBe(true)
  })

  it('refuses an undeclared plugin — structured rejection, no breaker', async () => {
    const mods = await load()
    const logs = mods.logging.collectLogRecordsForTests()
    const { api, state } = makeApi(mods, 'sneaky', [])

    const release = api.registerCredentialStrategy({
      name: 'grab',
      title: 'Grab',
      select: () => 'a',
    })

    expect(mods.registry.listPluginCredentialStrategies()).toEqual([])
    expect(() => release()).not.toThrow()
    expect(logs.messages().some(msg => msg.includes(PLUGIN_PERMISSION_CREDENTIAL_STRATEGY)))
      .toBe(true)
    // **不计熔断** —— manifest 笔误不该连坐插件的工具/命令/面板。
    expect(state.disposing).not.toBe(true)
    expect(mods.health.isPluginSurfaceDegraded('sneaky', 'credential-strategy:plugin:sneaky:grab'))
      .toBe(false)
    logs.stop()
  })

  it('refuses an illegal strategy name / missing pieces even when declared', async () => {
    const mods = await load()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { api } = makeApi(mods, 'p', [PLUGIN_PERMISSION_CREDENTIAL_STRATEGY])

    api.registerCredentialStrategy({ name: 'Least Used', title: 'x', select: () => 'a' })
    api.registerCredentialStrategy({ name: 'has:colon', title: 'x', select: () => 'a' })
    api.registerCredentialStrategy({ name: '', title: 'x', select: () => 'a' })
    api.registerCredentialStrategy({ name: 'ok', title: '', select: () => 'a' })
    api.registerCredentialStrategy({ name: 'ok', title: 'x' } as never)

    expect(mods.registry.listPluginCredentialStrategies()).toEqual([])
  })
})

describe('批 E 凭证策略 —— 红线 1:插件不见钥匙', () => {
  it('hands the strategy a whitelist projection only', async () => {
    const mods = await load()
    const { api } = makeApi(mods, 'peek', [PLUGIN_PERMISSION_CREDENTIAL_STRATEGY])
    let seen: CorePluginCredentialStrategyContext | undefined
    api.registerCredentialStrategy({
      name: 's',
      title: 'S',
      select: ctx => { seen = ctx; return ctx.entries[1].id },
    })

    const chosen = await mods.registry.refreshCredentialStrategyDecision({
      policy: 'plugin:peek:s',
      spaceId: 'work',
      providerId: 'deepseek',
      candidates: [entry('a'), entry('b', { oauthToken: { accessToken: 'tok' } })],
    })

    expect(chosen).toBe('b')
    expect(seen).toBeTruthy()
    // **正向断言**:每一条 entry 的键集合 ⊆ 白名单。反过来写("没有 apiKey")
    // 每加一个秘密字段就漏一次。
    for (const view of seen!.entries) {
      for (const key of Object.keys(view)) {
        expect(PLUGIN_CREDENTIAL_ENTRY_FIELDS as readonly string[]).toContain(key)
      }
    }
    // 整棵 ctx 序列化之后也不该出现任何一段钥匙原文/端点。
    const serialized = JSON.stringify(seen)
    expect(serialized).not.toContain('sk-secret-')
    expect(serialized).not.toContain('example.com')
    expect(serialized).not.toContain('accessToken')
    expect(serialized).not.toContain('coding')
    // 该给的都给了。
    expect(seen!.entries.map(view => view.id)).toEqual(['a', 'b'])
    expect(seen!.entries[0].label).toBe('key a')
    expect(seen!.entries[0].source).toBe('user')
    expect(seen!.providerId).toBe('deepseek')
    expect(seen!.spaceId).toBe('work')
    expect(seen!.attempt).toBe(1)
  })

  it('folds the ledger usage in, aggregated by credentialId', async () => {
    const mods = await load()
    const { api } = makeApi(mods, 'u', [PLUGIN_PERMISSION_CREDENTIAL_STRATEGY])
    const now = Date.now()
    ledgerRecords.push(
      {
        ts: now - 1000,
        providerId: 'deepseek',
        workspaceId: 'work',
        credentialId: 'a',
        modelId: 'm',
        platform: 'electron',
        source: 'chat',
        billing: 'api',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 15 },
        costUSD: 0.25,
      },
      // 另一个 provider 的行不该算进来。
      {
        ts: now - 1000,
        providerId: 'claude',
        workspaceId: 'work',
        credentialId: 'a',
        modelId: 'm',
        platform: 'electron',
        source: 'chat',
        billing: 'api',
        usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 1998 },
        costUSD: 9,
      },
    )
    let seen: CorePluginCredentialStrategyContext | undefined
    api.registerCredentialStrategy({
      name: 's',
      title: 'S',
      select: ctx => { seen = ctx; return ctx.entries[0].id },
    })

    await mods.registry.refreshCredentialStrategyDecision({
      policy: 'plugin:u:s',
      spaceId: 'work',
      providerId: 'deepseek',
      candidates: [entry('a'), entry('b')],
      now,
    })

    expect(seen!.entries[0].usage).toEqual({
      requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.25,
    })
    // 账本里查不到 = 全零,不是"未知"。
    expect(seen!.entries[1].usage).toEqual({
      requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0,
    })
    expect(seen!.usageWindowMs).toBe(mods.registry.PLUGIN_CREDENTIAL_USAGE_WINDOW_MS)
  })
})

describe('批 E 凭证策略 —— 红线 2:失效不阻塞,只记账', () => {
  it('rejects an id that is not among the candidates, and bills it', async () => {
    const mods = await load()
    const { api } = makeApi(mods, 'liar', [PLUGIN_PERMISSION_CREDENTIAL_STRATEGY])
    api.registerCredentialStrategy({ name: 's', title: 'S', select: () => 'nope' })

    const chosen = await mods.registry.refreshCredentialStrategyDecision({
      policy: 'plugin:liar:s',
      spaceId: 'work',
      providerId: 'deepseek',
      candidates: [entry('a')],
    })

    expect(chosen).toBeUndefined()
    expect(mods.health.getPluginRuntimeHealth('liar')?.lastError).toMatch(/not among/)
  })

  it('treats a cooling id exactly like an unknown one — 候选集里本来就没有它', async () => {
    const mods = await load()
    const { api } = makeApi(mods, 'cold', [PLUGIN_PERMISSION_CREDENTIAL_STRATEGY])
    api.registerCredentialStrategy({ name: 's', title: 'S', select: () => 'cooling' })

    // 调用方(分叉点 / 轮换钩子)传进来的候选集已经剔过冷却,所以策略指名一条
    // 冷却中的 entry,在这里表现为"指了一个不在集合里的 id"。一条判据覆盖两种错法。
    const chosen = await mods.registry.refreshCredentialStrategyDecision({
      policy: 'plugin:cold:s',
      spaceId: 'work',
      providerId: 'deepseek',
      candidates: [entry('warm')],
    })

    expect(chosen).toBeUndefined()
    expect(mods.health.getPluginRuntimeHealth('cold')?.lastError).toMatch(/not among/)
  })

  it('times out a strategy that never settles, and bills it', async () => {
    const mods = await load()
    const { api } = makeApi(mods, 'slow', [PLUGIN_PERMISSION_CREDENTIAL_STRATEGY])
    api.registerCredentialStrategy({
      name: 'hang',
      title: 'Hang',
      select: () => new Promise<string>(() => {}),
    })

    const chosen = await mods.registry.refreshCredentialStrategyDecision({
      policy: 'plugin:slow:hang',
      spaceId: 'work',
      providerId: 'deepseek',
      candidates: [entry('a')],
      timeoutMs: 10,
    })

    expect(chosen).toBeUndefined()
    expect(mods.health.getPluginRuntimeHealth('slow')?.lastError).toMatch(/timed out/)
  })

  it('degrades THIS strategy after repeated failures and stops calling it', async () => {
    const mods = await load()
    const { api } = makeApi(mods, 'flaky', [PLUGIN_PERMISSION_CREDENTIAL_STRATEGY])
    let calls = 0
    api.registerCredentialStrategy({
      name: 'boom',
      title: 'Boom',
      select: () => { calls += 1; throw new Error('nope') },
    })
    api.registerCredentialStrategy({
      name: 'fine',
      title: 'Fine',
      select: ctx => ctx.entries[0].id,
    })

    for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) {
      await mods.registry.refreshCredentialStrategyDecision({
        policy: 'plugin:flaky:boom',
        spaceId: 'work',
        providerId: 'deepseek',
        candidates: [entry('a')],
      })
    }
    expect(calls).toBe(CORE_PLUGIN_FAILURE_THRESHOLD)

    // 降级之后**连 handler 都不调** —— 每次起流白等一个超时预算是这条路径上最贵的浪费。
    expect(mods.registry.isPluginCredentialStrategyAvailable('plugin:flaky:boom')).toBe(false)
    await mods.registry.refreshCredentialStrategyDecision({
      policy: 'plugin:flaky:boom',
      spaceId: 'work',
      providerId: 'deepseek',
      candidates: [entry('a')],
    })
    expect(calls).toBe(CORE_PLUGIN_FAILURE_THRESHOLD)

    // 同一个插件的另一条策略照常 —— 降级的粒度是策略,不是插件。
    expect(mods.registry.isPluginCredentialStrategyAvailable('plugin:flaky:fine')).toBe(true)
    await expect(mods.registry.refreshCredentialStrategyDecision({
      policy: 'plugin:flaky:fine',
      spaceId: 'work',
      providerId: 'deepseek',
      candidates: [entry('a')],
    })).resolves.toBe('a')
  })

  it('says undefined for a policy nobody registered — 不记熔断(没装 ≠ 运行期失败)', async () => {
    const mods = await load()
    const chosen = await mods.registry.refreshCredentialStrategyDecision({
      policy: 'plugin:ghost:s',
      spaceId: 'work',
      providerId: 'deepseek',
      candidates: [entry('a')],
    })
    expect(chosen).toBeUndefined()
    expect(mods.health.getPluginRuntimeHealth('ghost')).toBeUndefined()
  })
})

describe('批 E 凭证策略 —— 拆除', () => {
  it('ignores a replaced registration after its select finishes and preserves the successor decision', async () => {
    const mods = await load()
    const { CredentialStrategyService } = await import('../credential-strategy-lifetime.js')
    const service = new CredentialStrategyService()
    const credentials = await import('@onething/runtime/spaces/credentials')
    mods.registry.configureAppPluginCredentialStrategyHost()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let release!: (choice: string) => void
    const oldResult = new Promise<string>(resolve => { release = resolve })
    let oldSignal: AbortSignal | undefined
    const unregister = mods.registry.registerPluginCredentialStrategy('replace', {
      name: 'pick', title: 'Old', select: ctx => { oldSignal = ctx.signal; entered(); return oldResult },
    }, service.createScope())
    const input = { policy: 'plugin:replace:pick', spaceId: 'work', providerId: 'deepseek', candidates: [entry('a'), entry('b')] }
    const first = mods.registry.refreshCredentialStrategyDecision(input)
    await started
    try {
      mods.registry.registerPluginCredentialStrategy('replace', {
        name: 'pick', title: 'New', select: () => 'b',
      }, service.createScope())
      expect(oldSignal?.aborted).toBe(true)
      await expect(first).resolves.toBeUndefined()
      await expect(mods.registry.refreshCredentialStrategyDecision(input)).resolves.toBe('b')
      unregister()
      release('a')
      await Promise.resolve()
      expect(credentials.selectSpaceCredentialEntryDetailed({ entries: input.candidates, policy: input.policy }, {
        providerId: input.providerId, spaceId: input.spaceId, now: Date.now(),
      })).toMatchObject({ entry: { id: 'b' }, pluginPolicy: { applied: true } })
    } finally {
      release('a')
      service.quiesce()
      await service.drain()
      mods.registry.resetAppPluginCredentialStrategyHostForTests()
    }
  })

  it('unregisters on release and on dispose, and drops the stale decision with it', async () => {
    const mods = await load()
    const { api, state } = makeApi(mods, 'b', [PLUGIN_PERMISSION_CREDENTIAL_STRATEGY])

    const release = api.registerCredentialStrategy({
      name: 'a', title: 'A', select: ctx => ctx.entries[0].id,
    })
    api.registerCredentialStrategy({ name: 'b', title: 'B', select: ctx => ctx.entries[0].id })
    expect(mods.registry.listPluginCredentialStrategies()).toHaveLength(2)

    release()
    expect(mods.registry.listPluginCredentialStrategies().map(s => s.name)).toEqual(['b'])

    // 插件自己不调 release 也要拆干净 —— 拆除不建立在插件守规矩上。
    mods.api.disposePlugin(state)
    expect(mods.registry.listPluginCredentialStrategies()).toEqual([])
    expect(mods.registry.isPluginCredentialStrategyAvailable('plugin:b:a')).toBe(false)
  })

  it('declares degrade-to-default and actually degrades to the built-in default', async () => {
    /*
     * R7 第一版把 im-connector 标成 degrade-to-default 而实现是 throw,
     * 而当时的测试只断言"理由字符串长度 > 20"。这里把标签与行为绑死:
     * 策略撤下之后,**选择仍然成功**(回落内置 failover),而不是失败。
     */
    const mods = await load()
    const credentials = await import('@onething/runtime/spaces/credentials')
    mods.registry.resetAppPluginCredentialStrategyHostForTests()
    mods.registry.configureAppPluginCredentialStrategyHost()

    const { api, state } = makeApi(mods, 'b', [PLUGIN_PERMISSION_CREDENTIAL_STRATEGY])
    api.registerCredentialStrategy({
      name: 'pick-last',
      title: 'Pick last',
      select: ctx => ctx.entries[ctx.entries.length - 1].id,
    })

    const pool = {
      entries: [entry('a'), entry('b')],
      policy: 'plugin:b:pick-last',
    }
    const options = { spaceId: 'work', providerId: 'deepseek' }

    // 第一次是冷的(还没有裁决)—— 回落 failover,并排一次异步刷新。
    expect(credentials.selectSpaceCredentialEntryDetailed(pool, options))
      .toMatchObject({ entry: { id: 'a' }, pluginPolicy: { applied: false } })
    await mods.registry.flushPluginCredentialStrategyRefreshForTests()
    // 刷新之后策略说了算。
    expect(credentials.selectSpaceCredentialEntryDetailed(pool, options))
      .toMatchObject({ entry: { id: 'b' }, pluginPolicy: { applied: true } })

    expect(PLUGIN_REGISTRY_POLICY['credential-strategy'].teardown).toBe('degrade-to-default')
    mods.api.disposePlugin(state)

    // 拆除之后:**调用仍然成功**,只是挑法换回内置的 priority-failover。
    const after = credentials.selectSpaceCredentialEntryDetailed(pool, options)
    expect(after.entry?.id).toBe('a')
    expect(after.exhausted).toBeUndefined()
    // 而**用户存下的 policy 字段一个字节都没改** —— 插件回来自动生效。
    expect(pool.policy).toBe('plugin:b:pick-last')

    mods.registry.resetAppPluginCredentialStrategyHostForTests()
  })

  it('states honestly that the registry carries no production traffic yet', async () => {
    const policy = PLUGIN_REGISTRY_POLICY['credential-strategy']
    expect(policy.hasProductionTraffic).toBe(false)
    expect(policy.trafficNote).toContain('无生产流量')
    expect(policy.inFlight).toContain('policy')
  })
})

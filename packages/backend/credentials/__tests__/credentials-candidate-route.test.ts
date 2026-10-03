/**
 * `pickRoute`(批 6 §9.1)—— 一条候选序列,顺序逐字照正本。
 *
 * 夹具里的两家是**虚构的**(`acme-sub` / `acme-api`),manifest 只填 `billing` / `sibling` /
 * `auth` 这几格:决策函数只读字段,认不出任何真实服务商的名字 —— 这正是 §9.4 演练要的。
 */
import { describe, expect, it } from 'vitest'
import type { ProviderQuota } from '@shared/contracts/quota.js'
import type { ProviderManifest } from '@onething/backend/provider'
import type { SpaceCredentialEntry, SpaceProviderCredentials } from '../credentials-pool.js'
import { pickRoute, remainingQuotaPercent, type PickRouteInput } from '../credentials-candidate-route.js'

const NOW = 1_800_000_000_000

function manifest(id: string, over: Partial<ProviderManifest>): ProviderManifest {
  return {
    id,
    origin: 'builtin',
    name: id,
    description: '',
    icon: id,
    dialect: 'openai-chat',
    auth: { kind: 'apiKey' },
    models: { kind: 'none' },
    billing: 'api',
    modelRules: 'openai',
    defaultBaseUrl: 'https://example.invalid',
    supportsCustomBaseUrl: true,
    defaultModel: 'm',
    ...over,
  }
}

const MANIFESTS: Record<string, ProviderManifest> = {
  'acme-sub': manifest('acme-sub', {
    auth: { kind: 'oauth', flow: 'pkce-callback' },
    billing: 'subscription',
    sibling: 'acme-api',
  }),
  'acme-api': manifest('acme-api', { sibling: 'acme-sub' }),
  // 另一家(不是 sibling):永远不进 acme 的候选。
  'other-api': manifest('other-api', {}),
  // 订阅接订阅不是「按 API 计费」:sibling 指向另一个订阅家时不接。
  'twin-sub': manifest('twin-sub', {
    auth: { kind: 'oauth', flow: 'device-code' },
    billing: 'subscription',
    sibling: 'twin-sub-2',
  }),
  'twin-sub-2': manifest('twin-sub-2', {
    auth: { kind: 'oauth', flow: 'device-code' },
    billing: 'subscription',
  }),
  agent: manifest('agent', { auth: { kind: 'none' } }),
}

const oauth = (id: string, over: Partial<SpaceCredentialEntry> = {}): SpaceCredentialEntry => ({
  id, label: id, authType: 'oauth', oauthToken: { accessToken: `at-${id}` }, source: 'user', ...over,
})
const key = (id: string, over: Partial<SpaceCredentialEntry> = {}): SpaceCredentialEntry => ({
  id, label: id, authType: 'apiKey', apiKey: `sk-${id}`, source: 'user', ...over,
})
const windows = (...used: Array<number | [number, number]>): ProviderQuota => ({
  kind: 'windows',
  fetchedAt: NOW,
  windows: used.map((value, index) => {
    const [usedPercent, resetsAt] = Array.isArray(value) ? value : [value, NOW + 3_600_000]
    return { id: index === 0 ? '5h' : '7d', seconds: index === 0 ? 18_000 : 604_800, usedPercent, resetsAt }
  }),
})

function input(over: {
  providerId?: string
  pools?: Record<string, SpaceProviderCredentials>
  quotas?: Record<string, ProviderQuota>
  disabled?: string[]
  subscriptionFallback?: boolean
  cursor?: Record<string, number>
  pluginDecide?: PickRouteInput['pluginDecide']
  now?: number
}): PickRouteInput {
  return {
    providerId: over.providerId ?? 'acme-sub',
    spaceId: 'space-a',
    now: over.now ?? NOW,
    manifests: id => MANIFESTS[id],
    pools: id => over.pools?.[id],
    quotas: (providerId, entryId) => over.quotas?.[`${providerId}/${entryId}`],
    enabled: id => !(over.disabled ?? []).includes(id),
    subscriptionFallback: over.subscriptionFallback ?? true,
    roundRobinCursor: id => over.cursor?.[id] ?? 0,
    ...(over.pluginDecide ? { pluginDecide: over.pluginDecide } : {}),
  }
}

const ids = (route: ReturnType<typeof pickRoute>) => route.map(c => `${c.providerId}/${c.entryId}:${c.reason}`)

describe('pickRoute —— 订阅家', () => {
  it('门 ①:A 窗口 100%(配额冷却)、B 40% → 选 B', () => {
    const route = pickRoute(input({
      pools: {
        'acme-sub': { policy: 'single', entries: [
          oauth('A', { cooldownUntil: NOW + 3_600_000, cooldownReason: 'quota' }),
          oauth('B'),
        ] },
        'acme-api': { policy: 'priority-failover', entries: [key('k1')] },
      },
      quotas: { 'acme-sub/A': windows(100), 'acme-sub/B': windows(40) },
    }))
    expect(ids(route)[0]).toBe('acme-sub/B:subscription')
  })

  it('quota-remaining:账号按「最紧窗口的剩余量」从多到少排;没数据的垫后、按池内顺序', () => {
    const route = pickRoute(input({
      pools: { 'acme-sub': { policy: 'quota-remaining', entries: [oauth('nodata1'), oauth('A'), oauth('nodata2'), oauth('B')] } },
      // A:5h 用了 20、周窗用了 90 → 最紧剩 10;B:剩 60。
      quotas: { 'acme-sub/A': windows(20, 90), 'acme-sub/B': windows(40, 10) },
      subscriptionFallback: false,
    }))
    expect(ids(route)).toEqual([
      'acme-sub/B:subscription',
      'acme-sub/A:subscription',
      'acme-sub/nodata1:subscription',
      'acme-sub/nodata2:subscription',
    ])
  })

  it('门 ②:A/B 都满、开关开 → 同家 API 第一把接在订阅后面(reason = sibling-api)', () => {
    const cooled = { cooldownUntil: NOW + 3_600_000, cooldownReason: 'quota' as const }
    const route = pickRoute(input({
      pools: {
        'acme-sub': { policy: 'single', entries: [oauth('A', cooled), oauth('B', cooled)] },
        'acme-api': { policy: 'priority-failover', entries: [key('k1'), key('k2')] },
      },
    }))
    expect(ids(route)).toEqual(['acme-api/k1:sibling-api', 'acme-api/k2:sibling-api'])
  })

  it('订阅还有可用账号时,API 密钥排在它们后面(不抢先)', () => {
    const route = pickRoute(input({
      pools: {
        'acme-sub': { policy: 'single', entries: [oauth('A')] },
        'acme-api': { policy: 'priority-failover', entries: [key('k1')] },
      },
    }))
    expect(ids(route)).toEqual(['acme-sub/A:subscription', 'acme-api/k1:sibling-api'])
  })

  it('门 ③:开关关 → 订阅都满时序列为空(调用方照旧报「全部冷却」)', () => {
    const cooled = { cooldownUntil: NOW + 3_600_000 }
    const route = pickRoute(input({
      subscriptionFallback: false,
      pools: {
        'acme-sub': { policy: 'single', entries: [oauth('A', cooled), oauth('B', cooled)] },
        'acme-api': { policy: 'priority-failover', entries: [key('k1')] },
      },
    }))
    expect(route).toEqual([])
  })

  it('门 ④:窗口 resets_at 已过、冷却到期 → 回到 A(缓存里那份 100% 的旧读数按「用了 0」算)', () => {
    const later = NOW + 2 * 3_600_000
    const route = pickRoute(input({
      now: later,
      pools: {
        'acme-sub': { policy: 'single', entries: [
          oauth('A', { cooldownUntil: NOW + 3_600_000, cooldownReason: 'quota' }),
          oauth('B'),
        ] },
      },
      quotas: { 'acme-sub/A': windows([100, NOW + 3_600_000]), 'acme-sub/B': windows(40) },
    }))
    expect(ids(route)[0]).toBe('acme-sub/A:subscription')
  })

  it('从没登录过(池里没有可用账号)时不悄悄改走 API', () => {
    const route = pickRoute(input({
      pools: { 'acme-api': { policy: 'priority-failover', entries: [key('k1')] } },
    }))
    expect(route).toEqual([])
  })

  it('停用硬过滤:目标家停用 = 空;同家 API 停用 = 不接', () => {
    const pools = {
      'acme-sub': { policy: 'single', entries: [oauth('A', { cooldownUntil: NOW + 1_000 })] },
      'acme-api': { policy: 'priority-failover', entries: [key('k1')] },
    }
    expect(pickRoute(input({ pools, disabled: ['acme-sub'] }))).toEqual([])
    expect(pickRoute(input({ pools, disabled: ['acme-api'] }))).toEqual([])
  })

  it('跨家不接:sibling 若也是订阅家,不接;非 sibling 的家永远不出现', () => {
    const route = pickRoute(input({
      providerId: 'twin-sub',
      pools: {
        'twin-sub': { policy: 'single', entries: [oauth('A', { cooldownUntil: NOW + 1_000 })] },
        'twin-sub-2': { policy: 'single', entries: [oauth('Z')] },
        'other-api': { policy: 'priority-failover', entries: [key('x')] },
      },
    }))
    expect(route).toEqual([])
  })
})

describe('pickRoute —— 订阅家按池策略(批 9 §10)', () => {
  const pool = (policy: string, ...entries: SpaceCredentialEntry[]) => ({ 'acme-sub': { policy, entries } })
  const solo = { subscriptionFallback: false }

  it('门 ①:priority-failover A 用 40% / B 用 10% → 选 A(顺序优先,不看余量)', () => {
    expect(ids(pickRoute(input({
      ...solo,
      pools: pool('priority-failover', oauth('A'), oauth('B')),
      quotas: { 'acme-sub/A': windows(40), 'acme-sub/B': windows(10) },
    })))).toEqual(['acme-sub/A:subscription', 'acme-sub/B:subscription'])
  })

  it('门 ①:A 满了(配额冷却已写)→ B', () => {
    expect(ids(pickRoute(input({
      ...solo,
      pools: pool('priority-failover', oauth('A', { cooldownUntil: NOW + 3_600_000, cooldownReason: 'quota' }), oauth('B')),
      quotas: { 'acme-sub/A': windows(100), 'acme-sub/B': windows(10) },
    })))).toEqual(['acme-sub/B:subscription'])
  })

  it('门 ①:A 满了而冷却还没写上(30 秒去抖的空窗)→ 也当用完,选 B', () => {
    expect(ids(pickRoute(input({
      ...solo,
      pools: pool('priority-failover', oauth('A'), oauth('B')),
      quotas: { 'acme-sub/A': windows(10, 100), 'acme-sub/B': windows(10) },
    })))).toEqual(['acme-sub/B:subscription'])
  })

  it('门 ①:A 的窗口重置(resets_at 已过、冷却到期)→ 回到 A', () => {
    const resetAt = NOW + 3_600_000
    expect(ids(pickRoute(input({
      ...solo,
      now: resetAt + 1,
      pools: pool('priority-failover', oauth('A', { cooldownUntil: resetAt, cooldownReason: 'quota' }), oauth('B')),
      quotas: { 'acme-sub/A': windows([100, resetAt]), 'acme-sub/B': windows([10, NOW + 99 * 3_600_000]) },
    })))[0]).toBe('acme-sub/A:subscription')
  })

  it('门 ②:quota-remaining A 用 40% / B 用 10% → 选 B', () => {
    expect(ids(pickRoute(input({
      ...solo,
      pools: pool('quota-remaining', oauth('A'), oauth('B')),
      quotas: { 'acme-sub/A': windows(40), 'acme-sub/B': windows(10) },
    })))[0]).toBe('acme-sub/B:subscription')
  })

  it('门 ③:round-robin 两个账号随游标交替', () => {
    const at = (cursor: number) => ids(pickRoute(input({
      ...solo,
      cursor: { 'acme-sub': cursor },
      pools: pool('round-robin', oauth('A'), oauth('B')),
      quotas: { 'acme-sub/A': windows(40), 'acme-sub/B': windows(10) },
    })))[0]
    expect([at(0), at(1), at(2)]).toEqual(['acme-sub/A:subscription', 'acme-sub/B:subscription', 'acme-sub/A:subscription'])
  })

  it('single:只取第一条没歇着的账号', () => {
    expect(ids(pickRoute(input({
      ...solo,
      pools: pool('single', oauth('A'), oauth('B')),
      quotas: { 'acme-sub/A': windows(90), 'acme-sub/B': windows(0) },
    })))).toEqual(['acme-sub/A:subscription'])
  })

  it('门 ④(纯函数版):同一份事实,换策略立刻换答案', () => {
    const facts = { ...solo, quotas: { 'acme-sub/A': windows(40), 'acme-sub/B': windows(10) } }
    expect(ids(pickRoute(input({ ...facts, pools: pool('priority-failover', oauth('A'), oauth('B')) })))[0])
      .toBe('acme-sub/A:subscription')
    expect(ids(pickRoute(input({ ...facts, pools: pool('quota-remaining', oauth('A'), oauth('B')) })))[0])
      .toBe('acme-sub/B:subscription')
  })

  it('没写策略的老池按缺省 priority-failover 读(normalize 之前的形状由解析层补)', () => {
    // 盘上解析(`parseSpaceCredentials`)把缺席补成 DEFAULT = priority-failover;这里直接喂那个值。
    expect(ids(pickRoute(input({
      ...solo,
      pools: pool('priority-failover', oauth('A'), oauth('B')),
      quotas: { 'acme-sub/B': windows(0) },
    })))[0]).toBe('acme-sub/A:subscription')
  })
})

describe('pickRoute —— API 家按池策略', () => {
  it('quota-remaining:有余额按余额多的优先,没数据的垫后按池序', () => {
    const balance = (available: number): ProviderQuota => ({ kind: 'balance', currency: 'CNY', available, fetchedAt: NOW })
    expect(ids(pickRoute(input({
      providerId: 'acme-api',
      pools: { 'acme-api': { policy: 'quota-remaining', entries: [key('k1'), key('k2'), key('k3')] } },
      quotas: { 'acme-api/k1': balance(5), 'acme-api/k3': balance(80) },
    })))).toEqual(['acme-api/k3:api', 'acme-api/k1:api', 'acme-api/k2:api'])
  })

  it('quota-remaining:一池都没余额数据 → 退化为 priority-failover(池序、跳过冷却)', () => {
    expect(ids(pickRoute(input({
      providerId: 'acme-api',
      pools: { 'acme-api': { policy: 'quota-remaining', entries: [key('k1', { cooldownUntil: NOW + 1_000 }), key('k2'), key('k3')] } },
    })))).toEqual(['acme-api/k2:api', 'acme-api/k3:api'])
  })

  it('门 ⑤:priority-failover 两把,第一把在冷却(402 之后)→ 第二把', () => {
    const route = pickRoute(input({
      providerId: 'acme-api',
      pools: { 'acme-api': { policy: 'priority-failover', entries: [key('k1', { cooldownUntil: NOW + 300_000 }), key('k2')] } },
    }))
    expect(ids(route)).toEqual(['acme-api/k2:api'])
  })

  it('single 只取第一条可用(第一条没填密钥 = 没有,不越过它)', () => {
    expect(ids(pickRoute(input({
      providerId: 'acme-api',
      pools: { 'acme-api': { policy: 'single', entries: [key('k1'), key('k2')] } },
    })))).toEqual(['acme-api/k1:api'])
    expect(pickRoute(input({
      providerId: 'acme-api',
      pools: { 'acme-api': { policy: 'single', entries: [key('k1', { apiKey: '' }), key('k2')] } },
    }))).toEqual([])
  })

  it('round-robin 从游标起转一圈', () => {
    const route = pickRoute(input({
      providerId: 'acme-api',
      cursor: { 'acme-api': 4 },
      pools: { 'acme-api': { policy: 'round-robin', entries: [key('k1'), key('k2'), key('k3')] } },
    }))
    expect(ids(route)).toEqual(['acme-api/k2:api', 'acme-api/k3:api', 'acme-api/k1:api'])
  })

  it('插件策略:它挑的那条排最前,其余按池内顺序兜底;挑了不存在的 = 纯 failover', () => {
    const pools = { 'acme-api': { policy: 'plugin:acme:pick', entries: [key('k1'), key('k2'), key('k3')] } }
    expect(ids(pickRoute(input({ providerId: 'acme-api', pools, pluginDecide: () => 'k3' }))))
      .toEqual(['acme-api/k3:api', 'acme-api/k1:api', 'acme-api/k2:api'])
    expect(ids(pickRoute(input({ providerId: 'acme-api', pools, pluginDecide: () => 'ghost' }))))
      .toEqual(['acme-api/k1:api', 'acme-api/k2:api', 'acme-api/k3:api'])
  })

  it('API 家不接任何别家(它的 sibling 是订阅那一半,不是兜底)', () => {
    const route = pickRoute(input({
      providerId: 'acme-api',
      pools: {
        'acme-api': { policy: 'priority-failover', entries: [key('k1', { cooldownUntil: NOW + 1_000 })] },
        'acme-sub': { policy: 'single', entries: [oauth('A')] },
      },
    }))
    expect(route).toEqual([])
  })

  it('不登录的家(外部执行体)没有候选', () => {
    expect(pickRoute(input({ providerId: 'agent', pools: { agent: { policy: 'single', entries: [key('x')] } } })))
      .toEqual([])
  })
})

describe('remainingQuotaPercent', () => {
  it('只看主窗口(不带 label 的);附加窗口不拖累整个账号', () => {
    const quota: ProviderQuota = {
      kind: 'windows',
      fetchedAt: NOW,
      windows: [
        { id: '5h', seconds: 18_000, usedPercent: 30 },
        { id: 'sonnet:7d', seconds: 604_800, usedPercent: 100, label: 'Sonnet' },
      ],
    }
    expect(remainingQuotaPercent(quota, NOW)).toBe(70)
  })

  it('余额 / 不支持 / 错误 = 没有窗口数据', () => {
    expect(remainingQuotaPercent({ kind: 'balance', currency: 'USD', available: 3, fetchedAt: NOW }, NOW)).toBeUndefined()
    expect(remainingQuotaPercent({ kind: 'unsupported' }, NOW)).toBeUndefined()
    expect(remainingQuotaPercent(undefined, NOW)).toBeUndefined()
  })
})

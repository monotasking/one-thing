/**
 * 批 E 凭证策略 —— core 侧的**契约**(命名空间 / 白名单投影 / 合法性判据)。
 *
 * 这个文件里没有一行涉及空间、账本或插件运行期:那些住在装配层。这里钉的是
 * 「什么形状算合法」与「投影之后还剩什么」——红线 1 的执行点。
 */
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_CREDENTIAL_ENTRY_FIELDS,
  PLUGIN_CREDENTIAL_STRATEGY_NAME_PATTERN,
  PLUGIN_CREDENTIAL_STRATEGY_PERMISSION_NOTE,
  PLUGIN_CREDENTIAL_STRATEGY_TIMEOUT_MS,
  PLUGIN_PERMISSION_CREDENTIAL_STRATEGY,
  emptyPluginCredentialUsage,
  isPluginCredentialChoiceValid,
  isPluginCredentialStrategyPolicy,
  parsePluginCredentialStrategyPolicy,
  pluginCredentialStrategyPolicy,
  pluginCredentialStrategySurface,
  toPluginCredentialEntryView,
} from '../credential-strategy.js'
import { describePluginPermission } from '../sessions.js'
import { describePluginSurface, pluginScope, resolvePluginScopeSeverity } from '../policy.js'

describe('批 E 凭证策略 —— 命名空间', () => {
  it('namespaces the policy value under plugin:<id>:<name>', () => {
    expect(pluginCredentialStrategyPolicy('balancer', 'least-used'))
      .toBe('plugin:balancer:least-used')
  })

  it('cannot collide with the three built-in policy names (they carry no colon)', () => {
    for (const builtin of ['single', 'priority-failover', 'round-robin']) {
      expect(isPluginCredentialStrategyPolicy(builtin)).toBe(false)
    }
  })

  it('accepts only well-shaped policy values', () => {
    expect(isPluginCredentialStrategyPolicy('plugin:my-plugin:least-used')).toBe(true)
    expect(isPluginCredentialStrategyPolicy('plugin:my.plugin_2:a1')).toBe(true)
    // 名字必须是窄形状 —— 它要落进 credentials.json 并被人眼读。
    expect(isPluginCredentialStrategyPolicy('plugin:p:Least-Used')).toBe(false)
    expect(isPluginCredentialStrategyPolicy('plugin:p:has space')).toBe(false)
    expect(isPluginCredentialStrategyPolicy('plugin:p')).toBe(false)
    expect(isPluginCredentialStrategyPolicy('plugin:p:a:b')).toBe(false)
    expect(isPluginCredentialStrategyPolicy('plugin::a')).toBe(false)
    expect(isPluginCredentialStrategyPolicy('other:p:a')).toBe(false)
    expect(isPluginCredentialStrategyPolicy(undefined)).toBe(false)
    expect(isPluginCredentialStrategyPolicy(42)).toBe(false)
  })

  it('parses back the pieces, or refuses', () => {
    expect(parsePluginCredentialStrategyPolicy('plugin:b:least-used'))
      .toEqual({ pluginId: 'b', name: 'least-used' })
    expect(parsePluginCredentialStrategyPolicy('single')).toBeNull()
  })

  it('keeps the surface ruler identical on both sides', () => {
    const policy = 'plugin:b:least-used'
    // 一边报账(policy.ts 的 describePluginSurface),一边据它短路
    // (装配层的 isPluginCredentialStrategyAvailable)。不能各写各的。
    expect(describePluginSurface(pluginScope.credentialStrategy(policy)))
      .toBe(pluginCredentialStrategySurface(policy))
  })

  it('bills the failure as degrade-surface, never disable-plugin', () => {
    const resolved = resolvePluginScopeSeverity(pluginScope.credentialStrategy('plugin:b:s'))
    expect(resolved.family).toBe('credential-strategy')
    // 它坐在起流的关键路径上 —— 升级成 disable-plugin 等于让一个坏策略挡住发消息。
    expect(resolved.remedy).toBe('degrade-surface')
    expect(resolved.surface).toBe('credential-strategy:plugin:b:s')
  })
})

describe('批 E 凭证策略 —— 红线 1:白名单投影', () => {
  const raw = {
    id: 'cred-1',
    label: '主力',
    authType: 'apiKey' as const,
    apiKey: 'sk-super-secret',
    oauthToken: { accessToken: 'tok', refreshToken: 'r' },
    source: 'user',
    cooldownUntil: 1234,
    baseUrl: 'https://private.example.com',
    apiMode: 'coding',
  }

  it('projects forward: only whitelisted keys survive', () => {
    const view = toPluginCredentialEntryView(raw)
    // **正向断言** —— 「键集合 ⊆ 白名单」。反过来写("没有 apiKey")每加一个
    // 秘密字段就漏一次。
    for (const key of Object.keys(view)) {
      expect(PLUGIN_CREDENTIAL_ENTRY_FIELDS as readonly string[]).toContain(key)
    }
    expect(view).toEqual({
      id: 'cred-1',
      label: '主力',
      authType: 'apiKey',
      source: 'user',
      cooldownUntil: 1234,
      usage: emptyPluginCredentialUsage(),
    })
    expect(JSON.stringify(view)).not.toContain('secret')
    expect(JSON.stringify(view)).not.toContain('example.com')
  })

  it('falls back honestly when the source is thin', () => {
    const view = toPluginCredentialEntryView({ id: 'x', authType: 'oauth' })
    expect(view.label).toBe('x')
    expect(view.source).toBe('user')
    expect(view.cooldownUntil).toBeUndefined()
    // 账本里查不到 = 全零,不是"未知"。
    expect(view.usage).toEqual({
      requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0,
    })
  })

  it('carries usage and lastErrorKind when the host has them', () => {
    const view = toPluginCredentialEntryView(raw, {
      usage: { requests: 3, inputTokens: 10, outputTokens: 4, totalTokens: 14, costUSD: 0.5 },
      lastErrorKind: 'rate-limited',
    })
    expect(view.usage.requests).toBe(3)
    expect(view.lastErrorKind).toBe('rate-limited')
    for (const key of Object.keys(view)) {
      expect(PLUGIN_CREDENTIAL_ENTRY_FIELDS as readonly string[]).toContain(key)
    }
  })

  it('drops a non-finite cooldown rather than passing NaN through', () => {
    expect(toPluginCredentialEntryView({
      id: 'x', authType: 'apiKey', cooldownUntil: Number.NaN,
    }).cooldownUntil).toBeUndefined()
  })
})

describe('批 E 凭证策略 —— 返回值合法性', () => {
  const entries = [{ id: 'a' }, { id: 'b' }]

  it('accepts an id that is among the candidates', () => {
    expect(isPluginCredentialChoiceValid('b', entries)).toBe(true)
  })

  it('refuses everything else — one verdict for every way of being wrong', () => {
    // 「不认识的 id」与「冷却中的 id」在这里同归一路:候选集里本来就没有冷却中的条目。
    expect(isPluginCredentialChoiceValid('cooling-one', entries)).toBe(false)
    expect(isPluginCredentialChoiceValid('', entries)).toBe(false)
    expect(isPluginCredentialChoiceValid('  ', entries)).toBe(false)
    expect(isPluginCredentialChoiceValid(undefined, entries)).toBe(false)
    expect(isPluginCredentialChoiceValid(0, entries)).toBe(false)
    expect(isPluginCredentialChoiceValid({ id: 'a' }, entries)).toBe(false)
    expect(isPluginCredentialChoiceValid('a', [])).toBe(false)
  })
})

describe('批 E 凭证策略 —— 声明门与预算', () => {
  it('has a permission name and a disclosure that says both halves', () => {
    expect(PLUGIN_PERMISSION_CREDENTIAL_STRATEGY).toBe('credentials:strategy')
    // 能做什么 + 做不到什么。缺任何一半,装前确认页都会误导用户。
    expect(PLUGIN_CREDENTIAL_STRATEGY_PERMISSION_NOTE).toMatch(/choose which of your credentials/)
    expect(PLUGIN_CREDENTIAL_STRATEGY_PERMISSION_NOTE).toMatch(/never sees the key/)
  })

  it('is reachable from the aggregate table the install page renders', () => {
    // 那张表是渲染层 describePluginPermission 的唯一入口 —— 漏登记 = 装前页只
    // 显示一个裸名字。
    expect(describePluginPermission(PLUGIN_PERMISSION_CREDENTIAL_STRATEGY))
      .toContain(PLUGIN_CREDENTIAL_STRATEGY_PERMISSION_NOTE)
  })

  it('sits between the typing-latency budget and the post-confirm budget', () => {
    // 搜索供给方 300ms(键入延迟敏感)< 这条 < 深链 15s(用户刚按过确认)。
    expect(PLUGIN_CREDENTIAL_STRATEGY_TIMEOUT_MS).toBeGreaterThan(300)
    expect(PLUGIN_CREDENTIAL_STRATEGY_TIMEOUT_MS).toBeLessThan(15_000)
  })

  it('keeps the strategy-name pattern narrow', () => {
    expect(PLUGIN_CREDENTIAL_STRATEGY_NAME_PATTERN.test('least-used')).toBe(true)
    expect(PLUGIN_CREDENTIAL_STRATEGY_NAME_PATTERN.test('Least')).toBe(false)
    expect(PLUGIN_CREDENTIAL_STRATEGY_NAME_PATTERN.test('a:b')).toBe(false)
  })
})

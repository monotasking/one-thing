import { describe, expect, it } from 'vitest'
import type { CustomProviderConfig, ProviderInfo } from '@shared/ipc/providers'
import { buildFamilies, findFamily, modeKindOf, providerIdsOf, resolveMode } from '../families'

/**
 * 家族折叠。这一组守的是**「一家两模式」不许退化成两家**,以及三组的归属 ——
 * 一旦这里错了,左栏就会出现「Claude」和「Claude Code」两行,而聊天那边它们
 * 明明共用一个开关。
 */

function info(id: string, extra: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id,
    name: id,
    description: `${id} desc`,
    defaultBaseUrl: `https://api.${id}.test/v1`,
    defaultModel: 'm',
    icon: id,
    supportsCustomBaseUrl: true,
    requiresApiKey: true,
    ...extra,
  }
}

const OAUTH = { requiresApiKey: false, requiresOAuth: true, oauthFlow: 'device' as const }
const LOCAL = { requiresApiKey: false }

const ROSTER: ProviderInfo[] = [
  info('claude', { name: 'Claude' }),
  info('claude-code', { name: 'Claude Code', ...OAUTH }),
  info('deepseek', { name: 'DeepSeek' }),
  info('github-copilot', { name: 'GitHub Copilot', ...OAUTH }),
  info('acp', { name: 'ACP Agents', ...LOCAL }),
  info('claude-code-agent', { name: 'Claude Code Agent', ...LOCAL }),
]

describe('modeKindOf', () => {
  it('本地两只按名点,不靠 requires* 猜', () => {
    expect(modeKindOf(info('acp', LOCAL))).toBe('acp')
    expect(modeKindOf(info('claude-code-agent', LOCAL))).toBe('localCli')
  })

  it('要 OAuth 的是订阅坑,要密钥的是 API 坑', () => {
    expect(modeKindOf(info('claude-code', OAUTH))).toBe('subscription')
    expect(modeKindOf(info('deepseek'))).toBe('api')
  })
})

describe('buildFamilies', () => {
  const families = buildFamilies(ROSTER)

  it('claude + claude-code 折成一家两模式,家名是家族的 label', () => {
    const claude = findFamily(families, 'claude')
    expect(claude?.label).toBe('Claude')
    expect(claude?.modes.map((m) => m.providerId)).toEqual(['claude', 'claude-code'])
    expect(claude?.modes.map((m) => m.kind)).toEqual(['api', 'subscription'])
    // 折成一家 = 名册里那两条不再各占一行。
    expect(families.filter((f) => f.id === 'claude-code')).toHaveLength(0)
  })

  it('不在家族表里的独立成家 —— copilot 是一家一模式(订阅)', () => {
    const copilot = findFamily(families, 'github-copilot')
    expect(copilot?.modes).toHaveLength(1)
    expect(copilot?.modes[0].kind).toBe('subscription')
  })

  it('云 / 本地 / 自定义三组各归各的,且顺序是云→本地→自定义', () => {
    const withCustom = buildFamilies(ROSTER, [
      { id: 'my-vllm', name: '我的 vLLM', apiType: 'openai', model: 'q', selectedModels: [] } as CustomProviderConfig,
    ])
    expect(withCustom.map((f) => f.group)).toEqual([
      'cloud',
      'cloud',
      'cloud',
      'local',
      'local',
      'custom',
    ])
    const custom = findFamily(withCustom, 'my-vllm')
    expect(custom?.custom).toBe(true)
    expect(custom?.modes[0].kind).toBe('custom')
  })

  it('一家的 provider id 全在,启用开关一次要写完这几个', () => {
    const claude = findFamily(families, 'claude')
    expect(providerIdsOf(claude!)).toEqual(['claude', 'claude-code'])
  })
})

describe('resolveMode', () => {
  const claude = findFamily(buildFamilies(ROSTER), 'claude')!

  it('用户点过哪一格就是哪一格', () => {
    expect(resolveMode(claude, 'claude-code', () => false).providerId).toBe('claude-code')
  })

  it('没点过时落在**已经配好**的那一格上', () => {
    expect(resolveMode(claude, undefined, (id) => id === 'claude-code').providerId).toBe(
      'claude-code',
    )
  })

  it('一格都没配就落第一格,不空着', () => {
    expect(resolveMode(claude, undefined, () => false).providerId).toBe('claude')
  })

  it('点过的那一格已经不在这一家里了(名册变了),退回现算', () => {
    expect(resolveMode(claude, 'grok', () => false).providerId).toBe('claude')
  })
})

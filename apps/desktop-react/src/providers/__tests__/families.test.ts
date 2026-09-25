import { describe, expect, it } from 'vitest'
import type { CustomProviderConfig, ProviderInfo } from '@shared/ipc/providers'
import {
  buildFamilies,
  familyDescriptionText,
  findFamily,
  modeKindOf,
  providerIdsOf,
  resolveMode,
} from '../families'
import { translate } from '../../i18n'
import type { MessageKey } from '../../i18n'

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
]

describe('modeKindOf', () => {
  it('本地那只按名点,不靠 requires* 猜', () => {
    expect(modeKindOf(info('acp', LOCAL))).toBe('acp')
    // A6-b:本地 CLI `claude-code-agent` 退役,不再点名 —— 名册里若还残着一条,只是一条零凭证的 API 记录。
    expect(modeKindOf(info('claude-code-agent', LOCAL))).toBe('api')
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

  it('云 / 自定义各归各的,顺序是云→自定义;本地 agent 不进这张名册', () => {
    const withCustom = buildFamilies(ROSTER, [
      { id: 'my-vllm', name: '我的 vLLM', apiType: 'openai', model: 'q', selectedModels: [] } as CustomProviderConfig,
    ])
    // 2026-09-26 用户裁定:agent 不许被画成普通模型。acp 的家是设置页
    // 「Agent」那一页,模型服务的名册里没有它 —— 于是「本地」那一组空了,整组不画。
    expect(withCustom.map((f) => f.group)).toEqual(['cloud', 'cloud', 'cloud', 'custom'])
    expect(withCustom.some((f) => f.modes.some((m) => m.kind === 'acp'))).toBe(false)
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

describe('familyDescriptionText:副语的两种来源', () => {
  const t = (key: MessageKey) => translate('zh', key)

  it('内置服务商:名册给的是字典键,按当前语言翻译', () => {
    const [claude] = buildFamilies([info('claude', { description: 'providers.desc.claude' })])
    expect(familyDescriptionText(t, claude)).toBe('Anthropic 官方接口')
  })

  it('自定义服务商:用户写的原文,哪怕长得像一个键也不翻译', () => {
    const custom: CustomProviderConfig = {
      id: 'my-proxy',
      name: 'My Proxy',
      description: 'providers.desc.claude',
      apiType: 'openai',
      baseUrl: 'https://proxy.test/v1',
    } as CustomProviderConfig
    const [family] = buildFamilies([], [custom])
    expect(familyDescriptionText(t, family)).toBe('providers.desc.claude')
  })

  it('名册给的不是键(插件 / 旧后端):原样显示,不吞', () => {
    const [deepseek] = buildFamilies([info('deepseek', { description: 'Some plugin text' })])
    expect(familyDescriptionText(t, deepseek)).toBe('Some plugin text')
  })
})

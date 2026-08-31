import { describe, expect, it } from 'vitest'
import type { OpenRouterModel, ProviderConfig, ProviderInfo } from '@shared/ipc/providers'
import type { SpaceProviderCredentialSummary } from '@shared/ipc/spaces'
import { buildFamilies, findFamily } from '../families'
import {
  buildCatalogRows,
  buildRailRows,
  capsOf,
  connectedCountOf,
  credentialFactsOf,
  filterRailRows,
  formatPrice,
  formatTokens,
  isModeConfigured,
  modeStateFact,
  priceOf,
  railFactsOf,
  railToneOf,
} from '../projection'
import type { CredentialFacts } from '../types'

/**
 * 名册投影。这一组守的是这块面**最容易说谎的那一格**:
 * 「拿不到」不许被画成「没有」,0 不许被画成一个数。
 */

function info(id: string, extra: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id,
    name: id,
    description: '',
    defaultBaseUrl: '',
    defaultModel: 'm',
    icon: id,
    supportsCustomBaseUrl: true,
    requiresApiKey: true,
    ...extra,
  }
}

const OAUTH = { requiresApiKey: false, requiresOAuth: true, oauthFlow: 'device' as const }

const FAMILIES = buildFamilies([
  info('claude', { name: 'Claude' }),
  info('claude-code', { name: 'Claude Code', ...OAUTH }),
  info('deepseek', { name: 'DeepSeek' }),
])

const CLAUDE = findFamily(FAMILIES, 'claude')!
const DEEPSEEK = findFamily(FAMILIES, 'deepseek')!

function summary(entries: Partial<SpaceProviderCredentialSummary['entries'][number]>[]) {
  return {
    policy: 'single',
    entries: entries.map((e, i) => ({
      id: `e${i}`,
      label: '',
      authType: 'apiKey' as const,
      hasApiKey: false,
      source: 'manual',
      ...e,
    })),
  }
}

const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  model: '',
  selectedModels: [],
  ...over,
})

describe('credentialFactsOf', () => {
  it('口读不到 = known:false —— 后面每一条读数都作废', () => {
    const facts = credentialFactsOf(summary([{ hasApiKey: true }]), false)
    expect(facts.known).toBe(false)
    expect(facts.hasApiKey).toBe(false)
  })

  it('读到了但池子是空的 = 真的未配置', () => {
    expect(credentialFactsOf(undefined, true)).toMatchObject({ known: true, hasApiKey: false })
  })

  it('尾号取第一条带 key 的;冷却按时刻现判', () => {
    const now = 1_000
    const facts = credentialFactsOf(
      summary([
        { hasApiKey: true, apiKeyPreview: '…8c1d' },
        { hasApiKey: true, cooldownUntil: now + 500 },
      ]),
      true,
      now,
    )
    expect(facts.apiKeyPreview).toBe('…8c1d')
    expect(facts.entries).toBe(2)
    expect(facts.cooling).toBe(true)
  })

  it('冷却时刻已经过去 = 不在冷却', () => {
    const facts = credentialFactsOf(summary([{ hasApiKey: true, cooldownUntil: 10 }]), true, 20)
    expect(facts.cooling).toBe(false)
  })
})

const UNKNOWN: CredentialFacts = credentialFactsOf(undefined, false)
const EMPTY: CredentialFacts = credentialFactsOf(undefined, true)
const KEYED: CredentialFacts = credentialFactsOf(summary([{ hasApiKey: true }]), true)
const SIGNED_IN: CredentialFacts = credentialFactsOf(
  summary([{ authType: 'oauth', hasOAuthToken: true, oauthAccount: 'me@example.com' }]),
  true,
)

describe('modeStateFact', () => {
  it('不知道就说不知道 —— 不说「未配置」', () => {
    expect(modeStateFact(CLAUDE.modes[0], UNKNOWN).key).toBe('providers.factUnknown')
  })

  it('API 坑:没 key / 一把 / 多把,三句话', () => {
    expect(modeStateFact(CLAUDE.modes[0], EMPTY).key).toBe('providers.factUnconfigured')
    expect(modeStateFact(CLAUDE.modes[0], KEYED).key).toBe('providers.factConfigured')
    const two = credentialFactsOf(summary([{ hasApiKey: true }, { hasApiKey: true }]), true)
    expect(modeStateFact(CLAUDE.modes[0], two)).toEqual({
      key: 'providers.factKeys',
      vars: { count: 2 },
    })
  })

  it('订阅坑说的是登没登,不是配没配', () => {
    expect(modeStateFact(CLAUDE.modes[1], EMPTY).key).toBe('providers.factSignedOut')
    expect(modeStateFact(CLAUDE.modes[1], SIGNED_IN).key).toBe('providers.factSignedIn')
  })

  it('冷却压过「已配置」—— 出错那句话要被看见', () => {
    const cooling = credentialFactsOf(
      summary([{ hasApiKey: true, cooldownUntil: Date.now() + 1000 }]),
      true,
    )
    expect(modeStateFact(CLAUDE.modes[0], cooling).key).toBe('providers.factCooling')
  })
})

describe('isModeConfigured', () => {
  it('本地坑与自定义坑零凭证 —— 说它们「未配置」没有意义', () => {
    const local = buildFamilies([info('acp', { requiresApiKey: false })])
    expect(isModeConfigured(local[0].modes[0], UNKNOWN)).toBe(true)
  })
})

describe('railFactsOf / railToneOf', () => {
  const credsOf = (id: string) => (id === 'claude-code' ? SIGNED_IN : EMPTY)

  it('副行 = 每一坑的「坑名 + 现状」,加上已选合计', () => {
    const facts = railFactsOf(
      CLAUDE,
      true,
      { claude: config(), 'claude-code': config({ selectedModels: ['a', 'b', 'c'] }) },
      credsOf,
    )
    expect(facts.map((f) => f.key)).toEqual([
      'providers.modeApi',
      'providers.factUnconfigured',
      'providers.modeSub',
      'providers.factSignedIn',
      'providers.factSelected',
    ])
    expect(facts.at(-1)?.vars).toEqual({ count: 3 })
  })

  it('已选 0 型不说 —— 那是废话', () => {
    const facts = railFactsOf(CLAUDE, true, {}, credsOf)
    expect(facts.some((f) => f.key === 'providers.factSelected')).toBe(false)
  })

  it('停用的家只说「已停用」,不再报一遍凭证', () => {
    expect(railFactsOf(CLAUDE, false, {}, credsOf)).toEqual([{ key: 'providers.factDisabled' }])
    expect(railToneOf(CLAUDE, false, credsOf)).toBe('off')
  })

  it('tone:配好 ok / 冷却 bad / 全不知道 warn / 真的没配 idle', () => {
    expect(railToneOf(CLAUDE, true, credsOf)).toBe('ok')
    expect(railToneOf(DEEPSEEK, true, () => EMPTY)).toBe('idle')
    expect(railToneOf(DEEPSEEK, true, () => UNKNOWN)).toBe('warn')
    const cooling = credentialFactsOf(
      summary([{ hasApiKey: true, cooldownUntil: Date.now() + 1000 }]),
      true,
    )
    expect(railToneOf(DEEPSEEK, true, () => cooling)).toBe('bad')
  })
})

describe('buildRailRows / filterRailRows / connectedCountOf', () => {
  it('启用是**家族派生**的:开关记在 API 那位成员上,订阅那位跟着开', () => {
    const rows = buildRailRows(FAMILIES, { claude: config({ enabled: true }) }, () => EMPTY)
    const claude = rows.find((r) => r.familyId === 'claude')
    expect(claude?.tone).not.toBe('off')
    // deepseek 没有 enabled 记录 —— 缺席即开着(与聊天侧同一条判据)。
    expect(rows.find((r) => r.familyId === 'deepseek')?.tone).not.toBe('off')
    const off = buildRailRows(FAMILIES, { claude: config({ enabled: false }) }, () => EMPTY)
    expect(off.find((r) => r.familyId === 'claude')?.tone).toBe('off')
  })

  it('检索按名字与 provider id,不按算出来的副行', () => {
    const rows = buildRailRows(FAMILIES, {}, () => EMPTY)
    expect(filterRailRows(rows, FAMILIES, 'deep').map((r) => r.familyId)).toEqual(['deepseek'])
    // 副行此刻写着「未配置」,但拿它去搜不该命中 —— 换一门语言就换一套结果。
    expect(filterRailRows(rows, FAMILIES, '未配置')).toHaveLength(0)
    // 家族的第二位成员按 id 也搜得到。
    expect(filterRailRows(rows, FAMILIES, 'claude-code').map((r) => r.familyId)).toEqual(['claude'])
  })

  it('「N 家已接入」数的是配好了的那些,不是名册长度', () => {
    expect(connectedCountOf(FAMILIES, () => EMPTY)).toBe(0)
    expect(connectedCountOf(FAMILIES, (id) => (id === 'claude' ? KEYED : EMPTY))).toBe(1)
    // 口读不到时一家都数不出来 —— 副行那边会说「状态未知」。
    expect(connectedCountOf(FAMILIES, () => UNKNOWN)).toBe(0)
  })
})

/* ── 模型目录 ────────────────────────────────────────────────────────────── */

function model(id: string, over: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id,
    name: id,
    context_length: 200_000,
    architecture: {
      modality: 'text',
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'x',
    },
    pricing: { prompt: '0.000003', completion: '0.000015', request: '0', image: '0' },
    top_provider: { context_length: 200_000, max_completion_tokens: 32_768, is_moderated: false },
    supported_parameters: ['temperature'],
    ...over,
  }
}

describe('capsOf / priceOf / format', () => {
  it('五格能力全从目录字段来,一格都不猜', () => {
    expect(
      capsOf(
        model('m', {
          architecture: {
            modality: 'text',
            input_modalities: ['text', 'image', 'audio'],
            output_modalities: ['text', 'image'],
            tokenizer: 'x',
          },
          supported_parameters: ['tools', 'reasoning'],
        }),
      ),
    ).toEqual(['vision', 'tools', 'reasoning', 'imageOut', 'audioIn'])
    expect(capsOf(model('m'))).toEqual([])
  })

  it('单价换算成每百万 token;两格缺一即 null', () => {
    expect(priceOf(model('m'))).toEqual({ input: 3, output: 15 })
    expect(priceOf(model('m', { pricing: { prompt: '0', completion: '0', request: '0', image: '0' } }))).toBeNull()
    expect(
      priceOf(model('m', { pricing: { prompt: 'x', completion: '1', request: '0', image: '0' } })),
    ).toBeNull()
  })

  it('窗口:0 是「没填」不是「零」', () => {
    expect(formatTokens(200_000)).toBe('200K')
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatTokens(null)).toBeNull()
    expect(formatPrice(3)).toBe('$3')
    expect(formatPrice(0.55)).toBe('$0.55')
  })
})

describe('buildCatalogRows', () => {
  const models = [model('a'), model('b')]

  it('勾选态与当前模型都从设置来', () => {
    const rows = buildCatalogRows(models, config({ selectedModels: ['b'], model: 'b' }))
    expect(rows.map((r) => [r.id, r.selected, r.current])).toEqual([
      ['a', false, false],
      ['b', true, true],
    ])
  })

  it('勾过但目录里没有的照样出现,并且排在最前', () => {
    const rows = buildCatalogRows(models, config({ selectedModels: ['ghost'] }))
    expect(rows[0]).toMatchObject({ id: 'ghost', selected: true, contextLength: null, caps: [] })
  })

  it('检索按 id 与显示名', () => {
    expect(buildCatalogRows(models, config(), 'a').map((r) => r.id)).toEqual(['a'])
    expect(buildCatalogRows(models, config(), 'zzz')).toHaveLength(0)
  })
})

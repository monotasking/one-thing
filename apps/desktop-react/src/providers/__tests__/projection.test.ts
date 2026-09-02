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
  cooldownFact,
  groupCatalog,
  isModeConfigured,
  modeStateFact,
  poolViewOf,
  priceOf,
  railFactsOf,
  railToneOf,
  reorderPool,
  rotationHintFact,
  rotationLabelFact,
  vendorPrefixOf,
} from '../projection'
import type { CredentialFacts } from '../types'
import { OTHER_GROUP } from '../types'

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
    /*
     * **每百万 token 的美元数**,不是每 token。
     *
     * 这个夹具从前写的是 `'0.000003'`(每 token),而**生产里没有任何一条路
     * 能产出那种数** —— 全仓只有一个序列化口会造目录行
     * (`onething-runtime/src/providers/model-registry.ts:719`),它的入参在
     * :881-886 白纸黑字写着是 per-1M。假夹具配上 projection 里那个 `* 1e6`,
     * 两个错刚好互相抵消,于是这条用例一直是绿的,而真机上 gpt-5.6 画成了
     * $5000000。**夹具照抄真机上的值**,这条用例才守得住单位。
     * (真机 `~/.onething/settings.json` 的目录缓存:claude-sonnet-4-5 = 3/15。)
     */
    pricing: { prompt: '3', completion: '15', request: '0', image: '0' },
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

  it('单价原样透出(目录给的已经是每百万);两格缺一即 null', () => {
    expect(priceOf(model('m'))).toEqual({ input: 3, output: 15 })
    // 真机上把 gpt-5.6 画成 $5000000 的那一行:5/30 就该是 5/30。
    expect(
      priceOf(model('m', { pricing: { prompt: '5', completion: '30', request: '0', image: '0' } })),
    ).toEqual({ input: 5, output: 30 })
    // deepseek-chat 真机值,分位不许被抹掉。
    expect(
      priceOf(
        model('m', { pricing: { prompt: '0.14', completion: '0.28', request: '0', image: '0' } }),
      ),
    ).toEqual({ input: 0.14, output: 0.28 })
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
    // 拖尾的零砍掉($0.30 里那个零没有意义),有意义的分留住。
    expect(formatPrice(0.3)).toBe('$0.3')
    expect(formatPrice(2.19)).toBe('$2.19')
    expect(formatPrice(150)).toBe('$150')
    // 两位截到 0 而原值不是 0 时退到三位 —— 「$0」是在说它免费。
    expect(formatPrice(0.002)).toBe('$0.002')
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

/* ── 批二:厂牌折叠 ──────────────────────────────────────────────────────── */

describe('groupCatalog', () => {
  /** 造 n 行,id 形如 `<vendor>/m<i>`;`selected` 里那些算已选。 */
  function rows(spec: Array<[vendor: string, count: number]>, selected: string[] = []) {
    const out = []
    for (const [vendor, count] of spec) {
      for (let i = 0; i < count; i += 1) {
        const id = vendor ? `${vendor}/m${i}` : `m${vendor}${i}`
        out.push({
          id,
          name: id,
          selected: selected.includes(id),
          current: false,
          contextLength: null,
          maxOutput: null,
          caps: [],
          price: null,
          manual: false,
        })
      }
    }
    return out
  }

  it('行数不够就不分组 —— 十几行折起来只是多两次点击', () => {
    const grouped = groupCatalog(rows([['anthropic', 5]]), false)
    expect(grouped.grouped).toBe(false)
    expect(grouped.groups[0].rows).toHaveLength(5)
  })

  it('过了门槛按 vendor/ 前缀分组,大组在前', () => {
    const grouped = groupCatalog(
      rows([
        ['anthropic', 18],
        ['openai', 42],
        ['google', 31],
      ]),
      false,
    )
    expect(grouped.grouped).toBe(true)
    expect(grouped.groups.map((g) => g.prefix)).toEqual(['openai/', 'google/', 'anthropic/'])
  })

  /** 45 个只有两三型的厂牌各占一行组头,那不是折叠,是把噪音换了个形状。 */
  it('零星厂牌并进「其他」,并数得出有几个厂牌', () => {
    const grouped = groupCatalog(
      rows([
        ['openai', 42],
        ['tiny-a', 3],
        ['tiny-b', 2],
        ['tiny-c', 4],
        ['tiny-d', 9],
      ]),
      false,
    )
    const other = grouped.groups.find((g) => g.prefix === OTHER_GROUP)!
    expect(other.rows).toHaveLength(18)
    expect(other.vendors).toBe(4)
  })

  it('已选置顶,且不属于任何组', () => {
    const grouped = groupCatalog(
      rows([['openai', 70]], ['openai/m3', 'openai/m9']),
      false,
    )
    expect(grouped.picked.map((r) => r.id)).toEqual(['openai/m3', 'openai/m9'])
    expect(grouped.groups.flatMap((g) => g.rows).map((r) => r.id)).not.toContain('openai/m3')
  })

  /* ── 位置固化(09-01 报障:勾选一下模型就换位置)────────────────────── */

  it('给了 placement:位置读快照,**勾选框读活值** —— 位置与状态分家', () => {
    const all = rows([['openai', 70]], ['openai/m3'])
    // 用户刚勾上了 m9(活值 true),快照里它还是 false。
    const live = all.map((r) => (r.id === 'openai/m9' ? { ...r, selected: true } : r))
    const placement = new Map(all.map((r) => [r.id, r.selected]))

    const grouped = groupCatalog(live, false, placement)
    // 位置:m9 仍留在它原来那一组里,一步没挪。
    expect(grouped.picked.map((r) => r.id)).toEqual(['openai/m3'])
    expect(grouped.groups.flatMap((g) => g.rows).map((r) => r.id)).toContain('openai/m9')
    // 状态:那一行交出去的仍然是**勾上了**的活值。
    const row = grouped.groups.flatMap((g) => g.rows).find((r) => r.id === 'openai/m9')!
    expect(row.selected).toBe(true)
  })

  it('取消勾选也不挪窝:仍留在已选区里,但它的活值是没勾', () => {
    const all = rows([['openai', 70]], ['openai/m3', 'openai/m9'])
    const live = all.map((r) => (r.id === 'openai/m9' ? { ...r, selected: false } : r))
    const placement = new Map(all.map((r) => [r.id, r.selected]))

    const grouped = groupCatalog(live, false, placement)
    expect(grouped.picked.map((r) => r.id)).toEqual(['openai/m3', 'openai/m9'])
    expect(grouped.picked.find((r) => r.id === 'openai/m9')!.selected).toBe(false)
  })

  it('反证:不给 placement 就是老行为 —— 勾一下当场换区', () => {
    const all = rows([['openai', 70]], ['openai/m3'])
    const live = all.map((r) => (r.id === 'openai/m9' ? { ...r, selected: true } : r))

    const grouped = groupCatalog(live, false)
    expect(grouped.picked.map((r) => r.id)).toEqual(['openai/m3', 'openai/m9'])
    expect(grouped.groups.flatMap((g) => g.rows).map((r) => r.id)).not.toContain('openai/m9')
  })

  it('快照不认识的行(刚手填的那一条)按活值算 —— 它没有旧位置可守', () => {
    const all = rows([['openai', 70]])
    const placement = new Map(all.map((r) => [r.id, r.selected]))
    const fresh = {
      ...all[0],
      id: 'hand/typed',
      name: 'hand/typed',
      selected: true,
      manual: true,
    }

    const grouped = groupCatalog([fresh, ...all], false, placement)
    expect(grouped.picked.map((r) => r.id)).toEqual(['hand/typed'])
  })

  it('检索时截 50 行并如实报剩余;已选那一半不截', () => {
    const grouped = groupCatalog(rows([['openai', 200]], ['openai/m0', 'openai/m1']), true)
    expect(grouped.groups.flatMap((g) => g.rows)).toHaveLength(50)
    // 198 条未选里画了 50,剩 148。
    expect(grouped.truncated).toBe(148)
    expect(grouped.picked).toHaveLength(2)
  })

  it('不检索时一行不截 —— 截断是检索态的取舍,不是常态', () => {
    expect(groupCatalog(rows([['openai', 200]]), false).truncated).toBe(0)
  })

  it('顺序是算出来的:同一份目录两次折叠排布一样', () => {
    const input = rows([
      ['openai', 12],
      ['google', 12],
      ['anthropic', 40],
    ])
    const a = groupCatalog(input, false).groups.map((g) => g.prefix)
    const b = groupCatalog(input, false).groups.map((g) => g.prefix)
    expect(a).toEqual(b)
    // 一样大的两组按前缀字典序,不看它们在目录里的先后。
    expect(a).toEqual(['anthropic/', 'google/', 'openai/'])
  })
})

describe('vendorPrefixOf', () => {
  it('取到第一个斜杠为止;没有斜杠 = 没有厂牌', () => {
    expect(vendorPrefixOf('anthropic/claude-sonnet-4')).toBe('anthropic/')
    expect(vendorPrefixOf('deepseek-chat')).toBeNull()
    // 开头就是斜杠不算厂牌 —— 那是个空前缀。
    expect(vendorPrefixOf('/weird')).toBeNull()
  })
})

/* ── 批二:凭证池 ────────────────────────────────────────────────────────── */

describe('poolViewOf', () => {
  function summary(entries: unknown[], policy = 'single', policyUnavailable?: boolean) {
    return { entries, policy, policyUnavailable } as unknown as SpaceProviderCredentialSummary
  }

  const NOW = 1_000_000

  it('序号 1 起,顺序即优先级', () => {
    const view = poolViewOf(
      summary([
        { id: 'a', label: '个人', authType: 'apiKey', hasApiKey: true, apiKeyPreview: '…8c1d', source: 'user' },
        { id: 'b', label: '公司', authType: 'apiKey', hasApiKey: true, apiKeyPreview: '…44f0', source: 'user' },
      ]),
      NOW,
    )
    expect(view.rows.map((r) => [r.ordinal, r.id])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ])
  })

  /*
   * 09-02 批 11:从前这里钉着 `canDelete`(最后一条不可删)。那一格连同那条禁令
   * 一起退役 —— 删最后一条改走 `spaces.clearCredential`,空池 = 这一家回到未配置,
   * 是合法终态(理由全文在 projection.ts 那段与 store 的 removeCredential)。
   * 留下的这一条钉的是**它真的没了**:投影里不该再冒出一个恒真的判据字段。
   */
  it('投影里没有 canDelete 这一格 —— 每一条都删得动', () => {
    const view = poolViewOf(summary([{ id: 'a', authType: 'apiKey', source: 'user' }]), NOW)
    expect(Object.keys(view).sort()).toEqual(['policy', 'policyUnavailable', 'rows'])
  })

  it('冷却按时刻现判,过去的时刻不算冷却', () => {
    const view = poolViewOf(
      summary([
        { id: 'a', authType: 'apiKey', source: 'user', cooldownUntil: NOW + 60_000 },
        { id: 'b', authType: 'apiKey', source: 'user', cooldownUntil: NOW - 1 },
      ]),
      NOW,
    )
    expect(view.rows.map((r) => r.cooling)).toEqual([true, false])
  })

  it('策略缺席落 single;插件策略不可用时字段本身不改写', () => {
    expect(poolViewOf(summary([], ''), NOW).policy).toBe('single')
    const plugged = poolViewOf(summary([], 'plugin:x:round', true), NOW)
    expect(plugged.policy).toBe('plugin:x:round')
    expect(plugged.policyUnavailable).toBe(true)
  })

  it('摘要整个缺席 = 空池,不炸', () => {
    const view = poolViewOf(undefined, NOW)
    expect(view.rows).toEqual([])
    expect(view.policy).toBe('single')
  })
})

describe('cooldownFact', () => {
  const NOW = 1_000_000

  it('三档:分钟 / 小时 / 天', () => {
    expect(cooldownFact(NOW + 4 * 60_000, NOW)).toEqual({
      key: 'providers.coolMinutes',
      vars: { count: 4 },
    })
    expect(cooldownFact(NOW + 3 * 3_600_000, NOW)).toEqual({
      key: 'providers.coolHours',
      vars: { count: 3 },
    })
    expect(cooldownFact(NOW + 2 * 86_400_000, NOW)).toEqual({
      key: 'providers.coolDays',
      vars: { count: 2 },
    })
  })

  it('已经到点 = 即将恢复;没有冷却时刻 = 没有这句话', () => {
    expect(cooldownFact(NOW - 1, NOW)).toEqual({ key: 'providers.coolSoon' })
    expect(cooldownFact(undefined, NOW)).toBeNull()
  })
})

describe('reorderPool', () => {
  it('上移下移就是一次交换', () => {
    expect(reorderPool(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(reorderPool(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
  })

  it('越界原样返回 —— 调用方据「没变」决定不发请求', () => {
    expect(reorderPool(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
    expect(reorderPool(['a', 'b'], 'b', 1)).toEqual(['a', 'b'])
    expect(reorderPool(['a', 'b'], '不在池里', 1)).toEqual(['a', 'b'])
  })
})

describe('轮换策略的句子', () => {
  it('三档各有名字与一句语义说明', () => {
    expect(rotationLabelFact('single')).toEqual({ key: 'providers.rotationSingle' })
    expect(rotationHintFact('priority-failover')).toEqual({
      key: 'providers.rotationFailoverHint',
    })
  })

  it('插件策略:名字带原值透出,但**没有**语义句可说 —— 不编一句', () => {
    expect(rotationLabelFact('plugin:x:round')).toEqual({
      key: 'providers.rotationUnknown',
      vars: { policy: 'plugin:x:round' },
    })
    expect(rotationHintFact('plugin:x:round')).toBeNull()
  })
})

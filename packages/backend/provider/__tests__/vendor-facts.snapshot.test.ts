/**
 * 服务商事实快照(`docs/design/architecture-direction-2026-10.md` §4 P0)。
 *
 * 服务商自述试点要把每家散在公共大表里的数据(环境变量名、接口地址与档位、目录键、
 * 认亲品牌、错误码说明、模型能力规则、请求选项……)搬进 `vendors/<id>/`。搬家必须
 * **不改行为**。线协议快照(`providers/__tests__/wire-snapshots`)守的是
 * 「发出去的字节」;这份守的是**那些表推导出来的答案** —— 经由今天的公共函数逐家问一遍,
 * 结果冻进 `__fixtures__/vendor-facts.json`。
 *
 * ⚠️ 与线协议快照同一条纪律:**禁止用 `-u` 更新。** 红了 = 某家的某个事实变了;
 * 若确实有意,在提交说明里逐处写清哪家、哪一格、为什么。
 *
 * 序列化前递归排序对象 key(key 顺序不是行为),数组顺序原样保留。
 */
import { describe, expect, it } from 'vitest'
import { extractErrorDetails as coreExtractErrorDetails } from '@onething/backend/agent-loop'
import {
  getSupportedAgentProviderRuntimeIds,
  isAgentProviderRuntimeSupported,
} from '../factory.js'
import { listDialects } from '../base/provider-base-dialect.js'
import { thinkingWires } from '../base/thinking-wire.js'
import '../thinking/provider-thinking.js'
import { providerDialFieldsOf } from '../../credentials/credentials-provider-rules.js'
import { providerInfoOfManifest } from '../builtin-providers.js'
import { getOnethingProviderApiKeyEnvCandidates } from '../env.js'
import { getProviderManifestRegistry } from '../provider-manifest.js'
import {
  resolveOnethingModelCapabilities,
  resolveOnethingProviderKind,
} from '../model-capability.js'
import { MODEL_VENDOR_ALIASES } from '../model-identity.js'
import { getOnethingModelsDevProviderId, ONETHING_PROVIDER_MAPPING } from '../models-dev-catalog.js'
import { extractErrorDetails as runtimeExtractErrorDetails } from '../provider-config.js'
import {
  buildOnethingRequestProviderOptionsBag,
  pickOnethingProviderOptions,
} from '../provider-options.js'
import { listQuotaSourceIds } from '../quota/provider-quota-registry.js'
import { resolveOnethingProviderBaseUrl } from '../provider-endpoint.js'

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (typeof value === 'function') return '[function]'
  if (value === null || typeof value !== 'object') return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key]
    if (entry === undefined) continue
    sorted[key] = sortKeysDeep(entry)
  }
  return sorted
}

/** 每一格档位 / 地区 / 地址的组合 —— 与哪家无关的格子会被那家忽略,快照照样记下答案。 */
const ENDPOINT_CONFIGS: Array<{ label: string; config: Record<string, unknown> | undefined }> = [
  { label: 'none', config: undefined },
  { label: 'empty', config: {} },
  { label: 'proxy', config: { baseUrl: 'https://proxy.example/v1' } },
  { label: 'zhipu-coding', config: { zhipuApiMode: 'coding-plan' } },
  { label: 'zhipu-standard', config: { zhipuApiMode: 'standard' } },
  { label: 'zhipu-coding-proxy', config: { zhipuApiMode: 'coding-plan', baseUrl: 'https://proxy.example/v1' } },
  { label: 'qwen-standard-cn', config: { qwenApiMode: 'standard', qwenRegion: 'cn' } },
  { label: 'qwen-standard-intl', config: { qwenApiMode: 'standard', qwenRegion: 'intl' } },
  { label: 'qwen-token-cn', config: { qwenApiMode: 'token-plan', qwenRegion: 'cn' } },
  { label: 'qwen-token-intl', config: { qwenApiMode: 'token-plan', qwenRegion: 'intl' } },
  { label: 'qwen-coding-cn', config: { qwenApiMode: 'coding-plan', qwenRegion: 'cn' } },
  { label: 'qwen-coding-intl', config: { qwenApiMode: 'coding-plan', qwenRegion: 'intl' } },
  { label: 'kimi-standard-cn', config: { kimiApiMode: 'standard', kimiRegion: 'cn' } },
  { label: 'kimi-standard-intl', config: { kimiApiMode: 'standard', kimiRegion: 'intl' } },
  { label: 'kimi-coding', config: { kimiApiMode: 'coding-plan' } },
]

/** 一份把所有已知专属格子都填上的存档配置:看 pick 留下哪几格。 */
const STORED_CONFIG_ALL_FIELDS: Record<string, unknown> = {
  apiKey: 'sk-fixture',
  baseUrl: 'https://proxy.example/v1',
  zhipuApiMode: 'coding-plan',
  qwenApiMode: 'token-plan',
  qwenRegion: 'intl',
  kimiApiMode: 'coding-plan',
  kimiRegion: 'intl',
  reasoningEffort: 'high',
  enabled: true,
}

/** 跨家的样本模型:能力表按「家 × 模型名」给答案,同一个模型名在不同家可以不同。 */
const SAMPLE_MODELS = [
  'gpt-5',
  'gpt-5.1-codex',
  'gpt-4o',
  'o3',
  'o4-mini',
  'claude-sonnet-4-5',
  'claude-opus-4-1',
  'gemini-2.5-pro',
  'gemini-3-pro-preview',
  'deepseek-chat',
  'deepseek-reasoner',
  'kimi-k2-turbo-preview',
  'kimi-for-coding',
  'glm-4.6',
  'glm-5',
  'qwen3-max',
  'qwen3-coder-plus',
  'grok-4',
  'grok-code-fast-1',
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-5',
  'unknown-model-x',
]

const ERROR_SAMPLES = [
  { label: 'zhipu-1113', responseBody: JSON.stringify({ error: { code: '1113', message: '余额不足或无可用资源包,请充值。' } }) },
  { label: 'zhipu-1309-flat', responseBody: JSON.stringify({ code: 1309, message: 'expired' }) },
  { label: 'unknown-code', responseBody: JSON.stringify({ error: { code: 'rate_limit', message: 'slow down' } }) },
  { label: 'plain-text', responseBody: 'upstream exploded' },
]

function builtinIds(): string[] {
  return getProviderManifestRegistry()
    .list()
    .filter((manifest) => manifest.origin === 'builtin')
    .map((manifest) => manifest.id)
    .sort()
}

/**
 * 试点把各家散在公共表里的数据**搬进** manifest(P1 起)。这几格是搬进来的输入,不是答案:
 * 它们的效果由下面逐项问出来的事实(环境变量、地址、认亲、错误说明、型号能力……)冻住。
 * 在原始 manifest 的转储里略去它们,快照才只在「答案变了」时红。P3 加的三格答案在别处冻住:
 * `seed` = 出厂设置(`packages/backend/settings/__tests__/settings-defaults.freeze.test.ts` 逐字比),
 * `reasoningWires` = 思考覆盖的合法取值(`reasoning-wire-ids.test.ts`),`catalogBackfill` = 千问
 * 按量目录补缺(`qwen-model-refresh.test.ts`)。
 * P4 加的 `family`(各家声明自己是家族里的哪一半)的答案是下面原样冻着的 `sibling` / `familyTag`
 * (由名册的 `VENDOR_FAMILIES` 算出),逐字未变就是推导不变的证据。
 */
const VENDOR_DATA_FIELDS = ['envVars', 'modelIdentity', 'catalogAliases', 'errorDescriptions', 'endpoint', 'modelRuleTable', 'seed', 'reasoningWires', 'catalogBackfill', 'family']

/**
 * `providerInfo` 在 P4 多投了三格纯数据(`dials` / `hasQuota` / `family`)。它们的答案在别处冻住:
 * `dials` ≡ spec 函数(`dial-descriptor.equivalence.test.ts`),`family` ≡ 旧家族表
 * (`provider-families.equivalence.test.ts`),`hasQuota` = 上面 manifest 转储里的 `quotaSource`
 * 在不在。这里只略去这三格,其余逐字照旧 —— 「只多出这三格、别的一格不变」就是这份快照守的事。
 */
const PROVIDER_INFO_P4_FIELDS = ['dials', 'hasQuota', 'family']

function providerInfoBeforeP4(manifest: Parameters<typeof providerInfoOfManifest>[0]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(providerInfoOfManifest(manifest)).filter(([key]) => !PROVIDER_INFO_P4_FIELDS.includes(key)),
  )
}

function vendorFacts(id: string): unknown {
  const manifest = getProviderManifestRegistry().get(id)!
  const models = manifest.models
  const manifestShape = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !VENDOR_DATA_FIELDS.includes(key)),
  )
  return {
    manifest: manifestShape,
    catalogKeyByConfig:
      models.kind === 'models.dev' && models.keyOf
        ? Object.fromEntries(ENDPOINT_CONFIGS.map(({ label, config }) => [label, models.keyOf!(config)]))
        : undefined,
    providerInfo: providerInfoBeforeP4(manifest),
    envCandidates: getOnethingProviderApiKeyEnvCandidates(id),
    dialFields: providerDialFieldsOf(id),
    providerKind: resolveOnethingProviderKind(id),
    runtimeSupported: isAgentProviderRuntimeSupported(id),
    baseUrlByConfig: Object.fromEntries(
      ENDPOINT_CONFIGS.map(({ label, config }) => [label, resolveOnethingProviderBaseUrl(id, config as never) ?? null]),
    ),
    modelsDevIdByConfig: Object.fromEntries(
      ENDPOINT_CONFIGS.map(({ label, config }) => [label, getOnethingModelsDevProviderId(id, config as never)]),
    ),
    pickedOptions: pickOnethingProviderOptions(id, STORED_CONFIG_ALL_FIELDS) ?? null,
    requestOptionsBag: buildOnethingRequestProviderOptionsBag(
      id,
      pickOnethingProviderOptions(id, STORED_CONFIG_ALL_FIELDS),
    ),
    capabilities: Object.fromEntries(
      [manifest.defaultModel, ...SAMPLE_MODELS]
        .filter((model, index, all) => model && all.indexOf(model) === index)
        .map((modelId) => [modelId, resolveOnethingModelCapabilities({ providerId: id, modelId })]),
    ),
  }
}

describe('vendor facts snapshot', () => {
  it('freezes every builtin vendor fact the generic tables derive today', async () => {
    const ids = builtinIds()
    expect(ids.length).toBeGreaterThanOrEqual(14)
    const facts = {
      vendors: Object.fromEntries(ids.map((id) => [id, vendorFacts(id)])),
      tables: {
        modelsDevMapping: ONETHING_PROVIDER_MAPPING,
        // 查表是「按品牌 / 目录键 find」,各行互不重叠 —— 行序不是行为,按首个品牌排。
        modelVendorAliases: [...MODEL_VENDOR_ALIASES].sort((a, b) => a.brands[0]!.localeCompare(b.brands[0]!)),
        dialects: listDialects()
          .map((dialect) => ({ id: dialect.id, wire: dialect.wire }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        thinkingWires: thinkingWires
          .list()
          .map((wire) => wire.id)
          .sort(),
        quotaSources: [...listQuotaSourceIds()].sort(),
        runtimeIds: [...getSupportedAgentProviderRuntimeIds()].sort(),
      },
      errors: Object.fromEntries(
        ERROR_SAMPLES.map(({ label, responseBody }) => [
          label,
          {
            core: coreExtractErrorDetails({ message: 'request failed', responseBody }) ?? null,
            runtime: runtimeExtractErrorDetails({ message: 'request failed', responseBody }) ?? null,
          },
        ]),
      ),
    }
    await expect(`${JSON.stringify(sortKeysDeep(facts), null, 2)}\n`).toMatchFileSnapshot(
      './__fixtures__/vendor-facts.json',
    )
  })
})

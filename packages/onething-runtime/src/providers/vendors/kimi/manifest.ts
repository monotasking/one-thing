/**
 * `kimi` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1 / P2)。
 *
 * 这一家的**数据**全在这里:显示名、方言、目录、档位与地址、读密钥的环境变量、
 * 模型认亲、型号规则。通用代码只读这些字段,不写「kimi」。行为(方言、附件旁路、
 * 运行时工厂、余额源)在同目录的 `runtime.ts` 及其伙伴。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`),不许碰 node / agent-loop。
 */
import type { DialSpec } from '../../dials.js'
import type { ProviderManifest } from '../../manifest.js'
import {
  ONETHING_KIMI_DEFAULT_BASE_URL,
  getOnethingKimiBaseUrl,
  normalizeOnethingKimiApiMode,
  normalizeOnethingKimiRegion,
  onethingKimiRegionApplies,
  resolveOnethingKimiBaseUrl,
  resolveOnethingKimiModelsDevProviderId,
  type OnethingKimiEndpointConfig,
} from './endpoint.js'

/**
 * 计费档位(从 `providers/dials.ts` 搬回家,逐字)。选项名与风险说明不进 i18n 的理由
 * 写在 `dials.ts` 抬头:选错档位是真扣钱的,这几句话按「不许漂」处理。
 */
export const KIMI_DIALS: DialSpec = {
  apiModeKey: 'kimiApiMode',
  regionKey: 'kimiRegion',
  apiMode: {
    label: '计费方式',
    ariaLabel: 'Kimi API mode',
    options: [
      { value: 'standard', label: '开放平台 按量付费' },
      { value: 'coding-plan', label: '编程套餐 Kimi Code 订阅' },
    ],
    normalize: (value) => normalizeOnethingKimiApiMode(value),
  },
  region: {
    label: '版本',
    ariaLabel: 'Kimi region',
    options: [
      { value: 'cn', label: '国内版 (moonshot.cn)' },
      { value: 'intl', label: '海外版 (moonshot.ai)' },
    ],
    normalize: (value) => normalizeOnethingKimiRegion(value),
    // 编程套餐(Kimi Code)只有一个全球地址,那一格在这时没有意义。
    appliesTo: (apiMode) => onethingKimiRegionApplies(normalizeOnethingKimiApiMode(apiMode)),
  },
  note: '编程套餐的密钥和地址与开放平台不通用,用错会额外扣费。',
  baseUrlOf: (apiMode, region) =>
    getOnethingKimiBaseUrl(
      normalizeOnethingKimiApiMode(apiMode),
      normalizeOnethingKimiRegion(region),
    ),
}

export const KIMI_MANIFEST: ProviderManifest = {
  id: 'kimi',
  origin: 'builtin',
  name: 'Kimi',
  description: 'providers.desc.kimi',
  icon: 'kimi',
  dialect: 'kimi',
  auth: { kind: 'apiKey' },
  // 按量/套餐 × 国内/海外:三个地址三本目录,按配置选。
  models: {
    kind: 'models.dev',
    key: 'moonshotai',
    keyOf: (config) => resolveOnethingKimiModelsDevProviderId(config as OnethingKimiEndpointConfig | undefined),
  },
  billing: 'api',
  quotaSource: 'kimi',
  dials: KIMI_DIALS,
  modelRules: 'kimi',
  defaultBaseUrl: ONETHING_KIMI_DEFAULT_BASE_URL,
  supportsCustomBaseUrl: true,
  defaultModel: 'moonshot-v1-128k',
  envVars: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  modelIdentity: { brands: ['moonshotai', 'moonshot', 'kimi'], keys: ['moonshotai', 'moonshotai-cn'] },
  catalogAliases: ['moonshotai'],
  endpoint: {
    // 按量 / 套餐 × 国内 / 海外:地址是这一对的查表,所以这两格永远带上、永远完整。
    pickOptions: (stored) => ({
      kimiApiMode: normalizeOnethingKimiApiMode(stored.kimiApiMode),
      kimiRegion: normalizeOnethingKimiRegion(stored.kimiRegion),
    }),
    resolveBaseUrl: (config) => resolveOnethingKimiBaseUrl(config as OnethingKimiEndpointConfig | undefined),
    entryFields: { apiMode: 'kimiApiMode', region: 'kimiRegion' },
    ownsBaseUrl: true,
  },
  // 型号规则表(从 `model-capability.ts` 的 `PROVIDER_MODEL_RULES.kimi` 搬来,逐字)。
  // `kimi-code` 借这张表(它的 `modelRules` 也是 `'kimi'`),表只由主人带。
  modelRuleTable: [
    {
      // K3 是这家唯一收 `tool_choice: required` / 指名函数的一代(#5b)。
      test: /^kimi-k3/,
      caps: { reasoning: true, forcedToolUse: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        // K3 only accepts reasoning_effort "max".
        efforts: ['max'],
        defaultEffort: 'max',
        wire: 'thinking-type',
      },
    },
    {
      // Kimi Code 套餐给同一代 K3 起的名字是**裸** `k3` / `k3-256k`
      // (`ONETHING_KIMI_CODE_DEFAULT_MODEL`),`^kimi-k3` 够不着它。这一行
      // **只说 forcedToolUse**:reasoning 仍由下面的行裁定,顺序语义不动。
      test: /^k3(?:-|$)/,
      caps: { forcedToolUse: true },
    },
    {
      // k2.7-code (+ -highspeed) and k2-thinking always think; nothing to configure.
      test: /^kimi-k2.*(code|thinking)/,
      caps: { reasoning: true, forcedToolUse: false },
      profile: {
        toggleable: false,
        defaultOn: true,
        efforts: [],
        defaultEffort: 'high',
        wire: 'none',
      },
    },
    {
      // k2.5 / k2.6: thinking on by default, toggleable via thinking.type.
      test: /^kimi-k2\.\d/,
      caps: { reasoning: true, forcedToolUse: false },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: [],
        defaultEffort: 'high',
        wire: 'thinking-type',
      },
    },
    // K2.x 及更早只认 `tool_choice: auto`(#5b);未知型号按保守面倒。
    { test: /(?:)/, caps: { reasoning: false, forcedToolUse: false } },
  ],
}

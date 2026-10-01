/**
 * `qwen` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1 / P2)。
 *
 * 这一家的**数据**全在这里:显示名、方言、目录、档位与地址、读密钥的环境变量、
 * 模型认亲、型号规则。通用代码只读这些字段,不写「qwen」。行为(方言、思考参数、
 * 运行时工厂)在同目录的 `runtime.ts` 及其伙伴。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`),不许碰 node / agent-loop。
 */
import type { DialSpec } from '../../dials.js'
import type { ProviderManifest } from '../../manifest.js'
import {
  ONETHING_QWEN_DEFAULT_BASE_URL,
  ONETHING_QWEN_DEFAULT_MODEL,
  getOnethingQwenBaseUrl,
  normalizeOnethingQwenApiMode,
  normalizeOnethingQwenRegion,
  onethingQwenBackfillModels,
  resolveOnethingQwenBaseUrl,
  resolveOnethingQwenModelsDevProviderId,
  type OnethingQwenEndpointConfig,
} from './endpoint.js'

/**
 * 计费档位(从 `providers/dials.ts` 搬回家,逐字)。选项名与风险说明不进 i18n 的理由
 * 写在 `dials.ts` 抬头:选错档位是真扣钱的,这几句话按「不许漂」处理。
 */
/**
 * 千问平台上转售的 DeepSeek V3/V4 型号沿用 DeepSeek 自己的两档(与 DeepSeek 官方端点同一组)。
 * 写在这里而不是去 import 别家的目录:这是千问这个端点接受什么,由千问自己说。
 */
const RESOLD_HIGH_MAX_EFFORTS = ['high', 'max'] as const

export const QWEN_DIALS: DialSpec = {
  apiModeKey: 'qwenApiMode',
  regionKey: 'qwenRegion',
  apiMode: {
    label: '计费方式',
    ariaLabel: 'Qwen API mode',
    options: [
      { value: 'standard', label: 'API 按量付费 (sk-ws-)' },
      { value: 'token-plan', label: 'Token Plan 订阅 (sk-sp-)' },
      { value: 'coding-plan', label: 'Coding Plan 订阅 (sk-sp-)' },
    ],
    normalize: (value) => normalizeOnethingQwenApiMode(value),
  },
  region: {
    label: '版本',
    ariaLabel: 'Qwen region',
    options: [
      { value: 'cn', label: '国内版' },
      { value: 'intl', label: '海外版 (QwenCloud)' },
    ],
    normalize: (value) => normalizeOnethingQwenRegion(value),
  },
  note: '订阅用户请选对档位,否则会按量计费。',
  baseUrlOf: (apiMode, region) =>
    getOnethingQwenBaseUrl(
      normalizeOnethingQwenApiMode(apiMode),
      normalizeOnethingQwenRegion(region),
    ),
}

/**
 * Qwen3.8-Max is the only Qwen family that takes reasoning_effort, and it
 * accepts exactly low|medium|xhigh (it 400s if thinking_budget is sent too).
 * Every other hybrid Qwen model is budget-driven, so it exposes no effort tier.
 */
export const ONETHING_QWEN_MAX_EFFORTS = ['low', 'medium', 'xhigh'] as const

export const QWEN_MANIFEST: ProviderManifest = {
  id: 'qwen',
  origin: 'builtin',
  name: '千问',
  description: 'providers.desc.qwen',
  icon: 'qwen',
  dialect: 'qwen',
  auth: { kind: 'apiKey' },
  // 国内/海外 × 按量/Token Plan:四本目录,按配置选。
  models: {
    kind: 'models.dev',
    key: 'alibaba-cn',
    keyOf: (config) => resolveOnethingQwenModelsDevProviderId(config as OnethingQwenEndpointConfig | undefined),
  },
  // 按量目录(alibaba / alibaba-cn)还没收旗舰,补上目录里缺的那几行(见 `onethingQwenBackfillModels`;
  // 从 `model-registry.ts` 按 id 的分支搬来)。
  catalogBackfill: (config) => onethingQwenBackfillModels(config as OnethingQwenEndpointConfig | undefined),
  billing: 'api',
  dials: QWEN_DIALS,
  modelRules: 'qwen',
  // 用户能在思考覆盖(`reasoningProfile.wire`)里点名的线型(见 `ProviderManifest.reasoningWires`)。
  reasoningWires: ['qwen-thinking'],
  defaultBaseUrl: ONETHING_QWEN_DEFAULT_BASE_URL,
  supportsCustomBaseUrl: true,
  defaultModel: ONETHING_QWEN_DEFAULT_MODEL,
  // Both 千问 AI 平台 and QwenCloud tell you to export DASHSCOPE_API_KEY.
  envVars: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  modelIdentity: { brands: ['qwen', 'alibaba', 'alibaba-cloud', 'dashscope'], keys: ['alibaba', 'alibaba-cn'] },
  // 目录键随地区与档位变(见 `endpoint.ts`);这一格只是没有配置时的反查 —— 国内版按量。
  catalogAliases: ['alibaba-cn'],
  endpoint: {
    // 两个归一函数都回落到缺省值而不是 undefined,所以千问永远有这一袋 —— 地址取决于这一对。
    pickOptions: (stored) => ({
      qwenApiMode: normalizeOnethingQwenApiMode(stored.qwenApiMode),
      qwenRegion: normalizeOnethingQwenRegion(stored.qwenRegion),
    }),
    resolveBaseUrl: (config) => resolveOnethingQwenBaseUrl(config as OnethingQwenEndpointConfig | undefined),
    entryFields: { apiMode: 'qwenApiMode', region: 'qwenRegion' },
    ownsBaseUrl: true,
  },
  // 型号规则表(从 `model-capability.ts` 的 `PROVIDER_MODEL_RULES.qwen` 搬来,逐字)。
  // 千问 AI 平台 resells GLM / Kimi / DeepSeek / MiniMax next to its own Qwen
  // models, and each family keeps its own effort vocabulary on this endpoint ——
  // 所以下面几行的正则里出现别家模型名,说的是**这个端点转售的模型**,不是在点那几家的名。
  modelRuleTable: [
    {
      // The preview shares 3.8-max's effort ladder but carries no thinking
      // toggle (models.dev lists effort + budget only, and the API docs leave
      // Qwen3.8 out of the enable_thinking model list) — so no fake Off.
      test: /qwen3\.8-max-preview/,
      caps: { reasoning: true, vision: true },
      profile: {
        toggleable: false,
        defaultOn: true,
        efforts: ONETHING_QWEN_MAX_EFFORTS,
        defaultEffort: 'xhigh',
        wire: 'qwen-thinking',
      },
    },
    {
      // Only the 3.8-max family takes reasoning_effort; it thinks by default
      // and, unlike the preview, still accepts the toggle.
      test: /qwen3\.8-max/,
      caps: { reasoning: true, vision: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: ONETHING_QWEN_MAX_EFFORTS,
        defaultEffort: 'xhigh',
        wire: 'qwen-thinking',
      },
    },
    {
      // GLM and DeepSeek-V4/V3.2 keep the high|max pair the vendors use.
      test: /^glm-|^deepseek-v[34]/,
      caps: { reasoning: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: RESOLD_HIGH_MAX_EFFORTS,
        defaultEffort: 'high',
        wire: 'qwen-thinking',
      },
    },
    {
      // k2.7-code / k2-thinking always think and expose no knob.
      test: /^kimi.*(code|thinking)/,
      caps: { reasoning: true },
      profile: {
        toggleable: false,
        defaultOn: true,
        efforts: [],
        defaultEffort: 'high',
        wire: 'none',
      },
    },
    {
      // Qwen3.5+ hybrids and the resold Kimi K2.x: thinking on by default,
      // toggled with enable_thinking, depth set by thinking_budget (no tiers).
      test: /^qwen3\.\d|^kimi/,
      caps: { reasoning: true, vision: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: [],
        defaultEffort: 'high',
        wire: 'qwen-thinking',
      },
    },
    {
      // Older hybrids (qwen3-*, qwen-plus/turbo/flash, qwq/qvq): the API does
      // not think unless enable_thinking is sent.
      test: /^qwen3-|^qwen-(?:plus|turbo|flash)|^q[wv]q/,
      caps: { reasoning: true },
      profile: {
        toggleable: true,
        defaultOn: false,
        efforts: [],
        defaultEffort: 'high',
        wire: 'qwen-thinking',
      },
    },
    { test: /-vl|vl-|omni/, caps: { reasoning: false, vision: true } },
    { test: /(?:)/, caps: { reasoning: false } },
  ],
  // 出厂设置里的那一条,逐字照搬自 P3 之前 `@shared/defaults/settings.ts` 的默认表(见 `ProviderSeed`)。
  seed: {
    apiKey: '',
    qwenApiMode: 'standard',
    qwenRegion: 'cn',
    model: 'qwen3.7-plus',
    // The three models both docs sites put front and center. Seeded because
    // models.dev lags the vendor: qwen3.8-max shipped 2026-08-03 and is still
    // absent from the pay-as-you-go catalogs (alibaba / alibaba-cn), so a
    // registry refresh alone would hide the flagship. Entries the catalog does
    // carry get their real metadata from the refresh; the rest are synthesized
    // until models.dev catches up.
    selectedModels: ['qwen3.7-plus', 'qwen3.8-max', 'qwen3.7-flash'],
    enabled: false,
  },
}

/**
 * 内置 16 家的自述(批 M,`docs/design/provider-settings-rework-2026-09.md` §5.2)。
 *
 * **加一家 = 这里一个字面量 + 一枚图标**(方言已登记的前提下)。别处读字段,不点名。
 * 这是 runtime 里除各家自己的模块(`codex.ts`、`dialects/<id>.ts` …)之外**唯一**
 * 允许写 provider 名的地方 —— `__tests__/manifest-no-enumeration.test.ts` 守着。
 *
 * 本文件是**纯**模块(壳也 import 它):不许 import
 * `codex.ts` 这类碰 `process` 的模块,Codex 的地址与默认模型在这里写字面,
 * `__tests__/builtin-manifests.test.ts` 钉着它们与 `codex.ts` 的常量逐字相等。
 *
 * `name` 今天是字面(不走字典);`description` 是字典键 `providers.desc.<id>`,
 * 壳按键查 zh / en 字典显示。
 */
import type { ProviderManifest } from './manifest.js'
import { KIMI_DIALS, QWEN_DIALS, ZHIPU_DIALS } from './dials.js'
import {
  ONETHING_KIMI_CODE_DEFAULT_MODEL,
  ONETHING_KIMI_CODE_MODELS_DEV_ID,
  ONETHING_KIMI_CODING_PLAN_BASE_URL,
  ONETHING_KIMI_DEFAULT_BASE_URL,
  resolveOnethingKimiModelsDevProviderId,
  type OnethingKimiEndpointConfig,
} from './kimi.js'
import {
  ONETHING_QWEN_DEFAULT_BASE_URL,
  ONETHING_QWEN_DEFAULT_MODEL,
  resolveOnethingQwenModelsDevProviderId,
  type OnethingQwenEndpointConfig,
} from './qwen.js'
import { ONETHING_ZHIPU_STANDARD_BASE_URL } from './zhipu.js'
import { providerFamilyOf } from '@shared/provider-families.js'

/**
 * 外部执行体(ACP / Claude Code Agent)的「方言」:没有线协议,provider 由执行器注册表建。
 * 住在这里而不是 `manifest.ts`:那边 import 这张表,常量放那边会成环。
 */
export const EXTERNAL_AGENT_DIALECT_ID = 'external-agent'

/** Claude Code(订阅)目录只列 Claude 家的型号。 */
const CLAUDE_CODE_MODEL_PATTERNS = [
  'claude-sonnet',
  'claude-haiku',
  'claude-opus',
  'claude-3-5',
  'claude-3.5',
  'claude-3.7',
  'claude-4',
] as const

const BUILTIN_LITERALS: readonly ProviderManifest[] = [
  {
    id: 'openai',
    origin: 'builtin',
    name: 'OpenAI',
    description: 'providers.desc.openai',
    icon: 'openai',
    dialect: 'openai',
    auth: { kind: 'apiKey' },
    models: { kind: 'models.dev', key: 'openai' },
    billing: 'api',
    modelRules: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportsCustomBaseUrl: true,
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'claude',
    origin: 'builtin',
    name: 'Claude',
    description: 'providers.desc.claude',
    icon: 'claude',
    dialect: 'claude',
    auth: { kind: 'apiKey' },
    models: { kind: 'models.dev', key: 'anthropic' },
    billing: 'api',
    modelRules: 'claude',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    supportsCustomBaseUrl: true,
    defaultModel: 'claude-sonnet-4-20250514',
  },
  {
    id: 'deepseek',
    origin: 'builtin',
    name: 'DeepSeek',
    description: 'providers.desc.deepseek',
    icon: 'deepseek',
    dialect: 'deepseek',
    auth: { kind: 'apiKey' },
    models: { kind: 'models.dev', key: 'deepseek' },
    billing: 'api',
    quotaSource: 'deepseek',
    modelRules: 'deepseek',
    defaultBaseUrl: 'https://api.deepseek.com',
    supportsCustomBaseUrl: true,
    defaultModel: 'deepseek-chat',
  },
  {
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
  },
  {
    id: 'zhipu',
    origin: 'builtin',
    name: '智谱 GLM',
    description: 'providers.desc.zhipu',
    icon: 'zhipu',
    dialect: 'zhipu',
    auth: { kind: 'apiKey' },
    models: { kind: 'models.dev', key: 'zhipuai' },
    billing: 'api',
    dials: ZHIPU_DIALS,
    modelRules: 'zhipu',
    defaultBaseUrl: ONETHING_ZHIPU_STANDARD_BASE_URL,
    supportsCustomBaseUrl: true,
    defaultModel: 'glm-5.2',
  },
  {
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
    billing: 'api',
    dials: QWEN_DIALS,
    modelRules: 'qwen',
    defaultBaseUrl: ONETHING_QWEN_DEFAULT_BASE_URL,
    supportsCustomBaseUrl: true,
    defaultModel: ONETHING_QWEN_DEFAULT_MODEL,
  },
  {
    id: 'openrouter',
    origin: 'builtin',
    name: 'OpenRouter',
    description: 'providers.desc.openrouter',
    icon: 'openrouter',
    dialect: 'openrouter',
    auth: { kind: 'apiKey' },
    models: { kind: 'models.dev', key: 'openrouter' },
    billing: 'api',
    quotaSource: 'openrouter',
    modelRules: 'openrouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    supportsCustomBaseUrl: false,
    defaultModel: 'openai/gpt-4o',
  },
  {
    id: 'gemini',
    origin: 'builtin',
    name: 'Google Gemini',
    description: 'providers.desc.gemini',
    icon: 'gemini',
    dialect: 'gemini',
    auth: { kind: 'apiKey' },
    models: { kind: 'models.dev', key: 'google' },
    billing: 'api',
    modelRules: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    supportsCustomBaseUrl: true,
    defaultModel: 'gemini-2.0-flash-exp',
  },
  {
    id: 'claude-code',
    origin: 'builtin',
    name: 'Claude Code',
    description: 'providers.desc.claude-code',
    icon: 'claude-code',
    dialect: 'claude-code',
    auth: { kind: 'oauth', flow: 'manual-pkce' },
    // 目录键沿用今天的读法(自己的 id);列表只留 Claude 家的型号。
    models: { kind: 'models.dev', key: 'claude-code', include: CLAUDE_CODE_MODEL_PATTERNS },
    billing: 'subscription',
    quotaSource: 'claude-code',
    modelRules: 'claude',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    supportsCustomBaseUrl: false,
    defaultModel: 'claude-sonnet-4-20250514',
  },
  {
    id: 'grok',
    origin: 'builtin',
    name: 'Grok',
    description: 'providers.desc.grok',
    icon: 'grok',
    dialect: 'grok',
    auth: { kind: 'apiKey' },
    models: { kind: 'models.dev', key: 'xai' },
    billing: 'api',
    modelRules: 'grok',
    defaultBaseUrl: 'https://api.x.ai/v1',
    supportsCustomBaseUrl: true,
    defaultModel: 'grok-3-latest',
  },
  {
    id: 'grok-oauth',
    origin: 'builtin',
    name: 'Grok (Subscription)',
    description: 'providers.desc.grok-oauth',
    icon: 'grok',
    dialect: 'grok-oauth',
    auth: { kind: 'oauth', flow: 'device-code' },
    // 与 grok 同一本 xAI 目录。
    models: { kind: 'models.dev', key: 'xai' },
    billing: 'subscription',
    modelRules: 'grok',
    defaultBaseUrl: 'https://api.x.ai/v1',
    supportsCustomBaseUrl: false,
    defaultModel: 'grok-3-latest',
  },
  /**
   * Kimi Code(编程套餐)—— 订阅走 OAuth,与按量那条 `kimi` 是两个 provider:
   * 凭证、地址(套餐 host 固定,不跟 `kimi` 的地区档走)、账目三样都不同。
   * `supportsCustomBaseUrl: false`:套餐只认自己那一个 host。
   */
  {
    id: 'kimi-code',
    origin: 'builtin',
    name: 'Kimi Code (订阅)',
    description: 'providers.desc.kimi-code',
    icon: 'kimi',
    dialect: 'kimi-code',
    auth: { kind: 'oauth', flow: 'device-code' },
    // 套餐自己那本目录:型号名与按量那本一个都不重名。
    models: { kind: 'models.dev', key: ONETHING_KIMI_CODE_MODELS_DEV_ID },
    billing: 'subscription',
    modelRules: 'kimi',
    defaultBaseUrl: ONETHING_KIMI_CODING_PLAN_BASE_URL,
    supportsCustomBaseUrl: false,
    // 套餐目录里真有的 id;写按量那本的名字会 404。
    defaultModel: ONETHING_KIMI_CODE_DEFAULT_MODEL,
  },
  {
    id: 'github-copilot',
    origin: 'builtin',
    name: 'GitHub Copilot',
    description: 'providers.desc.github-copilot',
    icon: 'github',
    dialect: 'github-copilot',
    auth: { kind: 'oauth', flow: 'device-code' },
    // 列表拿着 OAuth token 现取;上下文长度等能力事实仍从 models.dev 那本补。
    models: { kind: 'endpoint', catalogKey: 'github-copilot' },
    billing: 'subscription',
    modelRules: 'copilot',
    defaultBaseUrl: 'https://api.individual.githubcopilot.com',
    supportsCustomBaseUrl: false,
    defaultModel: 'gpt-4o',
  },
  {
    id: 'codex',
    origin: 'builtin',
    name: 'Codex',
    description: 'providers.desc.codex',
    icon: 'codex',
    dialect: 'codex',
    auth: { kind: 'oauth', flow: 'pkce-callback' },
    models: { kind: 'endpoint' },
    billing: 'subscription',
    quotaSource: 'codex',
    modelRules: 'codex',
    behaviors: {
      separateDeveloperMessages: true,
      skipCompactOnUsageMismatch: true,
      imageOutputViaNativeToolOnly: true,
    },
    defaultBaseUrl: 'https://chatgpt.com/backend-api/codex',
    supportsCustomBaseUrl: false,
    defaultModel: 'gpt-5.3-codex',
  },
  {
    id: 'acp',
    origin: 'builtin',
    name: 'ACP Agents',
    description: 'providers.desc.acp',
    icon: 'acp',
    dialect: EXTERNAL_AGENT_DIALECT_ID,
    auth: { kind: 'none' },
    models: { kind: 'roster' },
    billing: 'api',
    modelRules: 'acp',
    defaultBaseUrl: '',
    supportsCustomBaseUrl: false,
    defaultModel: 'claude-code',
  },
]

/**
 * 同家的另一半(`sibling` / `familyTag`)**不写在上面的字面量里**,而是读
 * `@shared/provider-families` 的家族表补上:那张表还要喂 `@onething/client` 与后端发送路的
 * `isProviderEnabledIn`(家族读法),而 `@shared` 契约不许反向依赖 runtime(边界门
 * 「shared contracts depend on a product/backend implementation」)。所以家族这一格的产地
 * 在 `@shared`,manifest 读它;别处一律读 manifest 的 `sibling`,不再各自查家族表。
 */
function withFamily(manifest: ProviderManifest): ProviderManifest {
  const family = providerFamilyOf(manifest.id)
  if (!family) return manifest
  const isSubscription = family.subscriptionProviderId === manifest.id
  return {
    ...manifest,
    sibling: isSubscription ? family.apiProviderId : family.subscriptionProviderId,
    ...(isSubscription ? { familyTag: family.subscriptionTag } : {}),
  }
}

export const BUILTIN_PROVIDER_MANIFESTS: readonly ProviderManifest[] = BUILTIN_LITERALS.map(withFamily)

/** 壳用:只查内置表,不经进程注册表(那里还有自定义的)。 */
export function getBuiltinProviderManifest(id: string | undefined | null): ProviderManifest | undefined {
  return id ? BUILTIN_PROVIDER_MANIFESTS.find((manifest) => manifest.id === id) : undefined
}

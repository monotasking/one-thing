/**
 * `openrouter` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1 / P2)。
 *
 * 这一家的**数据**全在这里:显示名、方言、目录、读密钥的环境变量、型号规则。
 * 通用代码只读这些字段,不写「openrouter」。行为(方言、运行时工厂、余额源)在同目录的
 * `runtime.ts` 及其伙伴。
 *
 * 纯模块:壳也 import(经 `vendors/provider-vendor-manifests.ts`),不许碰 node / agent-loop(余额源
 * `quota.ts` 要记日志,所以只由 `runtime.ts` 带,这里不 import 它)。
 */
import type { ProviderManifest } from '../../provider-manifest.js'

/** 网关的统一 `reasoning.effort` 值域(从 `provider-model-capability.ts` 搬来)。 */
export const ONETHING_OPENROUTER_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export const OPENROUTER_MANIFEST: ProviderManifest = {
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
  // 用户能在思考覆盖(`reasoningProfile.wire`)里点名的线型(见 `ProviderManifest.reasoningWires`)。
  reasoningWires: ['openrouter-reasoning'],
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  supportsCustomBaseUrl: false,
  defaultModel: 'openai/gpt-4o',
  envVars: ['OPENROUTER_API_KEY'],
  // 认亲:这家的目录是「厂牌/型号」总表(从 `provider-model-identity.ts` 第 ① 级的点名搬来)。它自己不是哪个
  // 型号厂牌的第一方,所以厂牌与目录键两格都是空表 —— 不进厂牌别名表。
  modelIdentity: { brands: [], keys: [], aggregator: true },
  // 型号规则表(从 `provider-model-capability.ts` 的 `PROVIDER_MODEL_RULES.openrouter` 搬来,逐字)。
  modelRuleTable: [
    // Capability comes from the registry; the profile applies once reasoning is known.
    {
      test: /(?:)/,
      caps: { vision: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: ONETHING_OPENROUTER_EFFORTS,
        defaultEffort: 'high',
        wire: 'openrouter-reasoning',
      },
    },
  ],
  // 出厂设置里的那一条,逐字照搬自 P3 之前 `@shared/defaults/settings.ts` 的默认表(见 `ProviderSeed`)。
  seed: {
    apiKey: '',
    model: 'openai/gpt-4o',
    selectedModels: [],
    enabled: false,
  },
}

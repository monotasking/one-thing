/**
 * `openrouter` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1 / P2)。
 *
 * 这一家的**数据**全在这里:显示名、方言、目录、读密钥的环境变量、型号规则。
 * 通用代码只读这些字段,不写「openrouter」。行为(方言、运行时工厂、余额源)在同目录的
 * `runtime.ts` 及其伙伴。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`),不许碰 node / agent-loop(余额源
 * `quota.ts` 要记日志,所以只由 `runtime.ts` 带,这里不 import 它)。
 */
import type { ProviderManifest } from '../../manifest.js'

/** 网关的统一 `reasoning.effort` 值域(从 `model-capability.ts` 搬来)。 */
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
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  supportsCustomBaseUrl: false,
  defaultModel: 'openai/gpt-4o',
  envVars: ['OPENROUTER_API_KEY'],
  // 型号规则表(从 `model-capability.ts` 的 `PROVIDER_MODEL_RULES.openrouter` 搬来,逐字)。
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
}

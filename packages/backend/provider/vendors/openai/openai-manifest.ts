/**
 * `openai`(OpenAI 官方端点)的自述(`docs/design/architecture-direction-2026-10.md` §4 P1 / P2)。
 *
 * 这一家的**数据**全在这里:显示名、方言、目录、读密钥的环境变量、模型认亲、目录别名、
 * 型号规则表。通用代码只读这些字段,不写这家的名字。行为(方言、运行时工厂)在同目录的
 * `runtime.ts` 及其伙伴。
 *
 * 型号规则表由这一家带(它是 `modelRules: 'openai'` 那张表的主人);接口类型为 openai 的自定义
 * 服务商借用它。表里读的「gpt-5.x 收哪几档思考」是**型号家族**的知识,住
 * `providers/model-families/openai.ts`。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`),不许碰 node / agent-loop。
 */
import type { ProviderManifest } from '../../provider-manifest.js'
import { onethingOpenAIReasoningProfile } from '../../model-families/openai.js'

export const OPENAI_MANIFEST: ProviderManifest = {
  id: 'openai',
  origin: 'builtin',
  name: 'OpenAI',
  description: 'providers.desc.openai',
  icon: 'openai',
  dialect: 'openai',
  auth: { kind: 'apiKey' },
  models: { kind: 'models.dev', key: 'openai' },
  billing: 'api',
  // 家族里的哪一半(两半的对应登记在 `vendors/manifests.ts` 的 `VENDOR_FAMILIES`)。
  family: { role: 'api' },
  modelRules: 'openai',
  defaultBaseUrl: 'https://api.openai.com/v1',
  supportsCustomBaseUrl: true,
  defaultModel: 'gpt-4o-mini',
  envVars: ['OPENAI_API_KEY'],
  modelIdentity: { brands: ['openai'], keys: ['openai'] },
  catalogAliases: ['openai'],
  modelRuleTable: [
    // Anchored to the id start, tolerating "vendor/" path prefixes.
    { test: /(?:^|\/)(o[134]|gpt-5)/, caps: { reasoning: true }, profile: onethingOpenAIReasoningProfile },
    // Kind-level vision default mirrors the engine's historical provider-level flag.
    { test: /(?:)/, caps: { reasoning: false, vision: true } },
  ],
  // 出厂设置里的那一条,逐字照搬自 P3 之前 `@shared/defaults/settings.ts` 的默认表(见 `ProviderSeed`)。
  seed: {
    apiKey: '',
    model: 'gpt-4o',
    selectedModels: [],
    enabled: false,
  },
}

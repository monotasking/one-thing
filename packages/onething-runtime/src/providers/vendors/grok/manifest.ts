/**
 * `grok`(xAI,按量 API key)的自述(`docs/design/architecture-direction-2026-10.md` §4 P1 / P2)。
 *
 * 这一家的**数据**全在这里:显示名、方言、目录、模型认亲、目录别名、型号规则表。行为(方言、
 * 思考线型、运行时工厂、兜底行)在同目录的 `runtime.ts` 及其伙伴。
 *
 * 型号规则表由这一家带(它是 `modelRules: 'grok'` 那张表的主人);订阅那半边 `grok-oauth` 借用它。
 * 认亲那一行(`x-ai` / `xai` / `grok` → models.dev 的 `xai`)也只由这一家带,两半共用一本目录。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`),不许碰 node / agent-loop。
 */
import type { ProviderManifest } from '../../manifest.js'

/** grok-4.5 的三档(从 `model-capability.ts` 搬回家,逐字)。 */
export const ONETHING_GROK_EFFORTS = ['low', 'medium', 'high'] as const

export const GROK_MANIFEST: ProviderManifest = {
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
  modelIdentity: { brands: ['x-ai', 'xai', 'grok'], keys: ['xai'] },
  catalogAliases: ['xai'],
  modelRuleTable: [
    { test: /non-reasoning|grok-imagine/, caps: { reasoning: false, vision: true } },
    {
      test: /grok-4\.(?:6(?:$|-)|20.*multi-agent)/,
      caps: { reasoning: true },
      profile: {
        toggleable: false,
        defaultOn: true,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
        disabledEffort: 'low',
        wire: 'grok-effort',
      },
    },
    {
      // xAI capability guide (2026-09-16): 4.5 cannot disable reasoning;
      // xhigh is not a distinct supported level on this model.
      test: /grok-4\.5(?:$|-)/,
      caps: { reasoning: true },
      profile: {
        toggleable: false, defaultOn: true, efforts: ONETHING_GROK_EFFORTS,
        defaultEffort: 'high', disabledEffort: 'low', wire: 'grok-effort',
      },
    },
    {
      // Model-specific 4.3 docs list none / low / medium / high, default low.
      test: /grok-4\.3(?:$|-)/,
      caps: { reasoning: true },
      profile: {
        toggleable: true, defaultOn: true, efforts: ['none', 'low', 'medium', 'high'],
        defaultEffort: 'low', wire: 'grok-effort',
      },
    },
    {
      test: /grok-3-mini(?:$|-)/,
      caps: { reasoning: true },
      profile: {
        toggleable: false, defaultOn: true, efforts: ['low', 'high'],
        defaultEffort: 'low', disabledEffort: 'low', wire: 'grok-effort',
      },
    },
    {
      // Older reasoning families do not expose a configurable effort knob.
      test: /grok-4(?:$|-)|grok-4\.(?:1|20)(?:$|-)|grok-code-fast/,
      caps: { reasoning: true },
      profile: {
        toggleable: false, defaultOn: true, efforts: [], defaultEffort: 'high',
        wire: 'grok-effort',
      },
    },
    { test: /(?:)/, caps: { reasoning: false, vision: true } },
  ],
}

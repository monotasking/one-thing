/**
 * `gemini`(Google 官方 Generative Language 端点)的自述(`docs/design/architecture-direction-2026-10.md`
 * §4 P1 / P2)。
 *
 * 这一家的**数据**全在这里:显示名、方言、目录、读密钥的环境变量、模型认亲、目录别名、
 * 型号规则表。通用代码只读这些字段,不写这家的名字。行为(方言、运行时工厂)在同目录的
 * `runtime.ts` 及其伙伴。
 *
 * 型号规则表由这一家带(`modelRules: 'gemini'` 那张表的主人;点名 `gemini` 方言的自定义服务商
 * 借用它)。表里读的「gemini 2.5 收预算、3.x 收档位、每代接受哪几档」是**型号家族**的知识,
 * 住 `providers/model-families/gemini.ts`。
 *
 * 纯模块:壳也 import(经 `vendors/provider-vendor-manifests.ts`),不许碰 node / agent-loop。
 */
import type { ProviderManifest } from '../../provider-manifest.js'
import {
  onethingGeminiReasoningProfile,
  onethingGeminiReasoningWire,
} from '../../model-families/provider-model-families-gemini.js'

export const GEMINI_MANIFEST: ProviderManifest = {
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
  envVars: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
  modelIdentity: { brands: ['google', 'gemini'], keys: ['google'] },
  catalogAliases: ['google'],
  modelRuleTable: [
    // Google 官方端点的图像模型(`gemini-*-image*`)**同时是聊天模型**:图在回合内
    // 以 `inlineData` part 回来(P4-2)。目录缺席时账本也必须答出 imageOutput=true,
    // 否则 `imageOutputServedBy` 无从判成 'in-loop',生图路由
    // (`onethingModelSupportsImageGeneration`)就会把它换到专用生图流。
    // 这一行只答 imageOutput,reasoning/wire 继续落到下面两行。
    { test: /image/, caps: { imageOutput: true } },
    { test: /gemini-(?:2\.5|[3-9])/, caps: { reasoning: true }, profile: onethingGeminiReasoningProfile },
    // Even a model the ledger grants no reasoning to has a wire format: the
    // gemini wire must know which of the two thinking encoders to reach for.
    { test: /(?:)/, caps: { reasoning: false, vision: true }, wire: onethingGeminiReasoningWire },
  ],
  // 出厂设置里的那一条,逐字照搬自 P3 之前 `@shared/defaults/settings.ts` 的默认表(见 `ProviderSeed`)。
  seed: {
    apiKey: '',
    model: 'gemini-2.0-flash-exp',
    selectedModels: [],
    enabled: false,
  },
}

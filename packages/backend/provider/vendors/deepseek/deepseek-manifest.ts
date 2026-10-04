/**
 * `deepseek` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1 / P2)。
 *
 * 这一家的**数据**全在这里:显示名、方言、目录、读密钥的环境变量、模型认亲、型号规则。
 * 通用代码只读这些字段,不写「deepseek」。行为(方言、思考参数、运行时工厂、余额源)在
 * 同目录的 `runtime.ts` 及其伙伴。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`),不许碰 node / agent-loop。
 */
import type { ProviderManifest } from '../../provider-manifest.js'

/**
 * DeepSeek 只收 high / max 两档。千问端点转售的 GLM / DeepSeek 也沿用这一对
 * 从 `model-capability.ts` 搬来。
 */
const ONETHING_DEEPSEEK_EFFORTS = ['high', 'max'] as const

export const DEEPSEEK_MANIFEST: ProviderManifest = {
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
  envVars: ['DEEPSEEK_API_KEY'],
  modelIdentity: { brands: ['deepseek', 'deepseek-ai'], keys: ['deepseek'] },
  catalogAliases: ['deepseek'],
  // 型号规则表(从 `model-capability.ts` 的 `PROVIDER_MODEL_RULES.deepseek` 搬来,逐字)。
  modelRuleTable: [
    {
      // DeepSeek 的图片输入只在 vision 实验族上(`image_url` / `file` 块,
      // 且只在 user 消息里)。这一行**只给 vision**,不给 reasoning ——
      // `fromRules` 对每个能力独立取「第一条给出布尔值的行」,所以
      // `deepseek-v4-*-vision-exp` 的 reasoning 仍由下面那条 v4 行决定。
      test: /vision/,
      caps: { vision: true },
    },
    {
      // V4.1 起官方目录改名为 `deepseek-flash` / `deepseek-pro`(models.dev 名字仍写
      // 「DeepSeek V4.1 Flash」),id 里不再带 v4 —— 只认 v4 的话它会落进下面那条
      // 兜底行,抽屉里档位整条消失。
      test: /(^|[^a-z])v4|^deepseek-(flash|pro)(\b|$)/,
      caps: { reasoning: true },
      profile: {
        toggleable: true,
        // 官方原文:「思考模式默认打开,且 effort 默认为 high」—— 不传
        // `thinking` 时服务端自己在想,所以这里是 true(#6;旧注释「不传
        // 就不想」把这条写反了)。
        defaultOn: true,
        efforts: ONETHING_DEEPSEEK_EFFORTS,
        defaultEffort: 'high',
        wire: 'thinking-type',
      },
    },
    {
      // deepseek-reasoner always thinks and exposes no knob — the chat UI
      // keeps its legacy model-pair toggle (chat ⇄ reasoner) instead.
      test: /reasoner/,
      caps: { reasoning: true },
      profile: {
        toggleable: false,
        defaultOn: true,
        efforts: [],
        defaultEffort: 'high',
        wire: 'none',
      },
    },
    { test: /(?:)/, caps: { reasoning: false } },
  ],
  // 出厂设置里的那一条,逐字照搬自 P3 之前 `@shared/defaults/settings.ts` 的默认表(见 `ProviderSeed`)。
  seed: {
    apiKey: '',
    model: 'deepseek-chat',
    selectedModels: [],
    enabled: false,
  },
}

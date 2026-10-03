/**
 * `github-copilot`(订阅)的自述(`docs/design/architecture-direction-2026-10.md` §4 P1 / P2)。
 *
 * 这一家的**数据**全在这里:显示名、方言、目录、型号规则表。行为(方言、运行时工厂、OAuth、
 * 列表口、兜底行)在同目录的 `runtime.ts` 及其伙伴。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`),不许碰 node / agent-loop。
 */
import type { ProviderManifest } from '../../manifest.js'

// Copilot 后台卖的型号能力按名字判(四种能力;文件输入不在这张表里,落到缺省)。这四个正则说的是
// 「Copilot 这张货架上哪些型号会什么」,只有这一家读,所以跟着它的规则表回家(从 `model-capability.ts`
// 的 `COPILOT_*` 与 `copilotPatternVerdict` 搬来,逐字)。
const COPILOT_REASONING_PATTERN = /o1|o3|o4|deepseek-r1|reasoner/
const COPILOT_VISION_PATTERN = /gpt-4o|gpt-4-turbo|gpt-4-vision|gpt-4\.1|claude-3|claude-sonnet-4|claude-opus|gemini-1\.5|gemini-2|gemini-pro-vision/
const COPILOT_IMAGE_GEN_PATTERN = /dall-e|dalle|gpt-image|imagen/
const COPILOT_NO_TOOLS_PATTERN = /o1-preview|o1-mini/

export const GITHUB_COPILOT_MANIFEST: ProviderManifest = {
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
  modelRuleTable: [
    // 一行管全部型号:四种能力**恒有答案**(目录之后、缺省之前,与搬家前账本里那条
    // `kind === 'copilot'` 的专门分支同一位置、同一答案)。这一行不带 `profile` / `wire`,
    // 于是思考档案、线型、`temperature`、`fileInput`、`forcedToolUse` 都照旧落到缺省。
    {
      test: /(?:)/,
      caps: (modelLower) => ({
        reasoning: COPILOT_REASONING_PATTERN.test(modelLower),
        vision: COPILOT_VISION_PATTERN.test(modelLower),
        imageOutput: COPILOT_IMAGE_GEN_PATTERN.test(modelLower),
        tools: !COPILOT_NO_TOOLS_PATTERN.test(modelLower) && !COPILOT_IMAGE_GEN_PATTERN.test(modelLower),
      }),
    },
  ],
  // 出厂设置里的那一条,逐字照搬自 P3 之前 `@shared/defaults/settings.ts` 的默认表(见 `ProviderSeed`)。
  seed: {
    model: 'gpt-4o',
    selectedModels: [],
    authType: 'oauth',
    enabled: false,
  },
}

/**
 * `claude`(Anthropic 官方端点)的自述(`docs/design/architecture-direction-2026-10.md` §4 P1 / P2)。
 *
 * 这一家的**数据**全在这里:显示名、方言、目录、读密钥的环境变量、模型认亲、目录别名、
 * 型号规则表。通用代码只读这些字段,不写这家的名字。行为(方言、运行时工厂)在同目录的
 * `runtime.ts` 及其伙伴。
 *
 * 型号规则表由这一家带(它是 `modelRules: 'claude'` 那张表的主人);订阅那半边 `claude-code`
 * 与接口类型为 anthropic 的自定义服务商借用它。表里读的「claude-* 是哪一代」是**型号家族**
 * 的知识,住 `providers/model-families/claude.ts`。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`),不许碰 node / agent-loop。
 */
import type { ProviderManifest } from '../../provider-manifest.js'
import {
  onethingClaudeModelFamily,
  onethingClaudeReasoningProfile,
} from '../../model-families/claude.js'

export const CLAUDE_MANIFEST: ProviderManifest = {
  id: 'claude',
  origin: 'builtin',
  name: 'Claude',
  description: 'providers.desc.claude',
  icon: 'claude',
  dialect: 'claude',
  auth: { kind: 'apiKey' },
  models: { kind: 'models.dev', key: 'anthropic' },
  billing: 'api',
  // 家族里的哪一半(两半的对应登记在 `vendors/manifests.ts` 的 `VENDOR_FAMILIES`)。
  family: { role: 'api' },
  modelRules: 'claude',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  supportsCustomBaseUrl: true,
  defaultModel: 'claude-sonnet-4-20250514',
  envVars: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  modelIdentity: { brands: ['anthropic'], keys: ['anthropic'] },
  catalogAliases: ['anthropic'],
  modelRuleTable: [
    // Every currently served Claude chat model supports thinking. 4.7+ /
    // Sonnet 5 / Fable reject sampling params (temperature) outright.
    {
      test: /(?:)/,
      caps: model => ({
        reasoning: true,
        vision: true,
        tools: true,
        temperature: !onethingClaudeModelFamily(model).samplingRemoved,
        // Forced tool use is paired with thinking off, and Fable/Mythos cannot
        // take that half of the bargain (the API rejects an explicit
        // `disabled`) — so the honest answer is that they cannot be forced.
        forcedToolUse: !onethingClaudeModelFamily(model).alwaysThinking,
      }),
      profile: onethingClaudeReasoningProfile,
    },
  ],
  // 出厂设置里的那一条,逐字照搬自 P3 之前 `@shared/defaults/settings.ts` 的默认表(见 `ProviderSeed`)。
  seed: {
    apiKey: '',
    model: 'claude-sonnet-4-5-20250929',
    selectedModels: [],
    enabled: false,
  },
}

/**
 * `codex`(ChatGPT 订阅)的自述(`docs/design/architecture-direction-2026-10.md` §4 P1 / P2)。
 *
 * 这一家的**数据**全在这里:显示名、方言、目录、配额源、行为开关、型号规则表。行为(方言、
 * 运行时工厂、配额源、OAuth、列表口、兜底行)在同目录的 `runtime.ts` 及其伙伴。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`),不许碰 node / agent-loop。
 */
import type { ProviderManifest } from '../../manifest.js'

/** 目录里没报档位时(兜底行 / 旧缓存)的五档(从 `model-capability.ts` 搬回家,逐字)。 */
export const ONETHING_CODEX_FALLBACK_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

export const CODEX_MANIFEST: ProviderManifest = {
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
  modelRuleTable: [
    {
      test: /(?:)/,
      caps: { reasoning: true, vision: true, tools: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: ONETHING_CODEX_FALLBACK_EFFORTS,
        defaultEffort: 'medium',
        wire: 'codex',
      },
    },
  ],
}

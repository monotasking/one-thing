/**
 * `claude-code` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1:每家的 manifest 住在自己家)。
 *
 * 纯模块:壳也 import(经 `vendors/provider-vendor-manifests.ts`)。
 */
import type { ProviderManifest } from '../../provider-manifest.js'

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

export const CLAUDE_CODE_MANIFEST: ProviderManifest = {
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
  // 家族里的订阅那一半;`tag` 是合并卡片上的小标签(两半的对应登记在 `vendors/provider-vendor-manifests.ts`)。
  family: { role: 'subscription', tag: 'Claude Code' },
  quotaSource: 'claude-code',
  modelRules: 'claude',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  supportsCustomBaseUrl: false,
  defaultModel: 'claude-sonnet-4-20250514',
  // 出厂设置里的那一条,逐字照搬自 P3 之前 `@shared/defaults/settings.ts` 的默认表(见 `ProviderSeed`)。
  seed: {
    model: 'claude-sonnet-4-20250514',
    selectedModels: [],
    authType: 'oauth',
    enabled: false,
  },
}

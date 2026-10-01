/**
 * `claude-code` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1:每家的 manifest 住在自己家)。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`)。
 */
import type { ProviderManifest } from '../../manifest.js'

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
  quotaSource: 'claude-code',
  modelRules: 'claude',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  supportsCustomBaseUrl: false,
  defaultModel: 'claude-sonnet-4-20250514',
}

/**
 * `claude` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1:每家的 manifest 住在自己家)。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`)。
 */
import type { ProviderManifest } from '../../manifest.js'

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
  modelRules: 'claude',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  supportsCustomBaseUrl: true,
  defaultModel: 'claude-sonnet-4-20250514',
}

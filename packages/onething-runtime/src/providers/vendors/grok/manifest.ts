/**
 * `grok` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1:每家的 manifest 住在自己家)。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`)。
 */
import type { ProviderManifest } from '../../manifest.js'

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
}

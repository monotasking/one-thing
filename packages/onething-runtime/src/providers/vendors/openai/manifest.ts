/**
 * `openai` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1:每家的 manifest 住在自己家)。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`)。
 */
import type { ProviderManifest } from '../../manifest.js'

export const OPENAI_MANIFEST: ProviderManifest = {
  id: 'openai',
  origin: 'builtin',
  name: 'OpenAI',
  description: 'providers.desc.openai',
  icon: 'openai',
  dialect: 'openai',
  auth: { kind: 'apiKey' },
  models: { kind: 'models.dev', key: 'openai' },
  billing: 'api',
  modelRules: 'openai',
  defaultBaseUrl: 'https://api.openai.com/v1',
  supportsCustomBaseUrl: true,
  defaultModel: 'gpt-4o-mini',
}

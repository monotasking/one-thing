/**
 * `openrouter` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1:每家的 manifest 住在自己家)。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`)。
 */
import type { ProviderManifest } from '../../manifest.js'

export const OPENROUTER_MANIFEST: ProviderManifest = {
  id: 'openrouter',
  origin: 'builtin',
  name: 'OpenRouter',
  description: 'providers.desc.openrouter',
  icon: 'openrouter',
  dialect: 'openrouter',
  auth: { kind: 'apiKey' },
  models: { kind: 'models.dev', key: 'openrouter' },
  billing: 'api',
  quotaSource: 'openrouter',
  modelRules: 'openrouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  supportsCustomBaseUrl: false,
  defaultModel: 'openai/gpt-4o',
}

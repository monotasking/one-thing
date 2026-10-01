/**
 * `codex` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1:每家的 manifest 住在自己家)。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`)。
 */
import type { ProviderManifest } from '../../manifest.js'

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
}

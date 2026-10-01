/**
 * `gemini` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1:每家的 manifest 住在自己家)。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`)。
 */
import type { ProviderManifest } from '../../manifest.js'

export const GEMINI_MANIFEST: ProviderManifest = {
  id: 'gemini',
  origin: 'builtin',
  name: 'Google Gemini',
  description: 'providers.desc.gemini',
  icon: 'gemini',
  dialect: 'gemini',
  auth: { kind: 'apiKey' },
  models: { kind: 'models.dev', key: 'google' },
  billing: 'api',
  modelRules: 'gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  supportsCustomBaseUrl: true,
  defaultModel: 'gemini-2.0-flash-exp',
}

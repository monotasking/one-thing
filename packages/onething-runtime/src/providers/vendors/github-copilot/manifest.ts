/**
 * `github-copilot` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1:每家的 manifest 住在自己家)。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`)。
 */
import type { ProviderManifest } from '../../manifest.js'

export const GITHUB_COPILOT_MANIFEST: ProviderManifest = {
  id: 'github-copilot',
  origin: 'builtin',
  name: 'GitHub Copilot',
  description: 'providers.desc.github-copilot',
  icon: 'github',
  dialect: 'github-copilot',
  auth: { kind: 'oauth', flow: 'device-code' },
  // 列表拿着 OAuth token 现取;上下文长度等能力事实仍从 models.dev 那本补。
  models: { kind: 'endpoint', catalogKey: 'github-copilot' },
  billing: 'subscription',
  modelRules: 'copilot',
  defaultBaseUrl: 'https://api.individual.githubcopilot.com',
  supportsCustomBaseUrl: false,
  defaultModel: 'gpt-4o',
}

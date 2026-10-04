/**
 * `grok-oauth` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1:每家的 manifest 住在自己家)。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`)。
 */
import type { ProviderManifest } from '../../provider-manifest.js'

export const GROK_OAUTH_MANIFEST: ProviderManifest = {
  id: 'grok-oauth',
  origin: 'builtin',
  name: 'Grok (Subscription)',
  description: 'providers.desc.grok-oauth',
  icon: 'grok',
  dialect: 'grok-oauth',
  auth: { kind: 'oauth', flow: 'device-code' },
  // 与 grok 同一本 xAI 目录。
  models: { kind: 'models.dev', key: 'xai' },
  billing: 'subscription',
  // 家族里的订阅那一半;`tag` 是合并卡片上的小标签(两半的对应登记在 `vendors/manifests.ts`)。
  family: { role: 'subscription', tag: 'Subscription' },
  modelRules: 'grok',
  defaultBaseUrl: 'https://api.x.ai/v1',
  supportsCustomBaseUrl: false,
  defaultModel: 'grok-3-latest',
}

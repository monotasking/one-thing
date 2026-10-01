/**
 * `kimi` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1:每家的 manifest 住在自己家)。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`)。
 */
import type { ProviderManifest } from '../../manifest.js'
import { KIMI_DIALS } from '../../dials.js'
import {
  ONETHING_KIMI_DEFAULT_BASE_URL,
  normalizeOnethingKimiApiMode,
  normalizeOnethingKimiRegion,
  resolveOnethingKimiBaseUrl,
  resolveOnethingKimiModelsDevProviderId,
  type OnethingKimiEndpointConfig,
} from '../../kimi.js'

export const KIMI_MANIFEST: ProviderManifest = {
  id: 'kimi',
  origin: 'builtin',
  name: 'Kimi',
  description: 'providers.desc.kimi',
  icon: 'kimi',
  dialect: 'kimi',
  auth: { kind: 'apiKey' },
  // 按量/套餐 × 国内/海外:三个地址三本目录,按配置选。
  models: {
    kind: 'models.dev',
    key: 'moonshotai',
    keyOf: (config) => resolveOnethingKimiModelsDevProviderId(config as OnethingKimiEndpointConfig | undefined),
  },
  billing: 'api',
  quotaSource: 'kimi',
  dials: KIMI_DIALS,
  modelRules: 'kimi',
  defaultBaseUrl: ONETHING_KIMI_DEFAULT_BASE_URL,
  supportsCustomBaseUrl: true,
  defaultModel: 'moonshot-v1-128k',
  endpoint: {
    // 按量 / 套餐 × 国内 / 海外:地址是这一对的查表,所以这两格永远带上、永远完整。
    pickOptions: (stored) => ({
      kimiApiMode: normalizeOnethingKimiApiMode(stored.kimiApiMode),
      kimiRegion: normalizeOnethingKimiRegion(stored.kimiRegion),
    }),
    resolveBaseUrl: (config) => resolveOnethingKimiBaseUrl(config as OnethingKimiEndpointConfig | undefined),
    entryFields: { apiMode: 'kimiApiMode', region: 'kimiRegion' },
    ownsBaseUrl: true,
  },
}

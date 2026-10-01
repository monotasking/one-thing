/**
 * `qwen` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1:每家的 manifest 住在自己家)。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`)。
 */
import type { ProviderManifest } from '../../manifest.js'
import { QWEN_DIALS } from '../../dials.js'
import {
  ONETHING_QWEN_DEFAULT_BASE_URL,
  ONETHING_QWEN_DEFAULT_MODEL,
  normalizeOnethingQwenApiMode,
  normalizeOnethingQwenRegion,
  resolveOnethingQwenBaseUrl,
  resolveOnethingQwenModelsDevProviderId,
  type OnethingQwenEndpointConfig,
} from '../../qwen.js'

export const QWEN_MANIFEST: ProviderManifest = {
  id: 'qwen',
  origin: 'builtin',
  name: '千问',
  description: 'providers.desc.qwen',
  icon: 'qwen',
  dialect: 'qwen',
  auth: { kind: 'apiKey' },
  // 国内/海外 × 按量/Token Plan:四本目录,按配置选。
  models: {
    kind: 'models.dev',
    key: 'alibaba-cn',
    keyOf: (config) => resolveOnethingQwenModelsDevProviderId(config as OnethingQwenEndpointConfig | undefined),
  },
  billing: 'api',
  dials: QWEN_DIALS,
  modelRules: 'qwen',
  defaultBaseUrl: ONETHING_QWEN_DEFAULT_BASE_URL,
  supportsCustomBaseUrl: true,
  defaultModel: ONETHING_QWEN_DEFAULT_MODEL,
  endpoint: {
    // 两个归一函数都回落到缺省值而不是 undefined,所以千问永远有这一袋 —— 地址取决于这一对。
    pickOptions: (stored) => ({
      qwenApiMode: normalizeOnethingQwenApiMode(stored.qwenApiMode),
      qwenRegion: normalizeOnethingQwenRegion(stored.qwenRegion),
    }),
    resolveBaseUrl: (config) => resolveOnethingQwenBaseUrl(config as OnethingQwenEndpointConfig | undefined),
    entryFields: { apiMode: 'qwenApiMode', region: 'qwenRegion' },
    ownsBaseUrl: true,
  },
}

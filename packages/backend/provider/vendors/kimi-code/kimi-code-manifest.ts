/**
 * `kimi-code` 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1:每家的 manifest 住在自己家)。
 *
 * 纯模块:壳也 import(经 `vendors/provider-vendor-manifests.ts`)。
 */
import type { ProviderManifest } from '../../provider-manifest.js'
import { ONETHING_KIMI_CODING_PLAN_BASE_URL } from '../kimi/kimi-endpoint.js'

/** 编程套餐在 models.dev 上的目录键(它的 `api` 字段正是套餐那个地址)。 */
export const ONETHING_KIMI_CODE_MODELS_DEV_ID = 'kimi-for-coding'

/** 套餐目录里那几个 id —— 与按量那本一个都不重名。 */
export const ONETHING_KIMI_CODE_DEFAULT_MODEL = 'k3'

/**
 * Kimi Code(编程套餐)—— 订阅走 OAuth,与按量那条 `kimi` 是两个 provider:
 * 凭证、地址(套餐 host 固定,不跟 `kimi` 的地区档走)、账目三样都不同。
 * `supportsCustomBaseUrl: false`:套餐只认自己那一个 host。
 */
export const KIMI_CODE_MANIFEST: ProviderManifest = {
  id: 'kimi-code',
  origin: 'builtin',
  name: 'Kimi Code (订阅)',
  description: 'providers.desc.kimi-code',
  icon: 'kimi',
  dialect: 'kimi-code',
  auth: { kind: 'oauth', flow: 'device-code' },
  // 套餐自己那本目录:型号名与按量那本一个都不重名。
  models: { kind: 'models.dev', key: ONETHING_KIMI_CODE_MODELS_DEV_ID },
  billing: 'subscription',
  // 家族里的订阅那一半;`tag` 是合并卡片上的小标签(两半的对应登记在 `vendors/provider-vendor-manifests.ts`)。
  family: { role: 'subscription', tag: 'Kimi Code' },
  modelRules: 'kimi',
  defaultBaseUrl: ONETHING_KIMI_CODING_PLAN_BASE_URL,
  supportsCustomBaseUrl: false,
  // 套餐目录里真有的 id;写按量那本的名字会 404。
  defaultModel: ONETHING_KIMI_CODE_DEFAULT_MODEL,
  // 空间凭证条目的档位 / 地区格与按量那条 `kimi` 同名(同一张设置表);地址由条目说了算。
  // 套餐 host 固定,所以没有 `pickOptions` / `resolveBaseUrl`(与搬家前逐字同口径)。
  endpoint: {
    entryFields: { apiMode: 'kimiApiMode', region: 'kimiRegion' },
    ownsBaseUrl: true,
  },
  // 出厂设置里的那一条,逐字照搬自 P3 之前 `@shared/defaults/settings.ts` 的默认表(见 `ProviderSeed`)。
  // 订阅档:没有 apiKey 这一格 —— 凭证是 OAuth token,存在 token store 里。
  seed: {
    authType: 'oauth',
    // 套餐目录(models.dev `kimi-for-coding`)里的 id,与按量那本不重名。
    model: 'k3',
    selectedModels: [],
    enabled: false,
  },
}

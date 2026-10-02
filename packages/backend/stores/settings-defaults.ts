/**
 * 出厂设置 —— **预先绑好 provider 种子表**的那一份(服务商自述试点 P3,
 * `docs/design/architecture-direction-2026-10.md` §4)。
 *
 * `@shared/defaults/settings` 的 `createDefaultSettings` / `mergeWithDefaults` 不再认识任何一家
 * 服务商:各家的出厂配置住在自己的 manifest(`seed`),契约层又不许反向依赖 runtime。所以由这里
 * 按名册拼出种子表、绑进去;装配层里要出厂设置的地方一律从这里拿,不直接调 `@shared` 那两个。
 *
 * 种子表的键序 = 各家 manifest 的 `seed` 按 `VENDOR_SEED_ORDER`(没有 `seed` 的家跳过),再接
 * `@shared` 的两条非服务商(`acp`、`custom`)—— 与 P3 之前那张大表逐字同序
 * (`stores/__tests__/settings-defaults.freeze.test.ts` 钉着)。
 */
import type { AppSettings, ProviderConfig } from '@shared/ipc.js'
import {
  createDefaultSettings as createDefaultSettingsWithSeeds,
  mergeWithDefaults as mergeWithDefaultsWithSeeds,
  NON_VENDOR_PROVIDER_SEEDS,
  type ProviderSeedTable,
} from './defaults/settings.js'
import { VENDOR_SEED_ORDER } from '@onething/backend/runtime/providers/vendors/manifests'

function buildProviderSeedTable(): ProviderSeedTable {
  const providers: Record<string, ProviderConfig> = {}
  for (const manifest of VENDOR_SEED_ORDER) {
    if (manifest.seed) providers[manifest.id] = manifest.seed as unknown as ProviderConfig
  }
  // 出厂默认用种子表的第一家(名册键序的第一行,今天是 openai —— 与 P3 之前那张表的
  // `provider` 同一个值)。
  const provider = Object.keys(providers)[0] ?? ''
  Object.assign(providers, NON_VENDOR_PROVIDER_SEEDS)
  return { provider, providers }
}

/**
 * 模块常量:里面的对象是各家 manifest 的 `seed` 本身,**只读**。交出去之前 `@shared` 那两个
 * 函数会深拷一份;本模块自己交出去的(`providerSeedOf`)也拷。
 */
const PROVIDER_SEED_TABLE: ProviderSeedTable = buildProviderSeedTable()

export function createDefaultSettings(): AppSettings {
  return createDefaultSettingsWithSeeds(PROVIDER_SEED_TABLE)
}

export function mergeWithDefaults(settings: Partial<AppSettings>): AppSettings {
  return mergeWithDefaultsWithSeeds(settings, PROVIDER_SEED_TABLE)
}

/** 这一家在出厂设置里的那一条(深拷);出厂设置里没有这一家 = `undefined`。 */
export function providerSeedOf(providerId: string): ProviderConfig | undefined {
  const seed = Object.prototype.hasOwnProperty.call(PROVIDER_SEED_TABLE.providers, providerId)
    ? PROVIDER_SEED_TABLE.providers[providerId]
    : undefined
  return seed ? (JSON.parse(JSON.stringify(seed)) as ProviderConfig) : undefined
}

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
 * (`settings/__tests__/settings-defaults.freeze.test.ts` 钉着)。
 */
import type { AppSettings, ProviderConfig } from '@shared/ipc.js'
import {
  createDefaultSettings as createDefaultSettingsWithSeeds,
  mergeWithDefaults as mergeWithDefaultsWithSeeds,
  NON_VENDOR_PROVIDER_SEEDS,
  type ProviderSeedTable,
} from './defaults/settings-factory-defaults.js'
import { VENDOR_SEED_ORDER } from '@onething/backend/provider'

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
 * 种子表:里面的对象是各家 manifest 的 `seed` 本身,**只读**。交出去之前 `@shared` 那两个
 * 函数会深拷一份;本模块自己交出去的(`providerSeedOf`)也拷。
 *
 * 2026-10-04 起它**第一次用到时才建**,不再在加载时建(`docs/design/provider-entry-2026-10.md` §7.7 第 5 条):
 * 加载时读名册,要看名册模块是不是已经初始化完 —— 本模块一旦与 providers 落在同一个 import 环上,读到的是不是
 * 已初始化的值要看谁先被 import。等价理由:表只由两张常量表(名册各行的 `seed`、`NON_VENDOR_PROVIDER_SEEDS`)
 * 算出来,不读设置、不碰磁盘;早建晚建算出的是同一张表,建一次以后同一个对象一直用。
 */
const providerSeedTable: { current?: ProviderSeedTable } = {}

function seedTable(): ProviderSeedTable {
  return (providerSeedTable.current ??= buildProviderSeedTable())
}

export function createDefaultSettings(): AppSettings {
  return createDefaultSettingsWithSeeds(seedTable())
}

export function mergeWithDefaults(settings: Partial<AppSettings>): AppSettings {
  return mergeWithDefaultsWithSeeds(settings, seedTable())
}

/** 这一家在出厂设置里的那一条(深拷);出厂设置里没有这一家 = `undefined`。 */
export function providerSeedOf(providerId: string): ProviderConfig | undefined {
  const table = seedTable()
  const seed = Object.prototype.hasOwnProperty.call(table.providers, providerId)
    ? table.providers[providerId]
    : undefined
  return seed ? (JSON.parse(JSON.stringify(seed)) as ProviderConfig) : undefined
}

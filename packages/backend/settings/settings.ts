/**
 * settings —— 设置:应用设置的读写缓存(按空间叠服务商设置)、出厂默认值、设置变更的广播、
 * 按用户代理去请求的受管 fetch,以及模型目录服务(目录缓存、手填模型、自定义服务商)。
 *
 * 对外交出六类东西(各段注释说明来历):设置缓存的读写;出厂设置与默认值;受管 fetch;模型目录服务;
 * 宿主注入口与设置变更广播;两只调试日志口的形状。
 * 依赖 provider、space、network、storage、logging。
 */

// ── 包根归位 2(2026-10-03)从包根 `stores/` 并进来的设置缓存、出厂设置与默认值表。外面真在用的名字逐个列出。
// 设置缓存(`settings-store.ts`)的仓储在第一次用到时才建(包根归位 B),所以 import 入口不读盘、不读设置。
// `createDefaultSettings` / `mergeWithDefaults` 在目录里有两份:入口交出的是 `settings-defaults.ts` 那份(带上各家
// 服务商名册里的出厂种子);`defaults/settings-factory-defaults.ts` 那份只带兜底种子,是前者的底子,外面只有测试直接用它。
export {
  getPersistedSettings,
  getSettings,
  getSpaceSettings,
  initializeSettings,
  invalidateSettingsCache,
  savePersistedSettings,
  saveSettings,
  updateSettingsInMemory,
} from './settings-store.js'
export { createDefaultSettings, mergeWithDefaults, providerSeedOf } from './settings-defaults.js'
export { DEFAULT_MUSIC_SETTINGS, normalizeConnectedDirectories } from './defaults/settings-factory-defaults.js'
export { composeEffectiveAISettings, createEmptySpaceProviderSettings, splitEffectiveAISettings } from './defaults/settings-defaults-ai.js'
// 包根归位 3 第 1 笔(2026-10-03)从包根 `provider-binding/bound-fetch.ts` 搬来的「按用户设置里的代理去请求」那层薄壳。
// 它读设置缓存,所以住在设置里;它包着的受管 fetch 本体在 `network/`。
export {
  clearAppDispatcherCache,
  createAppFetch,
  createPolicyFetch,
  createRequiredAppFetch,
} from './settings-proxy-fetch.js'

// ── providers 归位(D24,2026-10-04)从 `providers/` 搬来的模型目录服务三件:目录缓存与刷新
// (`settings-model-registry-service.ts`,整只以命名空间 `modelRegistry` 交出,调用处一律写 `modelRegistry.x`)、
// 手填模型、自定义服务商进 manifest 注册表。它们的数据都住在设置里。
export * as modelRegistry from './settings-model-registry-service.js'
export { configureModelCatalogCredentials, type ModelCatalogApiKeyResolver } from './settings-model-registry-service.js'
export {
  CustomProviderManifestSync,
} from './settings-custom-manifests.js'
export {
  addManualModel,
  foldedCatalogFor,
  persistManualOrphans,
  removeManualModel,
} from './settings-manual-model-store.js'
export {
  getModelCapabilityEntry,
} from './settings-model-registry-service.js'

// ── 宿主注入口与设置变更的广播(深层引用收口第四批补进入口)。
export { configureSettingsEventBroadcaster, getSettingsEventBroadcaster } from './settings-events.js'
export type { SettingsEvent, SettingsEventBroadcaster } from './settings-events.js'

// ── 调试日志口的形状。
export type { OnethingSettingsIpcLogger } from './settings-ipc-operations.js'
export type { OnethingSettingsRepositoryLogger } from './settings-repository.js'

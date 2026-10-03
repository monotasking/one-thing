export * from './ipc-operations.js'
export * from './settings-repository.js'
export * from './settings-save.js'

// ── 包根归位 2(2026-10-03)从包根 `stores/` 并进来的设置缓存、出厂设置与默认值表。外面真在用的名字逐个列出。
// 设置缓存(`settings-store.ts`)的仓储在第一次用到时才建(包根归位 B),所以 import 入口不读盘、不读设置。
// `createDefaultSettings` / `mergeWithDefaults` 在目录里有两份:入口交出的是 `settings-defaults.ts` 那份(带上各家
// 服务商名册里的出厂种子);`defaults/settings.ts` 那份只带兜底种子,是前者的底子,外面只有测试直接用它。
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
export { DEFAULT_MUSIC_SETTINGS, normalizeConnectedDirectories } from './defaults/settings.js'
export { composeEffectiveAISettings, createEmptySpaceProviderSettings, splitEffectiveAISettings } from './defaults/ai-settings.js'

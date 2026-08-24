import type { AppSettings, PersistedAppSettings } from '@shared/ipc.js'
import { createDefaultSettings, mergeWithDefaults } from '@shared/defaults/settings.js'
import { createOnethingSettingsRepository } from '@onething/runtime/settings'
import {
  readSpaceProviderSettings,
  writeSpaceProviderSettings,
} from '@onething/runtime/spaces/provider-settings'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import {
  hasSpaceProviderSettingsMigrated,
  resolveEffectiveAppSettings,
  splitEffectiveAISettings,
} from '../provider-binding/ai-settings-compose.js'
import { getOnethingSettingsPath } from '@onething/runtime/storage'
import { applyDiagnosticsMode } from '../wiring/logging/diagnostics.js'
import { consolePort, getLogger } from '../wiring/logging/index.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingSettingsRepositoryLogger } from '@onething/runtime/settings/settings-repository'

const log = getLogger('settings')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingSettingsRepositoryLogger = consolePort(log)


const settingsRepository = createOnethingSettingsRepository<AppSettings>({
  filePath: getOnethingSettingsPath,
  defaultValue: createDefaultSettings,
  normalize: value => mergeWithDefaults(value as Partial<AppSettings>),
  logger: consoleLog,
})

// ============================================================================
// Async Initialization (Recommended for startup)
// ============================================================================

/**
 * Initialize settings asynchronously at startup
 * This should be called once during app initialization before any getSettings() calls
 *
 * @returns Promise<AppSettings> - The loaded settings
 */
export function initializeSettings(): Promise<AppSettings> {
  return settingsRepository.initialize()
}

/**
 * Check if settings have been initialized
 */
export function isSettingsInitialized(): boolean {
  return settingsRepository.isInitialized()
}

// ============================================================================
// Persisted vs effective (C2)
// ============================================================================

/**
 * **持久化那一份**(`settings.json` 原样,不合成空间设置)。
 *
 * 只有两类调用方该用它:一次性迁移(它要读的正是迁移前的旧字段),以及
 * 本文件自己。其余所有人要的都是 `getSettings()` —— 生效形状。
 */
export function getPersistedSettings(): AppSettings {
  return settingsRepository.get()
}

/** 原样落盘,**不拆分**。同上,只给迁移用。 */
export function savePersistedSettings(settings: AppSettings | PersistedAppSettings): void {
  settingsRepository.save(settings as AppSettings)
}

// ============================================================================
// Sync Getters (Hot path - after initialization)
// ============================================================================

/**
 * 某个空间的**生效** settings:`settings.json` + 该空间的 `providers.json`(C2)。
 *
 * 无回落 —— 空间即空间。这个空间没有 providers.json 且迁移已跑过 = 它就是空的。
 */
export function getSpaceSettings(spaceId: string | undefined | null): AppSettings {
  return resolveEffectiveAppSettings(
    settingsRepository.get(),
    readSpaceProviderSettings(spaceId ?? DEFAULT_SPACE_ID),
  )
}

/**
 * Get settings synchronously (for hot path after initialization)
 *
 * **C2 起这是「default 空间的生效 settings」**:`settings.ai` 已经不再整份住在
 * `settings.json` 里,而是 default 空间的 `providers.json` 叠上全局目录缓存。
 * 需要别的空间那一份的(引擎按会话解析)走 `getSpaceSettings` /
 * `getSessionSettings`(`app/providers/space-ai-settings.ts`)。
 */
export function getSettings(): AppSettings {
  return getSpaceSettings(DEFAULT_SPACE_ID)
}

// ============================================================================
// Save Operations
// ============================================================================

export interface SaveSettingsOptions {
  /** 把 `settings.ai` 的 per-space 那一半写进哪个空间。缺省 default。 */
  spaceId?: string
}

/**
 * 拆分落盘:`ai` 的 per-space 那一半 → `workspaces/<spaceId>/providers.json`,
 * 其余(含温度缺省与目录缓存)→ `settings.json`。
 *
 * **迁移之前不拆**:标记不在时原样落盘 —— 拆了会把还没搬走的旧字段抹掉,而
 * 装配序列第 2 步正等着读它们。
 */
function prepareSave(
  settings: AppSettings,
  options?: SaveSettingsOptions,
): AppSettings {
  if (!hasSpaceProviderSettingsMigrated(settings)) return settings
  // **调用方给的是哪一半**:`ai.providers` 在 = 生效形状(要拆);不在 = 调用方
  // (渲染层的设置页)自己已经把 per-space 那一半写进 providers.json 了,这里
  // 只落全局。少了这一格判断,一次「只保存全局」的写会把 default 空间的整份
  // provider 设置清成空的。
  if (!settings.ai || (settings.ai as { providers?: unknown }).providers === undefined) {
    return settings
  }
  const { global, space } = splitEffectiveAISettings(settings.ai)
  writeSpaceProviderSettings(options?.spaceId ?? DEFAULT_SPACE_ID, space)
  return { ...settings, ai: global } as unknown as AppSettings
}

/**
 * Save settings asynchronously (recommended)
 * Updates both disk and memory cache
 */
export async function saveSettingsAsync(
  settings: AppSettings,
  options?: SaveSettingsOptions,
): Promise<void> {
  await settingsRepository.saveAsync(prepareSave(settings, options))
  // 「诊断模式」的**唯一续接点**:两条保存路都经过这里,所以设置页那一格
  // 一存就生效,不必等重启(applyDiagnosticsMode 自身幂等)。
  applyDiagnosticsMode(settings.diagnostics?.enabled === true)
}

/**
 * Save settings synchronously (for backward compatibility)
 * Updates both disk and memory cache
 */
export function saveSettings(settings: AppSettings, options?: SaveSettingsOptions): void {
  settingsRepository.save(prepareSave(settings, options))
  applyDiagnosticsMode(settings.diagnostics?.enabled === true)
}

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Invalidate settings cache (for hot reload or external modification)
 * Next getSettings() call will reload from disk
 */
export function invalidateSettingsCache(): void {
  settingsRepository.invalidate()
}

/**
 * Update settings in memory without saving to disk
 * Useful for temporary overrides
 */
export function updateSettingsInMemory(settings: AppSettings): void {
  settingsRepository.updateInMemory(settings)
}

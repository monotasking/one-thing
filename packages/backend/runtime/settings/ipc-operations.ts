import {
  saveOnethingSettingsWithRuntimeEffects,
  type OnethingSettingsWithRuntimeEffects,
  type SaveOnethingSettingsWithRuntimeEffectsOptions,
} from './settings-save.js'

export interface OnethingSettingsIpcLogger {
  error?: (...args: unknown[]) => void
}

export type OnethingSettingsIpcResult<TPayload extends object = {}> =
  | ({ success: true } & TPayload)
  | { success: false; error: string }

export async function getOnethingSettingsForIpc<TSettings>(
  options: {
    getSettings(): TSettings
    logger?: OnethingSettingsIpcLogger
  },
): Promise<OnethingSettingsIpcResult<{ settings: TSettings }>> {
  try {
    return { success: true, settings: options.getSettings() }
  } catch (error) {
    return settingsIpcError(options.logger, 'get settings', error, 'Failed to get settings')
  }
}

export async function saveOnethingSettingsWithRuntimeEffectsForIpc<
  TSettings extends OnethingSettingsWithRuntimeEffects,
  TInputSettings,
>(
  options: SaveOnethingSettingsWithRuntimeEffectsOptions<TSettings, TInputSettings> & {
    logger?: OnethingSettingsIpcLogger
  },
): Promise<OnethingSettingsIpcResult<{ settings: TSettings }>> {
  try {
    return await saveOnethingSettingsWithRuntimeEffects(options)
  } catch (error) {
    return settingsIpcError(options.logger, 'save settings', error, 'Failed to save settings')
  }
}

export function getOnethingSystemThemeForIpc(
  shouldUseDarkColors: boolean,
): OnethingSettingsIpcResult<{ theme: 'dark' | 'light' }> {
  return {
    success: true,
    theme: shouldUseDarkColors ? 'dark' : 'light',
  }
}

function settingsIpcError(
  logger: OnethingSettingsIpcLogger | undefined,
  label: string,
  error: unknown,
  fallback: string,
): { success: false; error: string } {
  logger?.error?.(`[Settings IPC] Failed to ${label}:`, error)
  return {
    success: false,
    error: error instanceof Error && error.message ? error.message : fallback,
  }
}

import { validateOnethingProviderReasoningSettings } from '../providers/model-capability.js'

type MaybePromise<T> = T | Promise<T>

export interface OnethingSettingsWithRuntimeEffects<
> {
  network?: {
    proxy?: unknown
  }
  mcp?: unknown
  acp?: unknown
}

type OnethingSettingsProxy<TSettings> =
  TSettings extends { network?: { proxy?: infer TProxy } } ? TProxy : unknown

type OnethingSettingsMCP<TSettings> =
  TSettings extends { mcp?: infer TMCPSettings } ? NonNullable<TMCPSettings> : unknown

type OnethingSettingsACP<TSettings> =
  TSettings extends { acp?: infer TACPSettings } ? NonNullable<TACPSettings> : unknown

export interface SaveOnethingSettingsWithRuntimeEffectsOptions<
  TSettings extends OnethingSettingsWithRuntimeEffects,
  TInputSettings = TSettings,
> {
  settings: TInputSettings
  saveSettings(settings: TInputSettings): MaybePromise<unknown>
  getSettings(): TSettings
  invalidateProviderCache(): MaybePromise<unknown>
  applyNetworkProxySettings(proxy: OnethingSettingsProxy<TSettings> | undefined): MaybePromise<unknown>
  registerGlobalWindowShortcuts(): MaybePromise<unknown>
  applyVoiceSettings?(settings: TSettings): MaybePromise<unknown>
  updateMCPSettings(settings: OnethingSettingsMCP<TSettings>): MaybePromise<unknown>
  registerMCPTools(): MaybePromise<unknown>
  updateACPSettings(settings: OnethingSettingsACP<TSettings>): MaybePromise<unknown>
  defaultMCPSettings: OnethingSettingsMCP<TSettings>
  defaultACPSettings: OnethingSettingsACP<TSettings>
}

export interface SaveOnethingSettingsWithRuntimeEffectsResult<TSettings> {
  success: true
  settings: TSettings
}

interface OnethingRegistryOwnedProviderFields {
  models?: unknown
  modelsLastFetched?: unknown
}

interface OnethingProviderRegistryCarrier {
  ai?: {
    providers?: Record<string, OnethingRegistryOwnedProviderFields | undefined>
  }
}

/**
 * The model registry (models.dev refresh, provider-direct fetches) writes
 * `providers.*.models` / `modelsLastFetched` directly into the host settings
 * store. Renderer-side saves send a full settings snapshot taken at load
 * time, so an unprotected save would clobber a refresh that happened after
 * the snapshot (e.g. a newly released model silently vanishing again).
 * Registry-owned fields therefore always win from the current settings.
 */
export function preserveOnethingRegistryOwnedProviderFields<TInputSettings>(
  incoming: TInputSettings,
  current: unknown,
): TInputSettings {
  const currentProviders = (current as OnethingProviderRegistryCarrier | undefined)?.ai?.providers
  const incomingCarrier = incoming as OnethingProviderRegistryCarrier
  const incomingProviders = incomingCarrier?.ai?.providers
  if (!currentProviders || !incomingProviders) return incoming

  let mergedProviders: Record<string, OnethingRegistryOwnedProviderFields | undefined> | undefined
  for (const [providerId, currentConfig] of Object.entries(currentProviders)) {
    if (!currentConfig?.models) continue
    const incomingConfig = incomingProviders[providerId]
    if (!incomingConfig) continue
    if (
      incomingConfig.models === currentConfig.models &&
      incomingConfig.modelsLastFetched === currentConfig.modelsLastFetched
    ) {
      continue
    }
    mergedProviders ??= { ...incomingProviders }
    mergedProviders[providerId] = {
      ...incomingConfig,
      models: currentConfig.models,
      modelsLastFetched: currentConfig.modelsLastFetched,
    }
  }

  if (!mergedProviders) return incoming
  return {
    ...incoming,
    ai: { ...incomingCarrier.ai, providers: mergedProviders },
  }
}

export async function saveOnethingSettingsWithRuntimeEffects<
  TSettings extends OnethingSettingsWithRuntimeEffects,
  TInputSettings,
>(
  options: SaveOnethingSettingsWithRuntimeEffectsOptions<
    TSettings,
    TInputSettings
  >,
): Promise<SaveOnethingSettingsWithRuntimeEffectsResult<TSettings>> {
  validateOnethingProviderReasoningSettings((options.settings as { ai?: unknown } | null)?.ai)
  const settingsToSave = preserveOnethingRegistryOwnedProviderFields(
    options.settings,
    options.getSettings(),
  )
  await options.saveSettings(settingsToSave)
  const normalizedSettings = options.getSettings()

  await options.invalidateProviderCache()
  await options.applyNetworkProxySettings(
    normalizedSettings.network?.proxy as OnethingSettingsProxy<TSettings> | undefined,
  )
  await options.registerGlobalWindowShortcuts()
  await options.applyVoiceSettings?.(normalizedSettings)
  await options.updateMCPSettings(
    (normalizedSettings.mcp ?? options.defaultMCPSettings) as OnethingSettingsMCP<TSettings>,
  )
  await options.registerMCPTools()
  await options.updateACPSettings(
    (normalizedSettings.acp ?? options.defaultACPSettings) as OnethingSettingsACP<TSettings>,
  )

  return {
    success: true,
    settings: normalizedSettings,
  }
}

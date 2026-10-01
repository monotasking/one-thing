import { toJsonObject } from '@onething/core'

export const CODEX_NATIVE_IMAGE_GENERATION_TOOL = 'image_generation'

export interface CoreCodexNativeProviderConfig {
  model?: string
  authContext?: {
    kind?: string
  }
  oauthToken?: {
    accessToken?: string
  }
}

export interface CoreCodexNativeToolSettings {
  enableToolCalls?: boolean
}

export interface CoreCodexNativeModelInfo {
  providerMetadata?: unknown
  architecture?: {
    input_modalities?: string[]
  }
}

export function providerConfigUsesCodexOAuth(providerConfig: CoreCodexNativeProviderConfig): boolean {
  return providerConfig.authContext?.kind === 'oauth' ||
    typeof providerConfig.oauthToken?.accessToken === 'string'
}

export function shouldResolveCodexNativeTools(options: {
  providerId: string
  providerConfig: CoreCodexNativeProviderConfig
  toolSettings?: CoreCodexNativeToolSettings
  supportsTools: boolean
}): boolean {
  if (options.providerId !== 'codex') return false
  if (!options.toolSettings?.enableToolCalls) return false
  if (!options.supportsTools) return false
  return providerConfigUsesCodexOAuth(options.providerConfig)
}

export function resolveCodexNativeToolsFromModelInfo(
  modelInfo: CoreCodexNativeModelInfo | undefined,
): string[] {
  const codexMetadata = toJsonObject(toJsonObject(modelInfo?.providerMetadata).codex)
  const nativeToolsValue = codexMetadata.nativeTools
  const nativeTools = Array.isArray(nativeToolsValue)
    ? nativeToolsValue.filter((tool): tool is string => typeof tool === 'string')
    : undefined

  if (nativeTools) {
    return nativeTools.includes(CODEX_NATIVE_IMAGE_GENERATION_TOOL)
      ? [CODEX_NATIVE_IMAGE_GENERATION_TOOL]
      : []
  }

  const inputModalities = modelInfo?.architecture?.input_modalities
  return !modelInfo || inputModalities?.includes('image')
    ? [CODEX_NATIVE_IMAGE_GENERATION_TOOL]
    : []
}

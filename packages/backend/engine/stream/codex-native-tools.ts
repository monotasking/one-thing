import type { OAuthToken, ToolSettings } from '@shared/ipc.js'
import type { ProviderAuthContext } from '@onething/runtime/auth/types.wiring'
import * as modelRegistry from '../../wiring/providers/model-registry.js'
import {
  CODEX_NATIVE_IMAGE_GENERATION_TOOL,
  resolveCodexNativeToolsFromModelInfo,
  shouldResolveCodexNativeTools,
} from '@onething/runtime/providers'

export { CODEX_NATIVE_IMAGE_GENERATION_TOOL }

export type CodexNativeToolProviderConfig = {
  model?: string
  authContext?: ProviderAuthContext
  oauthToken?: OAuthToken
}

export async function getCodexNativeToolsForConfig(options: {
  providerId: string
  providerConfig: CodexNativeToolProviderConfig
  toolSettings?: ToolSettings
  supportsTools: boolean
}): Promise<string[]> {
  if (!shouldResolveCodexNativeTools(options)) return []

  const modelInfo = await modelRegistry.getModelById(options.providerConfig.model || '', options.providerId)
  return resolveCodexNativeToolsFromModelInfo(modelInfo)
}

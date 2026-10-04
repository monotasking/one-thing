import type { OAuthToken, ToolSettings } from '@shared/ipc.js'
import type { ProviderAuthContext } from '@onething/backend/auth/auth-ipc-types'
import { modelRegistry } from '@onething/backend/settings'
import { resolveProviderNativeTools } from '@onething/backend/provider'

/**
 * 这一轮这家要挂的服务商原生工具(例如订阅登录下的原生出图)。判据住在各家行为名册的 `nativeTools` 钩子里,
 * 引擎只把目录条目的取法(设置里的模型目录服务)交过去,不认识任何一家。
 */
export type NativeToolProviderConfig = {
  model?: string
  authContext?: ProviderAuthContext
  oauthToken?: OAuthToken
}

export async function getNativeProviderToolsForConfig(options: {
  providerId: string
  providerConfig: NativeToolProviderConfig
  toolSettings?: ToolSettings
  supportsTools: boolean
}): Promise<string[]> {
  return resolveProviderNativeTools({
    ...options,
    getModelInfo: (modelId, providerId) => modelRegistry.getModelById(modelId, providerId),
  })
}

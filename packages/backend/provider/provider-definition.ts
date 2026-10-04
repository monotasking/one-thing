import type { OnethingOAuthFlowType, OnethingOAuthToken, OnethingProviderAuthContext } from '../auth/auth-types.js'
import type { CoreProviderConfigLike } from './provider-config.js'
import type { OnethingProviderRegistryDefinition, OnethingProviderRegistryInfo } from './provider-registry.js'
import type { ProviderDialDescriptor } from '@shared/provider-dials.js'
import type { ProviderFamilyInfo } from '@shared/provider-families.js'

export type OnethingProviderOAuthFlowType = OnethingOAuthFlowType

export interface OnethingProviderInfo<TModel = unknown> extends OnethingProviderRegistryInfo {
  id: string
  name: string
  description: string
  defaultBaseUrl: string
  defaultModel: string
  icon: string
  supportsCustomBaseUrl: boolean
  requiresApiKey: boolean
  oauthFlow?: OnethingProviderOAuthFlowType
  models?: TModel[]
  /** 计费档位的纯数据投影(manifest `dials` 经 `dialDescriptorOf`)。没有档位的家缺席。 */
  dials?: ProviderDialDescriptor
  /** 这家有配额 / 余额源(manifest 指了 `quotaSource`)。没有就缺席。 */
  hasQuota?: boolean
  /** 家族信息(哪个家族、哪一半、另一半是谁)。不在家族里缺席。 */
  family?: ProviderFamilyInfo
}

export interface OnethingProviderConfig<
  TAuthContext = OnethingProviderAuthContext,
  TOAuthToken = OnethingOAuthToken,
> extends CoreProviderConfigLike {
  apiKey?: string
  enabled?: boolean
  // 各家档位格不在这里点名:键名由 manifest 的 `dials` 声明(见 `CoreProviderConfigLike`)。
  authType?: 'apiKey' | 'oauth'
  oauthToken?: TOAuthToken
  authContext?: TAuthContext
  temperatureByModel?: Record<string, number>
  maxOutputByModel?: Record<string, number>
  contextLengthByModel?: Record<string, number>
  thinkingByModel?: Record<string, boolean>
  thinkingEffortByModel?: Record<string, string>
  serviceTierByModel?: Record<string, string>
  modelCapabilitiesByModel?: Record<string, unknown>
  models?: Record<string, unknown>
  modelsLastFetched?: number
}

export type OnethingProviderCallMode = 'stream' | 'generate'

export interface OnethingProviderToolSchema {
  toJSONSchema?: () => object | null
}

export interface OnethingProviderToolCallOption {
  description?: string
  inputSchema?: OnethingProviderToolSchema | object
  parameters?: object
}

export interface OnethingProviderOptionsMap {
  [providerId: string]: object | string | number | boolean | null | undefined
}

export type OnethingProviderToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'auto' }
  | { type: 'tool'; toolName: string }
  | {
      type: 'function'
      function: { name: string }
    }

export type OnethingProviderCallOptionValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | object
  | object[]
  | Record<string, OnethingProviderToolCallOption>
  | OnethingProviderToolChoice
  | AbortSignal

export interface OnethingProviderCallOptions {
  messages?: object[]
  providerOptions?: OnethingProviderOptionsMap
  tools?: Record<string, OnethingProviderToolCallOption>
  toolChoice?: OnethingProviderToolChoice
  [key: string]: OnethingProviderCallOptionValue
}

export interface OnethingProviderCallPreparationContext {
  providerId: string
  modelId: string
  mode: OnethingProviderCallMode
  isReasoningModel: boolean
}

export interface OnethingProviderDefinition<
  TInfo extends OnethingProviderInfo = OnethingProviderInfo,
  TCallOptions extends OnethingProviderCallOptions = OnethingProviderCallOptions,
> extends OnethingProviderRegistryDefinition<TInfo> {
  prepareCallOptions?: (
    options: TCallOptions,
    context: OnethingProviderCallPreparationContext,
  ) => TCallOptions | void
}

import type { OnethingOAuthFlowType, OnethingOAuthToken, OnethingProviderAuthContext } from '../auth/types.js'
import type { CoreProviderConfigLike } from './provider-config.js'
import type { OnethingProviderRegistryDefinition, OnethingProviderRegistryInfo } from './registry.js'
import type { OnethingKimiApiMode, OnethingKimiRegion } from './kimi.js'
import type { OnethingQwenApiMode, OnethingQwenRegion } from './qwen.js'
import type { OnethingZhipuApiMode } from './vendors/zhipu/endpoint.js'

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
}

export interface OnethingProviderConfig<
  TAuthContext = OnethingProviderAuthContext,
  TOAuthToken = OnethingOAuthToken,
> extends CoreProviderConfigLike {
  apiKey?: string
  enabled?: boolean
  zhipuApiMode?: OnethingZhipuApiMode
  qwenApiMode?: OnethingQwenApiMode
  qwenRegion?: OnethingQwenRegion
  kimiApiMode?: OnethingKimiApiMode
  kimiRegion?: OnethingKimiRegion
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

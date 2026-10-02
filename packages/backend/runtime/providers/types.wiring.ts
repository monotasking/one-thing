import type {
  OAuthToken,
  OpenRouterModel,
  ProviderInfo as IpcProviderInfo,
} from '@shared/ipc.js'
import type { ProviderAuthContext } from '../auth/types.wiring.js'
import type {
  OnethingProviderCallMode,
  OnethingProviderCallOptions,
  OnethingProviderCallPreparationContext,
  OnethingProviderConfig,
  OnethingProviderDefinition,
  OnethingProviderInfo,
  OnethingProviderOptionsMap,
  OnethingProviderToolCallOption,
  OnethingProviderToolChoice,
  OnethingProviderToolSchema,
} from './index.js'

// Re-export from shared for consistency
export type { OpenRouterModel } from '@shared/ipc.js'

export type ProviderInfo = IpcProviderInfo & OnethingProviderInfo<OpenRouterModel>
export type ProviderConfig = OnethingProviderConfig<ProviderAuthContext, OAuthToken>
export type ProviderCallMode = OnethingProviderCallMode
export type ProviderToolSchema = OnethingProviderToolSchema
export type ProviderToolCallOption = OnethingProviderToolCallOption
export type ProviderOptionsMap = OnethingProviderOptionsMap
export type ProviderToolChoice = OnethingProviderToolChoice
export type ProviderCallOptions = OnethingProviderCallOptions
export type ProviderCallPreparationContext = OnethingProviderCallPreparationContext
export type ProviderDefinition = OnethingProviderDefinition<ProviderInfo, ProviderCallOptions>

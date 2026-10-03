import type { OAuthToken } from '@shared/ipc.js'
import type {
  OnethingAuthAccount,
  OnethingAuthBodyFormat,
  OnethingAuthFlowKind,
  OnethingAuthFlowState,
  OnethingAuthProviderDefinition,
  OnethingAuthRequestContext,
  OnethingAuthStateStrategy,
  OnethingProviderAuthContext,
} from './types.js'

export type AuthFlowKind = OnethingAuthFlowKind
export type AuthBodyFormat = OnethingAuthBodyFormat
export type AuthStateStrategy = OnethingAuthStateStrategy
export type AuthAccount = OnethingAuthAccount
export type ProviderAuthContext =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'oauth'; token: OAuthToken; account: AuthAccount }
export type AuthRequestContext = OnethingAuthRequestContext
export type AuthProviderDefinition = OnethingAuthProviderDefinition
export type AuthFlowState = OnethingAuthFlowState

export type RuntimeProviderAuthContext = OnethingProviderAuthContext

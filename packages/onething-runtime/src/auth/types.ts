import type { JsonObject } from '@onething/core'

export type OnethingOAuthFlowType = 'authorization-code' | 'device'
export type OnethingAuthFlowKind = 'pkce-callback' | 'manual-pkce' | 'device-code'
export type OnethingAuthBodyFormat = 'json' | 'form'
export type OnethingAuthStateStrategy = 'random' | 'code-verifier'

export interface OnethingOAuthToken {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  tokenType: string
  scope?: string
  idToken?: string
  accountId?: string
  email?: string
  planType?: string
  isFedrampAccount?: boolean
  providerMetadata?: JsonObject
}

export interface OnethingAuthAccount {
  id?: string
  email?: string
  planType?: string
  isFedramp?: boolean
}

export type OnethingProviderAuthContext =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'oauth'; token: OnethingOAuthToken; account: OnethingAuthAccount }

export interface OnethingAuthRequestContext {
  providerId: string
  flowId: string
  codeVerifier?: string
  codeChallenge?: string
  state?: string
  redirectUri?: string
}

export interface OnethingAuthProviderDefinition {
  providerId: string
  name: string
  flowKind: OnethingAuthFlowKind
  oauthFlow: OnethingOAuthFlowType
  clientId: string
  authorizationUrl?: string
  tokenUrl: string
  refreshUrl?: string
  deviceCodeUrl?: string
  scopes: string[]
  callbackPath?: string
  callbackPorts?: number[]
  redirectUri?: string
  stateStrategy?: OnethingAuthStateStrategy
  tokenBodyFormat?: OnethingAuthBodyFormat
  refreshBodyFormat?: OnethingAuthBodyFormat
  tokenHeaders?: Record<string, string>
  refreshHeaders?: Record<string, string>
  authorizationParams?: (ctx: OnethingAuthRequestContext) => Record<string, string>
  tokenParams?: (ctx: OnethingAuthRequestContext & { code: string }) => Record<string, string>
  refreshParams?: (refreshToken: string) => Record<string, string>
  normalizeToken?: (data: any, currentToken?: OnethingOAuthToken | null) => OnethingOAuthToken
  codeEntryInstructions?: string
  statusMessage?: string
}

export interface OnethingAuthFlowState {
  flowId: string
  providerId: string
  /**
   * 这一次登录的 token 该落到哪儿(批 B6)。缺席 = settings(默认空间)。
   * 类型故意写成结构体而不是 import —— types.ts 是叶子模块,不反向依赖
   * credential-target.ts(那边要 import spaces/types)。
   */
  target?: { kind: 'settings' } | { kind: 'space'; spaceId: string; entryId?: string; label?: string }
  kind: OnethingAuthFlowKind
  state: string
  codeVerifier?: string
  codeChallenge?: string
  redirectUri?: string
  deviceCode?: string
  userCode?: string
  verificationUri?: string
  intervalMs?: number
  expiresAt: number
  lastError?: string
}

export interface OnethingOAuthStartResponse {
  success: boolean
  flowId?: string
  flowKind?: OnethingAuthFlowKind
  pollIntervalMs?: number
  expiresAt?: number
  statusMessage?: string
  authUrl?: string
  state?: string
  userCode?: string
  verificationUri?: string
  expiresIn?: number
  interval?: number
  requiresCodeEntry?: boolean
  instructions?: string
  error?: string
}

export interface OnethingOAuthCallbackResponse {
  success: boolean
  error?: string
}

export interface OnethingOAuthStatusResponse {
  success: boolean
  providerId?: string
  isLoggedIn: boolean
  isExpired?: boolean
  canRefresh?: boolean
  expiresAt?: number
  account?: OnethingAuthAccount
  lastError?: string
  error?: string
}

export interface OnethingOAuthDevicePollResponse {
  success: boolean
  completed: boolean
  error?: string
  pollStatus?: string
}

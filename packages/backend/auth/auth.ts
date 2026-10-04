export {
  getAuthProviderDefinition,
  getAuthProviderDefinitions,
  generatePKCE,
  normalizeGenericOAuthToken,
} from './auth-registry.js'
export {
  parseJwtExpiration,
  parseJwtPayload,
} from '@onething/backend/network'
export {
  OnethingAuthService,
} from './auth-service.js'
export {
  createOnethingAuthService,
  createOnethingAuthServiceOptions,
} from './auth-service-factory.js'
export {
  CallbackServerManager,
  callbackServerManager,
} from './auth-callback-server.js'
export * from './auth-ipc-operations.js'
export type {
  OnethingAuthCallbackRegistration,
  OnethingAuthCallbackServerAdapter,
  OnethingAuthServiceOptions,
  OnethingAuthTokenEvent,
  OnethingAuthTokenStore,
} from './auth-service.js'
export {
  credentialRefreshKey,
  credentialTargetFromSpaceMarker,
  credentialTargetKey,
  DEFAULT_CREDENTIAL_TARGET,
  isSpaceCredentialTarget,
  normalizeCredentialTarget,
} from './auth-credential-target.js'
export type {
  OnethingCredentialTarget,
  OnethingSpaceCredentialTarget,
} from './auth-credential-target.js'
export type {
  OnethingAuthRuntimeOptions,
} from './auth-service-factory.js'
export {
  getDefaultOnethingTokenFilePath,
  OnethingTokenStore,
} from './auth-token-store.js'
export type {
  OnethingTokenCryptoAdapter,
  OnethingTokenStoreOptions,
} from './auth-token-store.js'
export type {
  OnethingAuthBodyFormat,
  OnethingAuthAccount,
  OnethingAuthFlowEvent,
  OnethingAuthFlowPhase,
  OnethingAuthFlowState,
  OnethingAuthFlowKind,
  OnethingAuthProviderDefinition,
  OnethingAuthRequestContext,
  OnethingAuthStateStrategy,
  OnethingOAuthCallbackResponse,
  OnethingOAuthDevicePollResponse,
  OnethingOAuthAccountStatus,
  OnethingOAuthFlowType,
  OnethingOAuthStartResponse,
  OnethingOAuthStatusResponse,
  OnethingOAuthToken,
  OnethingProviderAuthContext,
} from './auth-types.js'

// ── providers 归位(D24,2026-10-04)从 `providers/auth/` 搬来的旧兼容门面:新代码直接用进程那台登录服务
// (`auth-process-service.ts` 的 `getAuthService`)。
export {
  oauthManager,
} from './auth-oauth-manager.js'

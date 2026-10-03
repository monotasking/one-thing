export {
  getAuthProviderDefinition,
  getAuthProviderDefinitions,
  generatePKCE,
  normalizeGenericOAuthToken,
} from './registry.js'
export {
  parseJwtExpiration,
  parseJwtPayload,
} from '@onething/backend/runtime/network'
export {
  OnethingAuthService,
} from './auth-service.js'
export {
  createOnethingAuthService,
  createOnethingAuthServiceOptions,
} from './service-factory.js'
export {
  CallbackServerManager,
  callbackServerManager,
} from './callback-server.js'
export * from './ipc-operations.js'
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
} from './credential-target.js'
export type {
  OnethingCredentialTarget,
  OnethingSpaceCredentialTarget,
} from './credential-target.js'
export type {
  OnethingAuthRuntimeOptions,
} from './service-factory.js'
export {
  getDefaultOnethingTokenFilePath,
  OnethingTokenStore,
} from './token-store.js'
export type {
  OnethingTokenCryptoAdapter,
  OnethingTokenStoreOptions,
} from './token-store.js'
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
} from './types.js'

// ── providers 归位(D24,2026-10-04)从 `providers/auth/` 搬来的旧兼容门面:新代码直接用进程那台登录服务
// (`process-auth-service.ts` 的 `getAuthService`)。
export {
  oauthManager,
} from './auth-oauth-manager.js'

/**
 * auth —— 登录:各服务商的 OAuth / 设备码登录流程、本机回调服务器、令牌的加密落盘,
 * 以及进程里那一台登录服务。
 *
 * 对外交出五类东西:
 * - 进程那台登录服务:取用口、装上令牌仓库,服务类本身与旧的兼容门面 `oauthManager`;
 * - 宿主注入口与登录事件的广播(装上、读、经事件总线推出去);
 * - 服务商登录定义的登记表、PKCE、令牌规范化,以及登录相关的形状;
 * - 凭证目标(这枚令牌属于哪个空间的哪个凭证)的判据与形状;
 * - 令牌仓库类与它的加密口、本机回调服务器、调试日志口。
 * 依赖 network、settings、space、storage、provider、agent-loop、event、logging。
 */

// 进程那台登录服务。
export { configureProcessAuthTokenStore, getAuthService } from './auth-process-service.js'
export { OnethingAuthService } from './auth-service.js'
export { oauthManager } from './auth-oauth-manager.js'

// 宿主注入口与登录事件。
export { configureAuthHost, getAuthHostPorts, resetAuthHost } from './auth-host-ports.js'
export type { AuthHostPorts } from './auth-host-ports.js'
export {
  configureOAuthEventBroadcaster,
  getOAuthEventBroadcaster,
  installOAuthBusBroadcaster,
} from './auth-oauth-events.js'
export type { OAuthTokenEvent } from './auth-oauth-events.js'

// 服务商登录定义与登录形状。
export { generatePKCE, getAuthProviderDefinition, normalizeGenericOAuthToken } from './auth-registry.js'
export type {
  OnethingAuthAccount,
  OnethingAuthProviderDefinition,
  OnethingOAuthFlowType,
  OnethingOAuthToken,
  OnethingProviderAuthContext,
} from './auth-types.js'
export type { ProviderAuthContext } from './auth-ipc-types.js'

// 凭证目标。
export { credentialTargetFromSpaceMarker } from './auth-credential-target.js'
export type { OnethingCredentialTarget, OnethingSpaceCredentialTarget } from './auth-credential-target.js'

// 令牌仓库、回调服务器、调试日志口。
export { OnethingTokenStore } from './auth-token-store.js'
export type { OnethingTokenCryptoAdapter } from './auth-token-store.js'
export { callbackServerManager } from './auth-callback-server.js'
export type { OnethingOAuthIpcLogger } from './auth-ipc-operations.js'

import {
  OnethingAuthService,
  type OnethingAuthServiceOptions,
} from './auth-service.js'
import { callbackServerManager } from './auth-callback-server.js'
import { getAuthProviderDefinition } from './auth-registry.js'
import type { OnethingOAuthToken } from './auth-types.js'

/**
 * 令牌存放面 `tokenStore` 必须由调用方给(D24 断边 ③,2026-10-04)。从前缺省时这里自己装上凭证池那一台
 * (`credentials` 的 `createOnethingSpaceTokenStore`),于是 auth 认识凭证池的形状,凭证那一侧又要 auth 刷新令牌,
 * 两个功能互相引用成环。现在由装配(`backend.ts`)建好那一台,经 `configureProcessAuthTokenStore` 交给进程那台登录服务。
 */
export type OnethingAuthRuntimeOptions<TToken extends OnethingOAuthToken = OnethingOAuthToken> =
  Partial<OnethingAuthServiceOptions<TToken>> & Pick<OnethingAuthServiceOptions<TToken>, 'tokenStore'>

export function createOnethingAuthServiceOptions<TToken extends OnethingOAuthToken = OnethingOAuthToken>(
  options: OnethingAuthRuntimeOptions<TToken>,
): OnethingAuthServiceOptions<TToken> {
  return {
    fetch: options.fetch,
    getDefinition: options.getDefinition ?? getAuthProviderDefinition,
    callbackServer: options.callbackServer ?? callbackServerManager,
    createId: options.createId,
    now: options.now,
    logger: options.logger,
    // 令牌的唯一存放面(批 B6 立,批 8 起默认空间也是):`workspaces/<id>/credentials.json`
    // 的凭证池。由调用方给(见上面 `OnethingAuthRuntimeOptions` 的说明);加密走池自己的 safeStorage 端口。
    tokenStore: options.tokenStore,
  }
}

export function createOnethingAuthService<TToken extends OnethingOAuthToken = OnethingOAuthToken>(
  options: OnethingAuthRuntimeOptions<TToken>,
): OnethingAuthService<TToken> {
  return new OnethingAuthService(createOnethingAuthServiceOptions(options))
}

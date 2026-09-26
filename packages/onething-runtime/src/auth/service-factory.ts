import {
  OnethingAuthService,
  type OnethingAuthServiceOptions,
} from './auth-service.js'
import { callbackServerManager } from './callback-server.js'
import { getAuthProviderDefinition } from './registry.js'
import { createOnethingSpaceTokenStore } from './space-token-store.js'
import type { OnethingOAuthToken } from './types.js'

export type OnethingAuthRuntimeOptions<TToken extends OnethingOAuthToken = OnethingOAuthToken> =
  Partial<OnethingAuthServiceOptions<TToken>>

export function createOnethingAuthServiceOptions<TToken extends OnethingOAuthToken = OnethingOAuthToken>(
  options: OnethingAuthRuntimeOptions<TToken> = {},
): OnethingAuthServiceOptions<TToken> {
  return {
    fetch: options.fetch,
    getDefinition: options.getDefinition ?? getAuthProviderDefinition,
    callbackServer: options.callbackServer ?? callbackServerManager,
    createId: options.createId,
    now: options.now,
    logger: options.logger,
    // 令牌的唯一存放面(批 B6 立,批 8 起默认空间也是):`workspaces/<id>/credentials.json`
    // 的凭证池。与 store 根同源、不需要宿主注入任何东西 —— 加密走池自己的 safeStorage 端口。
    tokenStore: options.tokenStore ?? createOnethingSpaceTokenStore<TToken>(),
  }
}

export function createOnethingAuthService<TToken extends OnethingOAuthToken = OnethingOAuthToken>(
  options: OnethingAuthRuntimeOptions<TToken> = {},
): OnethingAuthService<TToken> {
  return new OnethingAuthService(createOnethingAuthServiceOptions(options))
}

import {
  OnethingAuthService,
  type OnethingAuthServiceOptions,
  type OnethingAuthTokenStore,
} from './auth-service.js'
import { callbackServerManager } from './callback-server.js'
import { getAuthProviderDefinition } from './registry.js'
import { createOnethingSpaceTokenStore } from './space-token-store.js'
import type { OnethingOAuthToken } from './types.js'

export interface OnethingAuthRuntimeOptions<TToken extends OnethingOAuthToken = OnethingOAuthToken>
  extends Partial<OnethingAuthServiceOptions<TToken>> {
  tokenStore: OnethingAuthTokenStore<TToken>
}

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
    tokenStore: options.tokenStore,
    // per-space token 面(批 B6)。默认装上 —— 它读写的是
    // `workspaces/<id>/credentials.json`,与 store 根同源、不需要宿主注入任何东西;
    // 没有非默认空间时它一次都不会被问到。
    spaceTokenStore: options.spaceTokenStore ?? createOnethingSpaceTokenStore<TToken>(),
  }
}

export function createOnethingAuthService<TToken extends OnethingOAuthToken = OnethingOAuthToken>(
  options: OnethingAuthRuntimeOptions<TToken>,
): OnethingAuthService<TToken> {
  return new OnethingAuthService(createOnethingAuthServiceOptions(options))
}

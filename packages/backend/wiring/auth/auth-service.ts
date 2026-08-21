import {
  createOnethingAuthServiceOptions,
  OnethingAuthService,
  type OnethingAuthCallbackServerAdapter,
  type OnethingAuthServiceOptions,
  type OnethingAuthTokenStore,
} from '@onething/runtime/auth'
import type { OAuthToken } from '@shared/ipc.js'
import { createRequiredAppFetch } from '../../provider-binding/bound-fetch.js'
import { getAuthHostPorts } from '@onething/runtime/auth/host-ports'
import { tokenStore } from '@onething/runtime/auth/token-store.wiring'

export interface MainAuthServiceOptions extends Partial<OnethingAuthServiceOptions<OAuthToken>> {
  tokenStore?: OnethingAuthTokenStore<OAuthToken>
  callbackServer?: OnethingAuthCallbackServerAdapter
}

const fallbackAuthFetch = createRequiredAppFetch({ policy: 'auth' })

const mainAuthFetch: typeof fetch = (input, init) =>
  (getAuthHostPorts().authFetch ?? fallbackAuthFetch)(input, init)

export class AuthService extends OnethingAuthService<OAuthToken> {
  constructor(options: MainAuthServiceOptions = {}) {
    super(createOnethingAuthServiceOptions({
      fetch: mainAuthFetch,
      ...options,
      tokenStore: options.tokenStore ?? tokenStore,
    }))
  }
}

export const authService = new AuthService()

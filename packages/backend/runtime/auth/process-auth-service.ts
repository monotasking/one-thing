/**
 * 装配层那一台 `OnethingAuthService`(进程单例)。令牌只有一个家:空间凭证池
 * (`createOnethingAuthServiceOptions` 缺省装上的 `createOnethingSpaceTokenStore`)。
 * 批 8 之前这里还注入一把「一家一个位置」的单槽给默认空间用 —— 退役了,旧文件只由
 * 装配序列里的一次性归位读(`../../wiring/providers/space-config-migration.ts`);
 * `scripts/headless-boundary-check.ts` 的 `checkRuntimeOwnsAuthTokenStorage` 钉着它别回来。
 */
import {
  createOnethingAuthServiceOptions,
  OnethingAuthService,
  type OnethingAuthCallbackServerAdapter,
  type OnethingAuthServiceOptions,
} from '@onething/backend/runtime/auth'
import type { OAuthToken } from '@shared/ipc.js'
import { createRequiredAppFetch } from '@onething/backend/provider-binding/bound-fetch.js'
import { getAuthHostPorts } from '@onething/backend/runtime/auth/host-ports'

export interface MainAuthServiceOptions extends Partial<OnethingAuthServiceOptions<OAuthToken>> {
  callbackServer?: OnethingAuthCallbackServerAdapter
}

const fallbackAuthFetch = createRequiredAppFetch({ policy: 'auth' })

const mainAuthFetch: typeof fetch = (input, init) =>
  (getAuthHostPorts().authFetch ?? fallbackAuthFetch)(input, init)

export class AuthService extends OnethingAuthService<OAuthToken> {
  constructor(options: MainAuthServiceOptions = {}) {
    super(createOnethingAuthServiceOptions<OAuthToken>({
      fetch: mainAuthFetch,
      ...options,
    }))
  }
}

export const authService = new AuthService()

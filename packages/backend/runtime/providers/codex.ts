import {
  CODEX_PROVIDER_ID,
  createCodexAgentProvider as createCoreCodexAgentProvider,
  type CodexAgentProviderOptions as CoreCodexAgentProviderOptions,
  type OAuthToken as CodexOAuthToken,
  type ProviderAuthContext as CodexProviderAuthContext,
} from './vendors/codex/agent-provider.js'
import type { OAuthToken } from '@shared/ipc.js'
import { authService } from '@onething/backend/runtime/auth/process-auth-service'
import type { ProviderAuthContext } from '@onething/backend/runtime/auth/ipc-types'
import { createRequiredAppFetch } from '@onething/backend/runtime/settings'
import { dumpProviderRequest } from './index.js'
import type { AgentProvider } from '@onething/backend/runtime/agent-loop/loop-primitives'

export interface CodexAgentProviderOptions extends Omit<
  CoreCodexAgentProviderOptions,
  'oauthToken' | 'authContext' | 'refreshOAuthToken'
> {
  oauthToken?: OAuthToken
  authContext?: ProviderAuthContext
  refreshOAuthToken?: (forceRefresh: boolean) => Promise<OAuthToken | undefined>
}

function hasOAuthCredentials(options: CodexAgentProviderOptions): boolean {
  return options.authContext?.kind === 'oauth' || Boolean(options.oauthToken)
}

function refreshOAuthToken(options: CodexAgentProviderOptions): (forceRefresh: boolean) => Promise<CodexOAuthToken | undefined> {
  return async forceRefresh => {
    if (options.refreshOAuthToken) {
      return options.refreshOAuthToken(forceRefresh) as Promise<CodexOAuthToken | undefined>
    }
    return forceRefresh
      ? authService.refreshToken(CODEX_PROVIDER_ID) as Promise<CodexOAuthToken | undefined>
      : authService.refreshTokenIfNeeded(CODEX_PROVIDER_ID) as Promise<CodexOAuthToken | undefined>
  }
}

export function createCodexAgentProvider(options: CodexAgentProviderOptions): AgentProvider {
  return createCoreCodexAgentProvider({
    ...options,
    oauthToken: options.oauthToken as CodexOAuthToken | undefined,
    authContext: options.authContext as CodexProviderAuthContext | undefined,
    fetchImpl: options.fetchImpl ?? createRequiredAppFetch({ policy: 'streaming' }),
    requestDumper: options.requestDumper ?? dumpProviderRequest,
    refreshOAuthToken: hasOAuthCredentials(options) ? refreshOAuthToken(options) : undefined,
  })
}

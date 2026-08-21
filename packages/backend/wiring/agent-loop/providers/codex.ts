import {
  createCodexAgentProvider as createCoreCodexAgentProvider,
  type CodexAgentProviderOptions as CoreCodexAgentProviderOptions,
  type CodexOAuthToken,
  type CodexProviderAuthContext,
} from '@onething/runtime/agent-loop/providers'
import type { OAuthToken } from '@shared/ipc.js'
import { authService } from '../../auth/auth-service.js'
import type { ProviderAuthContext } from '@onething/runtime/auth/types.wiring'
import { createRequiredAppFetch } from '../../../providers/bound-fetch.js'
import { CODEX_PROVIDER_ID } from '../../../providers/builtin/codex.js'
import { dumpProviderRequest } from '../../../providers/request-dump.js'
import type { AgentProvider } from '@onething/core/agent-loop'

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

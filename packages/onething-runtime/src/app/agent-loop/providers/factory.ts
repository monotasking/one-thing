import {
  createAgentProviderFromRuntime as createCoreAgentProviderFromRuntime,
  getSupportedAgentProviderRuntimeIds,
  isAgentProviderRuntimeSupported,
  registerAgentProviderRuntime as registerCoreAgentProviderRuntime,
  type AgentProviderRuntimeConfig as CoreAgentProviderRuntimeConfig,
  type CreateAgentProviderFromRuntimeOptions,
  type RegisterAgentProviderRuntimeOptions,
} from '@onething/runtime/agent-loop/providers'
import type { OAuthToken } from '@shared/ipc.js'
import { credentialTargetFromSpaceMarker } from '@onething/runtime/auth'
import { ACPManager } from '../../acp/index.js'
import {
  getExternalAgentConnectors,
  persistExternalAgentSessionLink,
  resolveExternalAgentSessionLink,
} from '../../external-agents/index.js'
import { authService } from '../../auth/auth-service.js'
import type { ProviderAuthContext } from '../../auth/types.js'
import { createRequiredAppFetch } from '../../providers/bound-fetch.js'
import { dumpProviderRequest } from '../../providers/request-dump.js'
import type { AgentProvider } from '@onething/core/agent-loop'

export {
  getSupportedAgentProviderRuntimeIds,
  isAgentProviderRuntimeSupported,
}
export type {
  CreateAgentProviderFromRuntimeOptions,
  RegisterAgentProviderRuntimeOptions,
}

export interface AgentProviderRuntimeConfig extends Omit<CoreAgentProviderRuntimeConfig, 'oauthToken' | 'authContext'> {
  oauthToken?: OAuthToken
  authContext?: ProviderAuthContext
}

export type AgentProviderRuntimeFactory = (
  config: AgentProviderRuntimeConfig,
  options: CreateAgentProviderFromRuntimeOptions,
) => AgentProvider | undefined

export function registerAgentProviderRuntime(
  providerId: string,
  factory: AgentProviderRuntimeFactory,
  options: RegisterAgentProviderRuntimeOptions = {},
): () => void {
  return registerCoreAgentProviderRuntime(
    providerId,
    (config, runtimeOptions) => factory(config as AgentProviderRuntimeConfig, runtimeOptions),
    options,
  )
}

function hasOAuthCredentials(config: AgentProviderRuntimeConfig): boolean {
  return config.authContext?.kind === 'oauth' || Boolean(config.oauthToken)
}

/**
 * authService is already keyed by provider id, so nothing here is codex-specific
 * — it used to be only because the option was. Providers that never ask for a
 * refresh simply never call it.
 *
 * per-space(批 B6):写回目标从 config 上的运行期标记来。**这一步不能省** ——
 * 回合中途的刷新发生在 provider 闭包里,那里既没有 sessionId 也没有 space;
 * 不带目标就会把某个空间刷新出来的 token 写进 `oauth-tokens.json`,
 * 既污染了默认空间,又让本空间那条 entry 永远停在旧 token 上。
 */
function createRefreshOAuthToken(
  config: AgentProviderRuntimeConfig,
): CreateAgentProviderFromRuntimeOptions['refreshOAuthToken'] | undefined {
  if (!hasOAuthCredentials(config)) return undefined

  const target = credentialTargetFromSpaceMarker(config.spaceCredential)
  return (providerId, forceRefresh) => forceRefresh
    ? authService.refreshToken(providerId, target) as Promise<OAuthToken | undefined>
    : authService.refreshTokenIfNeeded(providerId, target) as Promise<OAuthToken | undefined>
}

export function createAgentProviderFromRuntime(
  providerId: string,
  config: AgentProviderRuntimeConfig,
  options: CreateAgentProviderFromRuntimeOptions = {},
): AgentProvider | undefined {
  return createCoreAgentProviderFromRuntime(providerId, config as CoreAgentProviderRuntimeConfig, {
    ...options,
    fetchImpl: options.fetchImpl ?? createRequiredAppFetch({ policy: 'streaming' }),
    acpStreamPrompt: options.acpStreamPrompt ?? ((model, promptOptions) => ACPManager.streamPrompt(model, promptOptions)),
    acpCwd: options.acpCwd ?? (() => process.cwd()),
    externalAgentConnectors: options.externalAgentConnectors ?? getExternalAgentConnectors(),
    resolveExternalAgentSessionLink:
      options.resolveExternalAgentSessionLink ?? resolveExternalAgentSessionLink,
    onExternalAgentSessionLink:
      options.onExternalAgentSessionLink ?? persistExternalAgentSessionLink,
    refreshOAuthToken: options.refreshOAuthToken ?? createRefreshOAuthToken(config),
    requestDumper: options.requestDumper ?? dumpProviderRequest,
  })
}

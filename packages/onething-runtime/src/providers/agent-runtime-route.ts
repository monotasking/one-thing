import type {
  AgentJsonObject,
  AgentJsonValue,
  AgentProvider,
} from '@onething/core/agent-loop'
import type {
  AgentProviderRuntimeConfig,
} from '../agent-loop/providers/factory.js'

export const ONETHING_ACP_RUNTIME_PROVIDER_ID = 'acp'
export const ONETHING_DEEPSEEK_RUNTIME_PROVIDER_ID = 'deepseek'

export type OnethingAgentRuntimeProviderConfig = AgentProviderRuntimeConfig & {
  model: string
}

export type OnethingProviderRuntimeRoute =
  | { kind: 'acp' }
  | { kind: 'agent'; provider: AgentProvider }
  | { kind: 'unsupported' }

export interface OnethingProviderExecutableToolDefinition {
  description: string
  parameters?: object
  parameterSchema?: AgentJsonObject
  execute?: (args: AgentJsonObject) => Promise<AgentJsonValue>
}

export interface OnethingProviderRuntimeRouteAdapters {
  createAgentProvider(
    providerId: string,
    config: AgentProviderRuntimeConfig,
  ): AgentProvider | undefined
}

export function isOnethingACPProviderRuntime(providerId: string): boolean {
  return providerId === ONETHING_ACP_RUNTIME_PROVIDER_ID
}


export function createOnethingUtilityAgentProvider(
  providerId: string,
  config: OnethingAgentRuntimeProviderConfig,
  adapters: OnethingProviderRuntimeRouteAdapters,
): AgentProvider | undefined {
  // deepseek used to be excluded here and served by a route of its own. The
  // only thing that route did differently was infer thinking from the model
  // name; deepseek.ts owns that now, so the generic path builds the same
  // request — and the two paths can no longer drift apart the way they did
  // when one of them quietly stopped reporting usage.
  if (isOnethingACPProviderRuntime(providerId)) {
    return undefined
  }
  return adapters.createAgentProvider(providerId, {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    providerOptions: config.providerOptions,
    model: config.model,
    apiType: config.apiType,
    oauthToken: config.oauthToken,
    authContext: config.authContext,
    modelCapabilitiesByModel: config.modelCapabilitiesByModel,
    models: config.models,
    headers: config.headers,
    modelsUrl: config.modelsUrl,
    dialect: config.dialect,
  })
}


export function resolveOnethingProviderRuntimeRoute(
  providerId: string,
  config: OnethingAgentRuntimeProviderConfig,
  adapters: OnethingProviderRuntimeRouteAdapters,
): OnethingProviderRuntimeRoute {
  if (isOnethingACPProviderRuntime(providerId)) return { kind: 'acp' }
  const provider = createOnethingUtilityAgentProvider(providerId, config, adapters)
  return provider ? { kind: 'agent', provider } : { kind: 'unsupported' }
}

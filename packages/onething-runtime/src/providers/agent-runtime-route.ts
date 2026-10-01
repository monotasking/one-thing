import type {
  AgentJsonObject,
  AgentJsonValue,
  AgentProvider,
} from '@onething/core/agent-loop'
import type {
  AgentProviderRuntimeConfig,
} from '../agent-loop/providers/factory.js'

export const ONETHING_ACP_RUNTIME_PROVIDER_ID = 'acp'

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
  // 从前有一家服务商在这里被排除、走它自己的一条路;那条路唯一的不同是按型号名推断
  // 是否思考,如今那份推断归那家自己的思考线型,通用路径造出的请求逐字相同 —— 两条路
  // 不会再像当年那样悄悄分岔(其中一条曾经不报 usage)。
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

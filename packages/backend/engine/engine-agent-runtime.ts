import type { AgentProviderRuntimeConfig } from './engine-provider-factory.js'
import { createAgentProviderFromRuntime } from './engine-provider-factory.js'
import type {
  AgentProvider,
} from '@onething/backend/agent-loop/agent-loop-primitives'
import {
  createOnethingUtilityAgentProvider,
  isOnethingACPProviderRuntime,
  ONETHING_ACP_RUNTIME_PROVIDER_ID,
  resolveOnethingProviderRuntimeRoute,
  type OnethingProviderExecutableToolDefinition,
  type OnethingProviderRuntimeRoute,
  type OnethingProviderRuntimeRouteAdapters,
  type OnethingProviderToolDefinitionInput,
  type OnethingProviderToolDefinitionMap,
  type OnethingProviderToolParameter,
  type OnethingProviderToolSourceDefinition,
} from '@onething/backend/provider'

export const ACP_PROVIDER_ID = ONETHING_ACP_RUNTIME_PROVIDER_ID

export { createAgentProviderFromRuntime }

export type AgentRuntimeProviderConfig = AgentProviderRuntimeConfig & {
  model: string
}

export type ProviderRuntimeRoute = OnethingProviderRuntimeRoute
export type ProviderToolParameter = OnethingProviderToolParameter
export type ProviderToolDefinitionInput = OnethingProviderToolDefinitionInput
export type ProviderToolSourceDefinition = OnethingProviderToolSourceDefinition
export type ProviderToolDefinitionMap = OnethingProviderToolDefinitionMap
export type ProviderExecutableToolDefinition = OnethingProviderExecutableToolDefinition

export function isACPProviderRuntime(providerId: string): boolean {
  return isOnethingACPProviderRuntime(providerId)
}


export function createUtilityAgentProvider(
  providerId: string,
  config: AgentRuntimeProviderConfig,
): AgentProvider | undefined {
  const providerRuntimeRouteAdapters: OnethingProviderRuntimeRouteAdapters = {
    createAgentProvider: createAgentProviderFromRuntime,
  };
  return createOnethingUtilityAgentProvider(providerId, config, providerRuntimeRouteAdapters) as AgentProvider | undefined
}


export function resolveProviderRuntimeRoute(
  providerId: string,
  config: AgentRuntimeProviderConfig,
): ProviderRuntimeRoute {
  const providerRuntimeRouteAdapters2: OnethingProviderRuntimeRouteAdapters = {
    createAgentProvider: createAgentProviderFromRuntime,
  };
  return resolveOnethingProviderRuntimeRoute(providerId, config, providerRuntimeRouteAdapters2) as ProviderRuntimeRoute
}

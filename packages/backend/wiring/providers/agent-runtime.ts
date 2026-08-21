import type { AgentProviderRuntimeConfig } from '../agent-loop/providers/factory.js'
import { createAgentProviderFromRuntime } from '../agent-loop/providers/factory.js'
import type {
  AgentProvider,
} from '@onething/core/agent-loop'
import {
  ONETHING_ACP_RUNTIME_PROVIDER_ID,
  createOnethingUtilityAgentProvider,
  isOnethingACPProviderRuntime,
  resolveOnethingProviderRuntimeRoute,
  type OnethingProviderExecutableToolDefinition,
  type OnethingProviderRuntimeRoute,
  type OnethingProviderToolDefinitionInput,
  type OnethingProviderToolDefinitionMap,
  type OnethingProviderToolParameter,
  type OnethingProviderToolSourceDefinition,
} from '@onething/runtime/providers'

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
  return createOnethingUtilityAgentProvider(providerId, config, {
    createAgentProvider: createAgentProviderFromRuntime,
  }) as AgentProvider | undefined
}


export function resolveProviderRuntimeRoute(
  providerId: string,
  config: AgentRuntimeProviderConfig,
): ProviderRuntimeRoute {
  return resolveOnethingProviderRuntimeRoute(providerId, config, {
    createAgentProvider: createAgentProviderFromRuntime,
  }) as ProviderRuntimeRoute
}

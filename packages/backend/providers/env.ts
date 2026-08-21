import type {
  ProviderConfig,
  ProviderEnvStatus,
  ProviderEnvVarCandidate,
} from '@shared/ipc.js'
import {
  getOnethingProviderApiKeyEnvCandidates,
  getOnethingProviderEnvStatus,
  resolveOnethingProviderApiKey,
  withResolvedOnethingProviderApiKey,
} from '@onething/runtime/providers'

type ApiKeyConfig = Pick<ProviderConfig, 'apiKey'>

export function getProviderApiKeyEnvCandidates(providerId: string): string[] {
  return getOnethingProviderApiKeyEnvCandidates(providerId)
}

export function resolveProviderApiKey(
  providerId: string,
  config: ApiKeyConfig | undefined,
): string | null {
  return resolveOnethingProviderApiKey(providerId, config)
}

export function withResolvedProviderApiKey<T extends ApiKeyConfig>(
  providerId: string,
  config: T,
): T {
  return withResolvedOnethingProviderApiKey(providerId, config)
}

export function getProviderEnvStatus(providerId: string): ProviderEnvStatus {
  return getOnethingProviderEnvStatus(providerId) as ProviderEnvStatus
}

export type {
  ProviderEnvStatus,
  ProviderEnvVarCandidate,
}

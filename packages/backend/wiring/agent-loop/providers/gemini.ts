import {
  createGeminiAgentProvider as createCoreGeminiAgentProvider,
  type GeminiAgentProviderOptions,
} from '@onething/runtime/agent-loop/providers'
import { createRequiredAppFetch } from '../../../provider-binding/bound-fetch.js'
import type { AgentProvider } from '@onething/core/agent-loop'

export type { GeminiAgentProviderOptions } from '@onething/runtime/agent-loop/providers'

export function createGeminiAgentProvider(options: GeminiAgentProviderOptions): AgentProvider {
  return createCoreGeminiAgentProvider({
    ...options,
    fetchImpl: options.fetchImpl ?? createRequiredAppFetch({ policy: 'streaming' }),
  })
}

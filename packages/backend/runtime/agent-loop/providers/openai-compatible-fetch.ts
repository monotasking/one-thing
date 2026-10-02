import {
  createOpenAICompatibleAgentProvider as createCoreOpenAICompatibleAgentProvider,
  type OpenAICompatibleAgentProviderOptions,
} from '@onething/backend/runtime/agent-loop/providers'
import { createRequiredAppFetch } from '@onething/backend/provider-binding/bound-fetch.js'
import type { AgentProvider } from '@onething/backend/core/agent-loop'

export type { OpenAICompatibleAgentProviderOptions } from '@onething/backend/runtime/agent-loop/providers'

export function createOpenAICompatibleAgentProvider(options: OpenAICompatibleAgentProviderOptions): AgentProvider {
  return createCoreOpenAICompatibleAgentProvider({
    ...options,
    fetchImpl: options.fetchImpl ?? createRequiredAppFetch({ policy: 'streaming' }),
  })
}

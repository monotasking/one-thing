import { createOpenAICompatibleAgentProvider as createCoreOpenAICompatibleAgentProvider, type OpenAICompatibleAgentProviderOptions } from '@onething/backend/provider'
import { createRequiredAppFetch } from '@onething/backend/settings'
import type { AgentProvider } from '@onething/backend/agent-loop'

export type { OpenAICompatibleAgentProviderOptions } from '@onething/backend/provider'

export function createOpenAICompatibleAgentProvider(options: OpenAICompatibleAgentProviderOptions): AgentProvider {
  return createCoreOpenAICompatibleAgentProvider({
    ...options,
    fetchImpl: options.fetchImpl ?? createRequiredAppFetch({ policy: 'streaming' }),
  })
}

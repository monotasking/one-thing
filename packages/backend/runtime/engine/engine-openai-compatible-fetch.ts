import { createOpenAICompatibleAgentProvider as createCoreOpenAICompatibleAgentProvider, type OpenAICompatibleAgentProviderOptions } from '@onething/backend/runtime/providers'
import { createRequiredAppFetch } from '@onething/backend/runtime/settings'
import type { AgentProvider } from '@onething/backend/runtime/agent-loop/loop-primitives'

export type { OpenAICompatibleAgentProviderOptions } from '@onething/backend/runtime/providers'

export function createOpenAICompatibleAgentProvider(options: OpenAICompatibleAgentProviderOptions): AgentProvider {
  return createCoreOpenAICompatibleAgentProvider({
    ...options,
    fetchImpl: options.fetchImpl ?? createRequiredAppFetch({ policy: 'streaming' }),
  })
}

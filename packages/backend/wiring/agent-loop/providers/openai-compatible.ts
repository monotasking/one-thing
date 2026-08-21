import {
  createOpenAICompatibleAgentProvider as createCoreOpenAICompatibleAgentProvider,
  type OpenAICompatibleAgentProviderOptions,
} from '@onething/runtime/agent-loop/providers'
import { createRequiredAppFetch } from '../../../providers/bound-fetch.js'
import type { AgentProvider } from '@onething/core/agent-loop'

export type { OpenAICompatibleAgentProviderOptions } from '@onething/runtime/agent-loop/providers'

export function createOpenAICompatibleAgentProvider(options: OpenAICompatibleAgentProviderOptions): AgentProvider {
  return createCoreOpenAICompatibleAgentProvider({
    ...options,
    fetchImpl: options.fetchImpl ?? createRequiredAppFetch({ policy: 'streaming' }),
  })
}

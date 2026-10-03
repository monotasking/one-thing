import {
  createOpenAICompatibleAgentProvider as createCoreOpenAICompatibleAgentProvider,
  type OpenAICompatibleAgentProviderOptions,
} from './agent-providers.js'
import { createRequiredAppFetch } from '@onething/backend/runtime/settings'
import type { AgentProvider } from '@onething/backend/runtime/agent-loop/loop-primitives'

export type { OpenAICompatibleAgentProviderOptions } from './agent-providers.js'

export function createOpenAICompatibleAgentProvider(options: OpenAICompatibleAgentProviderOptions): AgentProvider {
  return createCoreOpenAICompatibleAgentProvider({
    ...options,
    fetchImpl: options.fetchImpl ?? createRequiredAppFetch({ policy: 'streaming' }),
  })
}

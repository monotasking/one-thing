import {
  createClaudeAgentProvider as createCoreClaudeAgentProvider,
  type ClaudeAgentProviderOptions,
} from '@onething/runtime/agent-loop/providers'
import { createRequiredAppFetch } from '../../../providers/bound-fetch.js'
import type { AgentProvider } from '@onething/core/agent-loop'

export type { ClaudeAgentProviderOptions } from '@onething/runtime/agent-loop/providers'

export function createClaudeAgentProvider(options: ClaudeAgentProviderOptions): AgentProvider {
  return createCoreClaudeAgentProvider({
    ...options,
    fetchImpl: options.fetchImpl ?? createRequiredAppFetch({ policy: 'streaming' }),
  })
}

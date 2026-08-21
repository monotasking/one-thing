import {
  createDeepSeekAgentProvider as createCoreDeepSeekAgentProvider,
  type DeepSeekAgentProviderOptions,
} from '@onething/runtime/agent-loop/providers'
import { createRequiredAppFetch } from '../../../provider-binding/bound-fetch.js'
import { dumpProviderRequest } from '../../../provider-binding/request-dump.js'
import type { AgentProvider } from '@onething/core/agent-loop'

export type { AgentProviderRequestDump, DeepSeekAgentProviderOptions } from '@onething/runtime/agent-loop/providers'

export function createDeepSeekAgentProvider(options: DeepSeekAgentProviderOptions): AgentProvider {
  return createCoreDeepSeekAgentProvider({
    ...options,
    fetchImpl: options.fetchImpl ?? createRequiredAppFetch({ policy: 'streaming' }),
    requestDumper: options.requestDumper ?? dumpProviderRequest,
  })
}

import {
  createGeminiAgentProvider as createCoreGeminiAgentProvider,
  type GeminiAgentProviderOptions,
} from '@onething/runtime/agent-loop/providers'
import { createRequiredAppFetch } from '../../../provider-binding/bound-fetch.js'
import { providerMediaReader } from './media-reader.js'
import type { AgentProvider } from '@onething/core/agent-loop'

export type { GeminiAgentProviderOptions } from '@onething/runtime/agent-loop/providers'

export function createGeminiAgentProvider(options: GeminiAgentProviderOptions): AgentProvider {
  return createCoreGeminiAgentProvider({
    ...options,
    fetchImpl: options.fetchImpl ?? createRequiredAppFetch({ policy: 'streaming' }),
    // 多轮改图(P4-2):历史 assistant 消息里画过的图从媒体库回读,作为
    // `inlineData` 原样放回 `contents`。
    media: options.media ?? providerMediaReader,
  })
}

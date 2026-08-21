import {
  createACPAgentProvider as createCoreACPAgentProvider,
  type CoreACPAgentProviderOptions,
} from './acp.js'
import { ACPManager } from '../../acp/index.js'
import type { AgentProvider } from '@onething/core/agent-loop'

export interface ACPAgentProviderOptions extends Omit<CoreACPAgentProviderOptions, 'streamPrompt' | 'cwd'> {}

export function createACPAgentProvider(options: ACPAgentProviderOptions = {}): AgentProvider {
  return createCoreACPAgentProvider({
    ...options,
    cwd: () => process.cwd(),
    streamPrompt: (model, promptOptions) => ACPManager.streamPrompt(model, promptOptions),
  })
}

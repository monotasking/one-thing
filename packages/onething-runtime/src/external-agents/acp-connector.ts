import { createACPAgentProvider, type CoreACPAgentProviderOptions } from '../agent-loop/providers/acp.js'
import type {
  ExternalAgentCapabilities,
  ExternalAgentConnector,
  ExternalAgentEvent,
  ExternalAgentTurnRequest,
} from './types.js'

export interface AcpConnectorOptions {
  /** ACP agent id this connector drives (one connector per configured agent). */
  agentId: string
  streamPrompt: CoreACPAgentProviderOptions['streamPrompt']
  cancelSession?: (localSessionId: string, agentId: string) => Promise<void>
}

const ACP_CAPABILITIES: ExternalAgentCapabilities = {
  streamingText: true,
  thinking: true,
  toolSteps: true,
  permissionBridge: 'rpc',
  // ACP session records live in the client process only; resume across app
  // restarts needs the connector-native protocols (P1+).
  resume: false,
  fork: false,
  steer: false,
  imagesIn: false,
  mcpInjection: 'config',
  concurrentSessions: 'multiplexed',
}

/**
 * The generic fallback connector: any ACP-speaking CLI, driven through the
 * existing ACPManager/ACPClient plumbing and the structured ACP event
 * mapping in agent-loop/providers/acp.ts.
 */
export function createAcpConnector(options: AcpConnectorOptions): ExternalAgentConnector {
  return {
    id: `acp:${options.agentId}`,
    capabilities: ACP_CAPABILITIES,

    async *streamTurn(request: ExternalAgentTurnRequest): AsyncIterable<ExternalAgentEvent> {
      const aCPAgentProviderOptions: CoreACPAgentProviderOptions = {
        localSessionId: request.localSessionId,
        workingDirectory: request.cwd,
        streamPrompt: options.streamPrompt,
      };
      const provider = createACPAgentProvider(aCPAgentProviderOptions)
      if (!provider.streamTurn) throw new Error('ACP provider did not expose streamTurn')
      yield* provider.streamTurn({
        model: request.model ?? options.agentId,
        messages: [{ role: 'user', content: request.prompt }],
        abortSignal: request.abortSignal,
        turn: request.turn,
      })
    },

    async interrupt(localSessionId: string): Promise<void> {
      await options.cancelSession?.(localSessionId, options.agentId)
    },

    async dispose(): Promise<void> {
      // Lifecycle is owned by ACPManager (idle cleanup + shutdown); nothing
      // to tear down per connector.
    },
  }
}

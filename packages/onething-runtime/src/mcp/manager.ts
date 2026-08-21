import { MCPClient } from './client.js'
import { HeadlessMCPManager } from '@onething/core/mcp'
import type { MCPClientFactory, MCPClientLike, MCPServerConfig, MCPServerState } from '@onething/core/mcp'
import { configureMCPOAuthAuthorizedHandler, getMCPOAuthFlowManager } from './oauth/index.js'

/**
 * Host-injected MCP client factory.
 *
 * The engine's MCP bridge (mcp/bridge.ts) is bound to this single manager, so a
 * host that needs a different client (apps/server gates stdio behind
 * ONETHING_SERVER_MCP_STDIO and disables connections entirely by default) must
 * contribute its factory here rather than standing up a second manager — a
 * second manager would connect servers the engine cannot see.
 *
 * Late-bound and consulted per call, like the other configure*Host ports.
 */
let clientHostFactory: MCPClientFactory<MCPClientLike> | null = null

export function configureMCPClientHost(
  factory: MCPClientFactory<MCPClientLike> | null,
): void {
  clientHostFactory = factory
}

class MCPManagerClass extends HeadlessMCPManager<MCPClientLike> {
  constructor() {
    super((config: MCPServerConfig) => clientHostFactory
      ? clientHostFactory(config)
      : new MCPClient(config) as MCPClientLike)
  }

  /**
   * Merge the OAuth surface at read time: a pending authorization URL lives
   * in the flow manager (not in connection state), so the settings UI always
   * sees "登录 / 已授权 issuer" without the engine knowing OAuth exists.
   */
  private withOAuthSurface(state: MCPServerState): MCPServerState {
    const oauth = getMCPOAuthFlowManager().surface(state.config.id, state.status === 'connected')
    return oauth ? { ...state, oauth } : state
  }

  override getServerState(serverId: string): MCPServerState | undefined {
    const state = super.getServerState(serverId)
    return state ? this.withOAuthSurface(state) : state
  }

  override getServerStates(): MCPServerState[] {
    return super.getServerStates().map(state => this.withOAuthSurface(state))
  }
}

export const MCPManager = new MCPManagerClass()

configureMCPOAuthAuthorizedHandler(serverId => {
  void MCPManager.reconnectServer(serverId)
})

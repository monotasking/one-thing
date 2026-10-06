import { MCPClient } from './mcp-client.js'
import { HeadlessMCPManager } from '@onething/backend/mcp/kernel'
import type { MCPClientFactory, MCPClientLike } from '@onething/backend/mcp/kernel'
import type { MCPServerConfig, MCPServerState } from '@shared/mcp/types'
import { configureMCPOAuthAuthorizedHandler, getMCPOAuthFlowManager } from './oauth/mcp-oauth.js'

/**
 * Host-injected MCP client factory.
 *
 * The engine's MCP bridge (mcp/mcp-bridge.ts) is bound to this single manager, so a
 * host that needs a different client (the standalone backend process (`backend-standalone-main.ts`) gates stdio behind
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

/**
 * 没有注入客户端宿主时用的那种客户端(桌面一直用的就是它)。第④步批 2a 起,不带界面的后端进程的桌面档
 * 把它当 `mcpClientFactory` 交给 server runtime(`backend-launcher.ts`),于是那台进程连的 MCP 与桌面
 * 进程内那份是同一种客户端,而不是 server 缺省的 `DisabledServerMCPClient`。
 */
export function createNativeMCPClient(config: MCPServerConfig): MCPClientLike {
  return new MCPClient(config) as MCPClientLike
}

class MCPManagerClass extends HeadlessMCPManager<MCPClientLike> {
  constructor() {
    super((config: MCPServerConfig) => clientHostFactory
      ? clientHostFactory(config)
      : createNativeMCPClient(config))
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

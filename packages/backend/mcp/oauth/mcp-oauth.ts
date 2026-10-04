/**
 * MCP OAuth module — singleton access.
 *
 * The flow manager is created lazily (the store path layer reads env on first
 * touch, not at import time) and its "now reconnect" hook is late-bound like
 * every other configure* port: `manager.ts` wires it to
 * `MCPManager.reconnectServer` without this module importing the manager
 * (which would close an import cycle through client.ts).
 */

import {
  getOnethingMCPOAuthCredentialsPath,
} from '../../storage/storage.js'
import { MCPOAuthFlowManager } from './mcp-oauth-flow-manager.js'

export { MCPOAuthFlowManager, MCP_OAUTH_CALLBACK_PORTS } from './mcp-oauth-flow-manager.js'
export { MCPOAuthProvider } from './mcp-oauth-provider.js'
export { MCPOAuthCredentialStore } from './mcp-oauth-credential-store.js'
export type {
  MCPOAuthClientInformation,
  MCPOAuthClientMetadata,
  MCPOAuthFlowState,
  MCPOAuthTokens,
  MCPServerOAuthSurface,
} from './mcp-oauth-types.js'

let flowManager: MCPOAuthFlowManager | null = null
let authorizedHandler: ((serverId: string) => void) | null = null

/** Wire the post-authorization reconnect trigger (called once by manager.ts). */
export function configureMCPOAuthAuthorizedHandler(handler: (serverId: string) => void): void {
  authorizedHandler = handler
}

export function getMCPOAuthFlowManager(): MCPOAuthFlowManager {
  if (!flowManager) {
    flowManager = new MCPOAuthFlowManager({
      credentialStorePath: getOnethingMCPOAuthCredentialsPath(),
      onAuthorized: serverId => authorizedHandler?.(serverId),
    })
  }
  return flowManager
}

/** Test hook: reset the singleton between suites. */
export function resetMCPOAuthFlowManagerForTests(): void {
  flowManager = null
}

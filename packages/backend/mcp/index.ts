/**
 * MCP Module Entry Point
 *
 * Provides a unified interface for MCP functionality
 */

export type {
  MCPClientFactory,
  MCPClientLike,
} from '@onething/core/mcp'

// Export types
export type {
  MCPTransportType,
  MCPServerConfig,
  MCPConnectionStatus,
  MCPServerState,
  MCPToolInfo,
  MCPResourceInfo,
  MCPPromptInfo,
  MCPToolCallRequest,
  MCPToolCallResult,
  MCPSettings,
} from './types.js'

export { DEFAULT_MCP_SETTINGS } from './types.js'

// Export client
export { MCPClient, probeMCPServerConfig } from './client.js'

// Export manager
export { MCPManager, configureMCPClientHost } from './manager.js'

// Export OAuth flow management
export { getMCPOAuthFlowManager } from './oauth/index.js'

// Export client identity (late-bound host version)
export { configureMCPClientIdentity, getMCPClientIdentity } from './identity.js'

// Export capabilities-changed fan-out (P2-1 push-driven refresh)
export { configureMCPCapabilitiesChangedHandler, notifyMCPCapabilitiesChanged } from './capabilities-changed.js'

// Export bridge functions
export {
  mcpToolToToolDefinition,
  getMCPRouterToolDefinition,
  getMCPToolDefinitionsForModel,
  mcpInputSchemaToZod,
  getMCPToolsForAI,
  registerMCPTools,
  parseMCPToolId,
  isMCPTool,
  executeMCPTool,
  resolveMCPServerIdForToolRef,
  findMCPToolIdByShortName,
} from './bridge.js'

export { ACP_CONNECTOR_ID, capabilitiesFromHandshake, createAcpConnector } from './acp-connector.js'
export type { AcpConnectorDeps, AcpConnectorOptions, AcpHostMcpPort, AcpMcpCapabilitiesInput } from './acp-connector.js'
export { describeAcpToolPermission, describeExternalToolPermission } from './permission-effects.js'
export { buildTextDiffChange } from './diff-changes.js'
export type { TextDiffChange } from './diff-changes.js'
export type {
  AcpToolPermissionInput,
  AcpToolPermissionShape,
  ExternalToolPermissionInput,
  ExternalToolPermissionShape,
} from './permission-effects.js'
export {
  activeHostToolContextCount,
  bindHostToolContext,
  clearHostToolContexts,
  filterHostToolSurface,
  HOST_MCP_SERVER_NAME,
  HOST_MCP_TOOL_CANDIDATES,
  HOST_MCP_TOOL_PREFIX,
  HOST_MCP_TURN_GONE,
  hostMcpToolDefinitionWith,
  hostMcpToolName,
  isHostMcpToolName,
  resolveHostToolContext,
  resolveHostToolSurface,
  stripHostMcpToolPrefix,
  toHostMcpToolDefinition,
} from './host-mcp/index.js'
export type {
  HostMcpCallResult,
  HostMcpHostTool,
  HostMcpToolDefinition,
  HostToolSurfaceInput,
  HostToolTurnContext,
} from './host-mcp/index.js'
export type {
  ExternalAgentCapabilities,
  ExternalAgentConnector,
  ExternalAgentEvent,
  ExternalAgentInteractionAsk,
  ExternalAgentInteractionHandler,
  ExternalAgentMcpAttribution,
  ExternalAgentPermissionAsk,
  ExternalAgentPermissionBridgeKind,
  ExternalAgentPermissionDecision,
  ExternalAgentPermissionHandler,
  ExternalAgentSessionLink,
  ExternalAgentSteerOutcome,
  ExternalAgentTurnRequest,
} from './types.js'

// ── providers 归位(D24,2026-10-04):外部 agent 这一种 AgentProvider 的实现搬进了 providers
// (`providers/provider-external-agent.ts`),它要读这里的图片输入类型。
export type {
  ExternalAgentImageInput,
} from './types.js'

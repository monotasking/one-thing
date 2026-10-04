export { ACP_CONNECTOR_ID, capabilitiesFromHandshake, createAcpConnector } from './external-agent-acp-connector.js'
export type { AcpConnectorDeps, AcpConnectorOptions, AcpHostMcpPort, AcpMcpCapabilitiesInput } from './external-agent-acp-connector.js'
export { describeAcpToolPermission, describeExternalToolPermission } from './external-agent-permission-effects.js'
export { buildTextDiffChange } from './external-agent-diff-changes.js'
export type { TextDiffChange } from './external-agent-diff-changes.js'
export type {
  AcpToolPermissionInput,
  AcpToolPermissionShape,
  ExternalToolPermissionInput,
  ExternalToolPermissionShape,
} from './external-agent-permission-effects.js'
export {
  activeHostToolContextCount,
  bindHostToolContext,
  clearHostToolContexts,
  filterHostToolSurface,
  HOST_MCP_SERVER_NAME,
  hostMcpToolCandidates,
  registerHostInjectableTools,
  HOST_MCP_TOOL_PREFIX,
  HOST_MCP_TURN_GONE,
  hostMcpToolDefinitionWith,
  hostMcpToolName,
  isHostMcpToolName,
  resolveHostToolContext,
  resolveHostToolSurface,
  stripHostMcpToolPrefix,
  toHostMcpToolDefinition,
} from './host-mcp/external-agent-host-mcp.js'
export type {
  HostMcpCallResult,
  HostMcpHostTool,
  HostMcpToolDefinition,
  HostInjectableTool,
  HostToolSurfaceInput,
  HostToolTurnContext,
} from './host-mcp/external-agent-host-mcp.js'
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
} from './external-agent-types.js'

// ── providers 归位(D24,2026-10-04):外部 agent 这一种 AgentProvider 的实现搬进了 providers
// (`providers/provider-external-agent.ts`),它要读这里的图片输入类型。
export type {
  ExternalAgentImageInput,
} from './external-agent-types.js'
// 牌位查询端口(越层清零 A5③):装配在造引擎时填 `findCollabV3Turn`,外部 agent 的宿主工具面只读这一格。
export {
  configureExternalAgentTurnLookup,
  findExternalAgentTurn,
  type ExternalAgentTurnLookup,
  type ExternalAgentTurnLookupResult,
} from './external-agent-turn-lookup.js'

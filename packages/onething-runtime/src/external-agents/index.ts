export { createAcpConnector } from './acp-connector.js'
export type { AcpConnectorOptions } from './acp-connector.js'
export {
  ASK_USER_QUESTION_TOOL,
  askUserQuestionOutput,
  askUserQuestionToInteraction,
  CLAUDE_CODE_AGENT_CONNECTOR_ID,
  createClaudeCodeConnector,
  DEFAULT_USER_DIALOG_KINDS,
  userDialogToInteraction,
} from './claude-code-connector.js'
export type {
  ClaudeCodeConnectorOptions,
  ClaudeCodeQueryFn,
  ClaudeCodeQueryOptions,
  ClaudeCodeSdkMessage,
} from './claude-code-connector.js'
export { describeExternalToolPermission } from './permission-effects.js'
export type {
  ExternalToolPermissionInput,
  ExternalToolPermissionShape,
} from './permission-effects.js'
export {
  activeHostToolContextCount,
  bindHostToolContext,
  clearHostToolContexts,
  createHostMcpServer,
  filterHostToolSurface,
  HOST_MCP_SERVER_NAME,
  HOST_MCP_TOOL_CANDIDATES,
  HOST_MCP_TOOL_PREFIX,
  HOST_MCP_TURN_GONE,
  hostMcpToolName,
  isHostMcpToolName,
  resolveHostToolContext,
  resolveHostToolSurface,
  stripHostMcpToolPrefix,
  toHostMcpToolDefinition,
} from './host-mcp/index.js'
export type {
  CreateHostMcpServerOptions,
  CreateSdkMcpServerFn,
  HostMcpCallResult,
  HostMcpHostTool,
  HostMcpInjection,
  HostMcpServer,
  HostMcpSurfaceResolver,
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

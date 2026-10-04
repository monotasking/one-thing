/**
 * external-agent —— 外部 agent(经 ACP 接进来的 Claude Code 等):连接器(把一个外部 agent 当一种「服务商」来发回合)、
 * 权限效果的描述、文本改动的差异、宿主工具面、牌位查询端口,以及起子进程用的环境。
 *
 * 对外交出几类东西(按来源文件分组):ACP 连接器与它的依赖形状;权限效果的描述;文本差异;外部 agent 的
 * 共用形状(连接器、会话链接、回合请求……);牌位查询端口;末尾补的两只(宿主工具面的形状、起子进程的环境)。
 * 连接器登记表(`external-agent-connector-registry.ts`)不从这里出去:它引 acp 的入口,而 acp 的入口又引这里,
 * 交出就成环;要它的几处装配读者仍直接引它。
 * 依赖 acp、agent、session、settings、tool、agent-loop、storage、logging。
 */
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

// 宿主工具面的形状、起外部 agent 子进程时的环境(深层引用收口第四批补进入口)。
export type { HostToolSurface } from './external-agent-host-tools.js'
export { resolveExternalAgentSpawnEnv } from './external-agent-spawn-env.js'

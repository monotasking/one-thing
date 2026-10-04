/**
 * external-agent —— 外部 agent(经 ACP 接进来的 Claude Code 等):连接器(把一个外部 agent 当一种「服务商」来发回合)、
 * 权限效果的描述、文本改动的差异、宿主工具面、牌位查询端口,以及起子进程用的环境。
 *
 * 对外交出几类东西(按来源文件分组):权限效果的描述;文本差异;宿主 MCP 那一套(工具 id、上下文、定义);
 * 外部 agent 的共用形状(连接器、会话链接、回合请求……);牌位查询端口;宿主工具面与起子进程的环境;连接器登记表。
 * 方向定死「驱动 → 契约」(D202):这里是契约,ACP 是它的一种驱动 —— ACP 的连接器住 acp,
 * 连接器表与会话链接表由装配组好递进登记表,本功能不写任何驱动的名字。
 * 依赖(入口值闭包实测,797 只文件):toolkit、session、permission、interaction、agent、agent-loop、settings、tool、
 * storage、logging 等 29 个功能与包根的当前实例槽;**不含 acp**(驱动 → 契约,单向)。
 */
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
  resolveHostToolIds,
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
  ExternalAgentSessionLinkStore,
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

// 宿主工具面(按会话 id 给这一轮的整张工具面;ACP 的宿主 MCP 桥经 `AcpSubsystem` 的 deps 拿它)与它的形状、
// 起外部 agent 子进程时的环境(深层引用收口第四批补进入口;D202 补交异步那只 `resolveHostToolSurface`)。
export { resolveHostToolSurface } from './external-agent-host-tools.js'
export type { HostToolSurface } from './external-agent-host-tools.js'
export { resolveExternalAgentSpawnEnv } from './external-agent-spawn-env.js'

// 连接器登记表(D202:改成只读表 —— 连接器与会话链接表由装配组好递进 `bindExternalAgentConnectors`,
// 契约不写驱动的名字;从前它引 acp 入口、交出就成环,只能让装配读者深引)。
export {
  askExternalAgentInteraction,
  askExternalAgentPermission,
  bindExternalAgentConnectors,
  disposeExternalAgentConnectors,
  getExternalAgentConnectors,
  interruptExternalAgentSessions,
  persistExternalAgentSessionLink,
  resolveExternalAgentSessionLink,
  takeExternalAgentSteering,
} from './external-agent-connector-registry.js'

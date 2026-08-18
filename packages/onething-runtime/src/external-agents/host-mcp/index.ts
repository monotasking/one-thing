/**
 * 宿主工具面(E3,docs/design/claude-code-integration-v2.md §2)的桶。
 *
 * 三块各司一职:`context` 绑一轮的语境、`tools` 决定注入哪几个并把既有执行器包成
 * MCP handler、`server` 起进程内 MCP 服务器。`types` 是三方共用的词汇。
 */
export {
  activeHostToolContextCount,
  bindHostToolContext,
  clearHostToolContexts,
  resolveHostToolContext,
} from './context.js'
export {
  createHostMcpServer,
  type CreateHostMcpServerOptions,
  type CreateSdkMcpServerFn,
  type HostMcpServer,
} from './server.js'
export {
  filterHostToolSurface,
  HOST_MCP_TOOL_CANDIDATES,
  HOST_MCP_TURN_GONE,
  resolveHostToolSurface,
  toHostMcpToolDefinition,
  type HostMcpCallResult,
  type HostMcpHostTool,
  type HostMcpToolDefinition,
  type HostToolSurfaceInput,
} from './tools.js'
export {
  HOST_MCP_SERVER_NAME,
  HOST_MCP_TOOL_PREFIX,
  hostMcpToolName,
  isHostMcpToolName,
  stripHostMcpToolPrefix,
  type HostMcpInjection,
  type HostMcpSurfaceResolver,
  type HostToolTurnContext,
} from './types.js'

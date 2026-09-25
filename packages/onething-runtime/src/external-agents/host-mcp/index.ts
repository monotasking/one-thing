/**
 * 宿主工具面(E3,docs/design/claude-code-integration-v2.md §2)的桶。
 *
 * 两块各司一职:`context` 绑一轮的语境、`tools` 决定注入哪几个并把既有执行器包成
 * MCP handler。`types` 是共用的词汇。A6-b(2026-09-26)起进程内 SDK MCP 服务器(`server.ts`)
 * 随 Claude SDK 连接器退役;宿主工具经 ACP 的 stdio 桥(`acp/mcp-bridge/`)出去。
 */
export {
  activeHostToolContextCount,
  bindHostToolContext,
  clearHostToolContexts,
  resolveHostToolContext,
} from './context.js'
export {
  filterHostToolSurface,
  HOST_MCP_TOOL_CANDIDATES,
  HOST_MCP_TURN_GONE,
  hostMcpToolDefinitionWith,
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
  type HostToolTurnContext,
} from './types.js'

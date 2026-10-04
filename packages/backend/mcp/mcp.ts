/**
 * mcp —— MCP:连外部 MCP 服务器的客户端与管理器、OAuth 登录、客户端身份、能力变更通知,
 * 以及 `mcp:` 资源与装配用的子系统。
 *
 * 对外交出六类东西:
 * - 管理器与客户端:`MCPManager`、装上客户端工厂、探测一个服务器配置、不带界面的那台管理器、
 *   独立 server 自己的客户端,客户端工厂与客户端的形状;
 * - 装配:MCP 子系统 `McpSubsystem`、客户端身份的装上 / 复位、能力变更的处理口与工具表变更订阅;
 * - `mcp:` 资源的规格与投影;
 * - 服务器配置里私密字段的脱敏判据;
 * - 结果文本与服务器状态的两只小工具、调试日志口的形状;
 * - 跨进程工具桥:把 MCP 工具投影成模型看得见的工具定义、登记 / 执行 MCP 工具、解析工具 id。
 *   从前它们住在旁边那只「本入口 + 工具桥」的旧桶 `mcp-index-with-bridge.ts` 里,2026-10-04(D202)并进来、旧桶删掉。
 *
 * 依赖(入口值闭包实测,399 只文件):auth、agent-loop、provider、settings、space、tool、network、event、storage、logging
 * 与包根的当前实例槽(工具桥并进来之后多了 agent-loop / provider / tool 那一截)。
 */

// 管理器与客户端。
export { MCPManager, configureMCPClientHost } from './mcp-manager.js'
export { probeMCPServerConfig } from './mcp-client.js'
export { HeadlessMCPManager } from './kernel/mcp-kernel-manager.js'
export { ServerMCPClient } from './mcp-server-client.js'
export type { MCPClientFactory, MCPClientLike } from '@onething/backend/mcp/kernel'

// 装配。
export { McpSubsystem } from './mcp-subsystem.js'
export { configureMCPClientIdentity, resetMCPClientIdentity } from './mcp-identity.js'
export { configureToolkitMCPCapabilitiesChangedHandler, onMCPToolTableChanged } from './mcp-capabilities-changed.js'

// `mcp:` 资源。
export { MCP_RESOURCE_SINGLETON_PATH, mcpResourceScheme, projectMcpResource } from './mcp-resource-spec.js'
export type { McpResourceProjection } from './mcp-resource-spec.js'

// 私密字段的脱敏判据。
export { MCP_SERVER_PRIVATE_KEYS, SERVER_REDACTED_SECRET, shouldRedactMcpPrivateValue } from './mcp-secrets.js'

// 小工具与调试日志口。
export { createMCPServerState } from './kernel/mcp-kernel-client-state.js'
export { withMCPResultOutputText } from './kernel/mcp-kernel-router.js'
export type { OnethingMCPIpcLogger } from './mcp-ipc-operations.js'

// 跨进程工具桥(说 `ToolDefinition` 词汇;`mcp-bridge.ts` 不引本入口,所以这里转交不成环)。
export {
  executeMCPTool,
  findMCPToolIdByShortName,
  getMCPRouterToolDefinition,
  getMCPToolDefinitionsForModel,
  getMCPToolsForAI,
  isMCPTool,
  mcpInputSchemaToZod,
  mcpToolToToolDefinition,
  parseMCPToolId,
  registerMCPTools,
  resolveMCPServerIdForToolRef,
} from './mcp-bridge.js'

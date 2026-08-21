/**
 * MCP 领域的**完整**门面:产品面 + 说跨进程词汇的工具桥。
 *
 * P3'b-A:`packages/backend/mcp/index.ts` 的原样接续 —— 老调用点(装配层脊柱、
 * apps/electron 的 IPC handler、apps/server 的 runtime)拿到的符号集合与迁移前
 * 逐个相同,只是说明符从 `@onething/backend/mcp/index.js` 变成
 * `@onething/runtime/mcp/index.wiring`。
 *
 * 为什么不是 `index.ts`:`bridge.wiring.ts` 按 I3 带后缀(它说跨进程
 * 契约的 `ToolDefinition` 词汇),而 checker 的
 * `checkRuntimeWiringModulesStayAtTheEdge` 禁止非 wiring 的产品文件 import
 * `*.wiring` 模块。所以桥只能从一个 wiring 门面出去。
 */

export * from './index.js'

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
} from './bridge.wiring.js'

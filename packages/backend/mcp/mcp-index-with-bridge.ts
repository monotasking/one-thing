/**
 * MCP 领域的**完整**门面:产品面 + 说跨进程词汇的工具桥。
 *
 * P3'b-A:`packages/backend/mcp/mcp.ts` 的原样接续 —— 老调用点(装配层脊柱、
 * apps/electron 的 IPC handler、apps/backend-server 的 runtime)拿到的符号集合与迁移前
 * 逐个相同,只是说明符从 `@onething/backend/mcp/index.js` 变成
 * `@onething/backend/mcp/mcp-index-with-bridge`。
 *
 * 为什么不是 `index.ts`:当年 `bridge.ts` 叫 `bridge.wiring.ts`(它说跨进程契约的
 * `ToolDefinition` 词汇),检查器的 `checkRuntimeWiringModulesStayAtTheEdge` 禁止非 wiring 文件
 * import `*.wiring` 模块,所以桥只能从一个同样带后缀的门面(本文件当年叫 `index.wiring.ts`)出去。
 * 那条规则随第③步拍平撤了,2026-10-03 后缀也去掉了;两只桶没有合,本文件按内容改名为「目录桶 + 工具桥」。
 */

export * from './mcp.js'

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
} from './mcp-bridge.js'

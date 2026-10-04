export * from './capability-operations.js'
export * from './mcp-ipc-operations.js'
export * from './server-orchestration.js'

/*
 * P3'b-A(§2 P3'):`packages/backend/mcp/` 的目录级门面并到这里 —— I1「一个领域
 * 一个家」。MCP 的客户端 / 管理器 / OAuth / 身份 / 能力变更都不依赖后端脊柱(它们
 * 只认 core 契约 + `@onething/backend/storage`),所以它们是产品层。
 *
 * 唯一留在外面的是 `bridge.ts` —— 它说跨进程契约的 `ToolDefinition` 词汇。当年它叫
 * `bridge.wiring.ts`,而这条 barrel 不许 import `*.wiring`;那条规则已撤,桥照旧不从这里出去。
 * 要连桥一起拿的调用方走 `./index-with-bridge.js`。
 */

export type {
  MCPClientFactory,
  MCPClientLike,
} from '@onething/backend/mcp/kernel'

export { MCPClient, probeMCPServerConfig } from './mcp-client.js'

export { MCPManager, configureMCPClientHost } from './mcp-manager.js'

export { getMCPOAuthFlowManager } from './oauth/mcp-oauth.js'

export { configureMCPClientIdentity, getMCPClientIdentity } from './mcp-identity.js'

export { configureMCPCapabilitiesChangedHandler, notifyMCPCapabilitiesChanged } from './capabilities-changed.js'

// 不带界面单独跑的 server 自己那台 MCP 客户端(server runtime 装进 `configureMCPClientHost`;包根归位 2026-10-04 从 `server/mcp-client.ts` 搬来)。
export { ServerMCPClient, probeServerMCPConfig, type ServerMCPClientOptions } from './mcp-server-client.js'

// MCP 服务器配置里的私密字段:出网前脱敏、写回时合并(从 `server/mcp-secrets.ts` 搬来;设置面的出界投影也用它)。
export {
  MCP_SERVER_PRIVATE_KEYS,
  SERVER_REDACTED_SECRET,
  mergeRedactedMCPServerConfig,
  sanitizeMCPMutationResultForClient,
  sanitizeMCPServerConfigForClient,
  sanitizeMCPServerStateForClient,
  sanitizeMCPServerStatesForClient,
  shouldRedactMcpPrivateValue,
} from './mcp-secrets.js'

export * from './capability-operations.js'
export * from './ipc-operations.js'
export * from './server-orchestration.js'

/*
 * P3'b-A(§2 P3'):`packages/backend/mcp/` 的目录级门面并到这里 —— I1「一个领域
 * 一个家」。MCP 的客户端 / 管理器 / OAuth / 身份 / 能力变更都不依赖后端脊柱(它们
 * 只认 core 契约 + `@onething/backend/runtime/storage`),所以它们是产品层。
 *
 * 唯一留在外面的是 `bridge.ts` —— 它说跨进程契约的 `ToolDefinition` 词汇。当年它叫
 * `bridge.wiring.ts`,而这条 barrel 不许 import `*.wiring`;那条规则已撤,桥照旧不从这里出去。
 * 要连桥一起拿的调用方走 `./index-with-bridge.js`。
 */

export type {
  MCPClientFactory,
  MCPClientLike,
} from '@onething/backend/runtime/mcp/kernel'

export { MCPClient, probeMCPServerConfig } from './client.js'

export { MCPManager, configureMCPClientHost } from './manager.js'

export { getMCPOAuthFlowManager } from './oauth/index.js'

export { configureMCPClientIdentity, getMCPClientIdentity } from './identity.js'

export { configureMCPCapabilitiesChangedHandler, notifyMCPCapabilitiesChanged } from './capabilities-changed.js'

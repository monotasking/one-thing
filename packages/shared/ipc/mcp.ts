/**
 * MCP Module
 * MCP (Model Context Protocol) server-related type definitions for IPC communication
 *
 * Base types (`MCPTransportType`, `MCPServerConfig`, …) are re-exported from
 * `@onething/core/mcp` — the engine is the single source of truth. Only the
 * IPC request/response envelopes are defined locally here. Extend transports
 * in `packages/core/mcp/types.ts` and every layer follows.
 */

import type { JsonArray, JsonObject, JsonValue } from '../json.js'
import { defineRouter } from './router.js'
import type { CoreMCPProbeResult, MCPToolCallResult } from '@onething/core/mcp'

export type {
  MCPConnectionStatus,
  MCPPromptInfo,
  MCPResourceInfo,
  MCPServerConfig,
  MCPServerState,
  MCPSettings,
  MCPToolCallRequest,
  MCPToolCallResult,
  MCPToolInfo,
  MCPTransportType,
} from '@onething/core/mcp'

import type {
  MCPServerConfig,
  MCPServerState,
  MCPToolInfo,
  MCPResourceInfo,
  MCPPromptInfo,
} from '@onething/core/mcp'

// MCP IPC Request/Response types
export interface MCPGetServersResponse {
  success: boolean
  servers?: MCPServerState[]
  error?: string
}

export interface MCPAddServerRequest {
  config: MCPServerConfig
}

export interface MCPAddServerResponse {
  success: boolean
  server?: MCPServerState
  error?: string
}

export interface MCPUpdateServerRequest {
  config: MCPServerConfig
}

export interface MCPUpdateServerResponse {
  success: boolean
  server?: MCPServerState
  error?: string
}

export interface MCPRemoveServerRequest {
  serverId: string
}

export interface MCPRemoveServerResponse {
  success: boolean
  error?: string
}

export interface MCPConnectServerRequest {
  serverId: string
}

export interface MCPConnectServerResponse {
  success: boolean
  server?: MCPServerState
  error?: string
}

export interface MCPDisconnectServerRequest {
  serverId: string
}

export interface MCPDisconnectServerResponse {
  success: boolean
  error?: string
}

export interface MCPLogoutServerRequest {
  serverId: string
}

export interface MCPLogoutServerResponse {
  success: boolean
  error?: string
}

/**
 * P2-2 preflight probe: dry-run a candidate config before adding it.
 */
export interface MCPProbeServerRequest {
  config: MCPServerConfig
}

export type MCPProbeServerResponse = CoreMCPProbeResult

export interface MCPRefreshServerRequest {
  serverId: string
}

export interface MCPRefreshServerResponse {
  success: boolean
  server?: MCPServerState
  error?: string
}

export interface MCPGetToolsResponse {
  success: boolean
  tools?: MCPToolInfo[]
  error?: string
}

export interface MCPCallToolRequest {
  serverId: string
  toolName: string
  arguments: JsonObject
}

export interface MCPCallToolResponse {
  success: boolean
  content?: MCPToolCallResult['content']
  error?: string
  isError?: boolean
}

export interface MCPGetResourcesResponse {
  success: boolean
  resources?: MCPResourceInfo[]
  error?: string
}

export interface MCPReadResourceRequest {
  serverId: string
  uri: string
}

export interface MCPReadResourceResponse {
  success: boolean
  content?: JsonValue
  error?: string
}

export interface MCPGetPromptsResponse {
  success: boolean
  prompts?: MCPPromptInfo[]
  error?: string
}

export interface MCPGetPromptRequest {
  serverId: string
  name: string
  arguments?: Record<string, string>
}

export interface MCPGetPromptResponse {
  success: boolean
  messages?: JsonArray
  error?: string
}

export interface MCPReadConfigFileRequest {
  filePath: string
}

export interface MCPReadConfigFileResponse {
  success: boolean
  content?: JsonValue
  error?: string
}

// ============================================================================
// mcp 域的 router —— 结构债 P4c 第六批
// ============================================================================

/**
 * mcp(Model Context Protocol 服务器)域 —— **十六条**方法从手写 IPC 通道搬到
 * 通用 `rpc:invoke` / `POST /api/rpc`:服务器的增删改(`getServers` / `addServer` /
 * `updateServer` / `removeServer`)、连接生命周期(`connectServer` /
 * `disconnectServer` / `logoutServer` / `probeServer` / `refreshServer`)、能力面
 * (`getTools` / `callTool` / `getResources` / `readResource` / `getPrompts` /
 * `getPrompt`)与配置文件导入(`readConfigFile`)。
 *
 * 这一域**一条推送都没有**:服务器推来的 list-changed 由客户端就地回灌进状态,
 * 再经 `configureMCPCapabilitiesChangedHandler` 重生成模型面的工具目录 —— 那条路
 * 不过传输面。所以搬完之后 `apps/electron/src/ipc/mcp.ts` 整只删掉,
 * `@main/ipc/mcp.ts` 只剩 `initializeMCP` / `shutdownMCP` 两件生命周期。
 *
 * **三处按 `context.transport` 分叉的护栏**(拍板 #20 的纪律,逐字保留在 handler
 * 里,见 `@onething/backend/rpc/domains/mcp.ts` 的文件头):私密字段脱敏、更新时
 * 把脱敏值合并回去、`readConfigFile` 在 http 上不读本机文件、stdio 探测在 http 上
 * 默认关闭。
 *
 * 位置参数一律折成信封(与 sessions / media / skills / chat / acp 同一判例);
 * 无参的 `getServers` / `getTools` / `getResources` / `getPrompts` 递 `{}`。
 */
export type McpRoutes = {
  getServers: { input: Record<string, never>; output: MCPGetServersResponse }
  addServer: { input: MCPAddServerRequest; output: MCPAddServerResponse }
  updateServer: { input: MCPUpdateServerRequest; output: MCPUpdateServerResponse }
  removeServer: { input: MCPRemoveServerRequest; output: MCPRemoveServerResponse }
  connectServer: { input: MCPConnectServerRequest; output: MCPConnectServerResponse }
  disconnectServer: {
    input: MCPDisconnectServerRequest
    output: MCPDisconnectServerResponse
  }
  logoutServer: { input: MCPLogoutServerRequest; output: MCPLogoutServerResponse }
  probeServer: { input: MCPProbeServerRequest; output: MCPProbeServerResponse }
  refreshServer: { input: MCPRefreshServerRequest; output: MCPRefreshServerResponse }
  getTools: { input: Record<string, never>; output: MCPGetToolsResponse }
  callTool: { input: MCPCallToolRequest; output: MCPCallToolResponse }
  getResources: { input: Record<string, never>; output: MCPGetResourcesResponse }
  readResource: { input: MCPReadResourceRequest; output: MCPReadResourceResponse }
  getPrompts: { input: Record<string, never>; output: MCPGetPromptsResponse }
  getPrompt: { input: MCPGetPromptRequest; output: MCPGetPromptResponse }
  readConfigFile: {
    input: MCPReadConfigFileRequest
    output: MCPReadConfigFileResponse
  }
}

export const mcpRouter = defineRouter<McpRoutes>('mcp', [
  'getServers',
  'addServer',
  'updateServer',
  'removeServer',
  'connectServer',
  'disconnectServer',
  'logoutServer',
  'probeServer',
  'refreshServer',
  'getTools',
  'callTool',
  'getResources',
  'readResource',
  'getPrompts',
  'getPrompt',
  'readConfigFile',
])

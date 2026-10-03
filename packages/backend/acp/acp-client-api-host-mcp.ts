/**
 * `host-mcp` 域(ACP A4-a,`docs/design/acp-integration-2026-09.md` §3.6):宿主工具面的
 * `tools/list` / `tools/call`,**只认桥凭据**。
 *
 * 调用方是 `acp-mcp-bridge.cjs`(stdio 上说 MCP 的那个薄进程),它经 `POST /api/rpc` 带着
 * `Authorization: Bearer <桥凭据>` 进来;HTTP 面(`acp/acp-client-api-host-mcp-face.ts`)查过凭据表才把它放进
 * 来,并把凭据铸进 `context.bridgeCredential`。这里**再查一次**:
 *
 *  - 用户 token 进来的 context 没有 `bridgeCredential` → 拒。工具表是按凭据算的(它背后
 *    是哪条会话、哪台 agent),用户 token 背后没有这些,给它一张表就是替一条它说不出名字
 *    的会话说话。
 *  - 凭据在门口到这里之间被作废了(会话恰好收了)→ 拒。
 *
 * 拒绝一律是一句以 `HOST_MCP_UNAUTHORIZED` 起头的话(RPC 失败只带 message)。
 *
 * 执行不在这里:`callTool` 转手给桥对象,那里用凭据现算一份 `HostToolTurnContext`,交给与
 * Claude 路同一只包装(`hostMcpToolDefinitionWith`)—— 目录里的工具走 `runToolkitToolDirectly`,
 * 审批卡落在发起会话上。
 */
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
import {
  hostMcpRouter,
  HOST_MCP_UNAUTHORIZED,
  type HostMcpCallToolRequest,
  type HostMcpCallToolResponse,
  type HostMcpListToolsResponse,
  type HostMcpRoutes,
} from '@shared/ipc/host-mcp.js'
import { HostMcpUnauthorizedError, type HostMcpBridge } from '@onething/backend/acp/host-mcp-bridge'
import { defineClientApi, type RpcRouteHandlers } from '@onething/backend/http-server/http-server-dispatch-table.js'
import { currentHostMcpBridge, serveBridgeRequest } from './acp-client-api-host-mcp-face.js'

/**
 * 处理者工厂。桥由调用方给 —— 生产里是当前 backend 的那只,单测递一只自己造的。
 */
export function createHostMcpRpcHandlers(
  resolveBridge: () => HostMcpBridge | undefined = currentHostMcpBridge,
): RpcRouteHandlers<HostMcpRoutes> {
  /** 门:context 里有桥凭据,且它此刻还在表里。答那把凭据与桥。 */
  function admit(context: RpcDispatchContext | undefined): { bridge: HostMcpBridge; token: string } {
    const token = context?.bridgeCredential
    if (!token) {
      throw new Error(`${HOST_MCP_UNAUTHORIZED}: host-mcp only accepts a bridge credential, not a user token`)
    }
    const bridge = resolveBridge()
    if (!bridge) throw new Error(`${HOST_MCP_UNAUTHORIZED}: the ACP subsystem is not assembled in this process`)
    if (!bridge.lookup(token)) throw new HostMcpUnauthorizedError()
    return { bridge, token }
  }

  return {
    async listTools(_input: Record<string, never>, context?: RpcDispatchContext): Promise<HostMcpListToolsResponse> {
      const { bridge, token } = admit(context)
      return { tools: await bridge.listTools(token) }
    },

    async callTool(input: HostMcpCallToolRequest, context?: RpcDispatchContext): Promise<HostMcpCallToolResponse> {
      const { bridge, token } = admit(context)
      const name = typeof input?.name === 'string' ? input.name : ''
      if (!name) throw new Error('host-mcp.callTool needs a tool name')
      const args = input?.args && typeof input.args === 'object' && !Array.isArray(input.args) ? input.args : {}
      return bridge.callTool(token, name, args)
    },
  }
}

export const hostMcpRpcHandlers = createHostMcpRpcHandlers()

/** 名册 `http-server/http-server-client-api-roster.ts` 里的一行:域 `host-mcp` 的契约与处理者。 */
export const HOST_MCP_CLIENT_API = defineClientApi({ id: 'rpc:host-mcp', router: hostMcpRouter, handlers: hostMcpRpcHandlers, serveBeforeIdentity: serveBridgeRequest })

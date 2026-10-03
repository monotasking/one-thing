/**
 * ACP A4-a:`host-mcp` 域处理者的门(`runtime/acp/acp-client-api-host-mcp.ts`)。
 *
 * 真 HTTP 面上的同一组断言在 `runtime/acp/__tests__/acp-client-api-host-mcp-face.test.ts`;这里只钉处理者自己那一道
 * 「再查一次」:context 里没有桥凭据(= 用户 token / IPC 进来的)→ 拒;凭据不在表里 → 拒;
 * 在表里 → 按凭据答。外加产品层字面量与 router 对齐。
 */
import { describe, expect, it } from 'vitest'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import { HOST_MCP_UNAUTHORIZED, hostMcpRouter } from '@shared/ipc/host-mcp.js'
import { HOST_MCP_RPC } from '@onething/backend/runtime/acp/mcp-bridge/server'
import { createHostMcpRpcHandlers } from '../acp-client-api-host-mcp.js'
import { HostMcpBridge } from '@onething/backend/runtime/acp/host-mcp-bridge'

const notes: unknown[] = []
const bridge = new HostMcpBridge({
  faceUrl: () => undefined,
  userMcpServers: () => [],
  resolveSurface: async () => undefined,
  notify: note => notes.push(note),
})
const handlers = createHostMcpRpcHandlers(() => bridge)
const USER_HTTP: RpcDispatchContext = { transport: 'http', ownerUid: 'local-user', workspaceId: 'default' }

describe('host-mcp domain', () => {
  it('the product-layer literals match the router', () => {
    expect(HOST_MCP_RPC.domain).toBe(hostMcpRouter.domain)
    expect(Object.keys(hostMcpRouter.channels).sort()).toEqual([HOST_MCP_RPC.callTool, HOST_MCP_RPC.listTools].sort())
  })

  it('refuses a user token (no bridge credential on the context), over HTTP and IPC alike', async () => {
    // 表里此刻有一枚活凭据:门拒用户 token 靠的是「context 里没有桥凭据」,不是「表是空的」。
    const live = bridge.mintCredential('codex', 's0')
    expect(bridge.lookup(live.token)).toBeDefined()
    await expect(handlers.listTools({}, USER_HTTP)).rejects.toThrow(HOST_MCP_UNAUTHORIZED)
    await expect(handlers.listTools({}, DESKTOP_RPC_CONTEXT)).rejects.toThrow(HOST_MCP_UNAUTHORIZED)
    await expect(handlers.callTool({ name: 'send_notification', args: { message: 'x' } }, USER_HTTP)).rejects.toThrow(HOST_MCP_UNAUTHORIZED)
    expect(notes).toHaveLength(0)
  })

  it('refuses a credential that was never minted or has been revoked', async () => {
    await expect(handlers.listTools({}, { ...USER_HTTP, bridgeCredential: 'forged' })).rejects.toThrow(HOST_MCP_UNAUTHORIZED)
    const { token } = bridge.mintCredential('codex', 's1')
    bridge.revoke(token)
    await expect(handlers.listTools({}, { transport: 'http', bridgeCredential: token })).rejects.toThrow(HOST_MCP_UNAUTHORIZED)
  })

  it('accepts a live bridge credential and answers for its session', async () => {
    const { token } = bridge.mintCredential('codex', 's2')
    const context: RpcDispatchContext = { transport: 'http', bridgeCredential: token }
    expect((await handlers.listTools({}, context)).tools.map(tool => tool.name)).toEqual(['send_notification'])
    const result = await handlers.callTool({ name: 'send_notification', args: { message: 'hello' } }, context)
    expect(result.isError).toBeUndefined()
    expect(notes).toEqual([expect.objectContaining({ sessionId: 's2', agentId: 'codex', message: 'hello' })])
    await expect(handlers.callTool({ name: '' } as never, context)).rejects.toThrow(/needs a tool name/)
  })

  it('refuses when no ACP subsystem is assembled', async () => {
    const orphan = createHostMcpRpcHandlers(() => undefined)
    await expect(orphan.listTools({}, { transport: 'http', bridgeCredential: 'x' })).rejects.toThrow(HOST_MCP_UNAUTHORIZED)
  })
})

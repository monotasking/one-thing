/**
 * 端到端:一台真 SDK 服务器在工具调用途中发 `elicitation/create`,onething 的客户端把它交给
 * 权限口(这里是替身),答案回到服务器、再回到工具结果。证的是 SDK 这一侧的接线:能力声明、
 * 处理函数、结果校验 —— `mcp-elicitation.test.ts` 证的是翻译本身。
 */
import { describe, expect, it, vi } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import { createOnethingMCPClient } from '../mcp-client.js'
import type { MCPInFlightToolCall } from '../kernel/mcp-kernel-client-runtime.js'

const inFlight: MCPInFlightToolCall = {
  toolName: 'ask',
  args: { app: 'Calculator' },
  caller: { sessionId: 's1', messageId: 'm1', callId: 'c1', workingDirectory: '/w' },
}

async function connectPair(ask: (input: unknown) => Promise<'once'>) {
  const server = new McpServer({ name: 'fake-computer-use', version: '0' })
  server.registerTool(
    'ask',
    {
      description: 'asks for consent, answers with the action',
      inputSchema: fromJsonSchema({ type: 'object', properties: { app: { type: 'string' } } }),
    },
    async (args, ctx) => {
      const result = await ctx.mcpReq.elicitInput({
        message: `Allow ChatGPT to use ${String((args as { app?: string }).app)}?`,
        requestedSchema: { type: 'object', properties: {} },
      })
      return { content: [{ type: 'text', text: result.action }] }
    },
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const askFn = vi.fn(ask)
  const client = createOnethingMCPClient({
    serverId: 'fake',
    serverName: 'Fake',
    onListChanged: () => {},
    inFlightCall: () => inFlight,
    elicitationPorts: { ask: askFn, matchGrant: () => undefined },
  })
  await client.connect(clientTransport)
  return { client, server, askFn }
}

describe('onething MCP client answers elicitation/create', () => {
  it('accepts when the permission card is answered once', async () => {
    const { client, server, askFn } = await connectPair(async () => 'once')
    try {
      const result = await client.callTool({ name: 'ask', arguments: { app: 'Calculator' } })
      expect(result.content).toEqual([{ type: 'text', text: 'accept' }])
      expect(askFn).toHaveBeenCalledTimes(1)
      expect(askFn.mock.calls[0][0]).toMatchObject({
        type: 'mcp_consent',
        title: 'Allow ChatGPT to use Calculator?',
        sessionId: 's1',
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('declines when the permission card is rejected', async () => {
    const { client, server } = await connectPair(async () => { throw new Error('rejected') })
    try {
      const result = await client.callTool({ name: 'ask', arguments: { app: 'Calculator' } })
      expect(result.content).toEqual([{ type: 'text', text: 'decline' }])
    } finally {
      await client.close()
      await server.close()
    }
  })
})

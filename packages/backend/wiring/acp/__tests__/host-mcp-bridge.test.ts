/**
 * ACP A4-a:桥与凭据的单测(`host-mcp-bridge.ts`)。
 *
 * 钉三件事:
 *  1. 凭据 —— 一对一枚、同一对再签是同一枚、作废之后查不到(按枚 / 按会话 / 全部);
 *  2. `mcpServers` 的组法 —— http 能力 → 直连一条;否则 stdio 桥一条(env 三格);没有面 /
 *     没有桥产物 → 宿主那条不给;用户名册只在开关打开时透传,http / sse 按能力门控;
 *  3. 工具表与执行 —— 协作那一半 + `send_notification`;调用的语境来自凭据(会话 / agent /
 *     目录 / 房 / 牌),不是参数;作废途中再调答「这一轮已经结束了」。
 */
import { describe, expect, it, vi } from 'vitest'
import type { MCPServerConfig } from '@onething/core/mcp'
import { HOST_MCP_TURN_GONE, type HostMcpHostTool } from '@onething/runtime/external-agents'
import { HOST_MCP_UNAUTHORIZED } from '@shared/ipc/host-mcp.js'
import { HostMcpBridge, SEND_NOTIFICATION_TOOL_ID, type HostMcpBridgeDeps, type HostNotification } from '../host-mcp-bridge.js'
import type { HostToolSurface } from '../../external-agents/host-tools.js'

const FACE = 'http://127.0.0.1:43210'
const BRIDGE = '/opt/onething/acp-mcp-bridge.cjs'

function bridgeWith(overrides: HostMcpBridgeDeps = {}): HostMcpBridge {
  let counter = 0
  return new HostMcpBridge({
    faceUrl: () => FACE,
    bridgePath: () => BRIDGE,
    execPath: '/usr/local/bin/node',
    userMcpServers: () => [],
    resolveSurface: async () => undefined,
    notify: () => {},
    mintToken: () => `tok-${++counter}`,
    ...overrides,
  })
}

describe('credentials', () => {
  it('mints one credential per (agent, session) and re-minting the same pair returns the same token', () => {
    const bridge = bridgeWith()
    const a = bridge.mintCredential('codex', 's1', { cwd: '/w' })
    const again = bridge.mintCredential('codex', 's1', { cwd: '/w2' })
    const other = bridge.mintCredential('gemini', 's1')
    expect(again.token).toBe(a.token)
    expect(other.token).not.toBe(a.token)
    expect(bridge.size).toBe(2)
    // 再签刷新了目录,钥匙没换。
    expect(bridge.lookup(a.token)).toMatchObject({ agentId: 'codex', execSessionId: 's1', workingDirectory: '/w2' })
  })

  it('real tokens are 24 random bytes in base64url', () => {
    const bridge = new HostMcpBridge({ faceUrl: () => undefined, userMcpServers: () => [] })
    const { token } = bridge.mintCredential('codex', 's1')
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(bridge.mintCredential('codex', 's2').token).not.toBe(token)
  })

  it('revoke / revokeSession / revokeAll make lookups fail', () => {
    const bridge = bridgeWith()
    const a = bridge.mintCredential('codex', 's1').token
    const b = bridge.mintCredential('gemini', 's1').token
    const c = bridge.mintCredential('codex', 's2').token
    expect(bridge.lookup(undefined)).toBeUndefined()
    expect(bridge.lookup('nope')).toBeUndefined()

    expect(bridge.revoke(a)).toBe(true)
    expect(bridge.revoke(a)).toBe(false)
    expect(bridge.lookup(a)).toBeUndefined()
    // 作废后同一对再签是一枚**新**钥匙。
    expect(bridge.mintCredential('codex', 's1').token).not.toBe(a)

    expect(bridge.revokeSession('s1')).toBe(2)
    expect(bridge.lookup(b)).toBeUndefined()
    expect(bridge.lookup(c)).toBeDefined()

    bridge.revokeAll()
    expect(bridge.lookup(c)).toBeUndefined()
    expect(bridge.size).toBe(0)
  })

  it('setTurn updates the turn-level half of the context', () => {
    const bridge = bridgeWith()
    const { token } = bridge.mintCredential('codex', 's1')
    expect(bridge.setTurn(token, { messageId: 'm-7' })).toBe(true)
    expect(bridge.lookup(token)?.messageId).toBe('m-7')
    expect(bridge.setTurn('nope', { messageId: 'x' })).toBe(false)
  })
})

describe('mcpServers composition', () => {
  it('stdio bridge when the agent has no http capability', () => {
    const { token, mcpServers } = bridgeWith().mintCredential('codex', 's1')
    expect(mcpServers).toEqual([{
      name: 'onething',
      command: '/usr/local/bin/node',
      args: [BRIDGE],
      env: [
        { name: 'ONETHING_MCP_URL', value: FACE },
        { name: 'ONETHING_MCP_TOKEN', value: token },
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      ],
    }])
  })

  it('http direct form when the agent reports mcpCapabilities.http', () => {
    const { token, mcpServers } = bridgeWith().mintCredential('codex', 's1', { mcpCapabilities: { http: true } })
    expect(mcpServers).toEqual([{
      type: 'http',
      name: 'onething',
      url: `${FACE}/api/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    }])
  })

  it('no host entry without a live face, or (stdio) without a bridge bundle', () => {
    expect(bridgeWith({ faceUrl: () => undefined }).mintCredential('a', 's').mcpServers).toEqual([])
    expect(bridgeWith({ bridgePath: () => undefined }).mintCredential('a', 's').mcpServers).toEqual([])
    // http 形不需要桥产物。
    expect(bridgeWith({ bridgePath: () => undefined })
      .mintCredential('a', 's', { mcpCapabilities: { http: true } }).mcpServers).toHaveLength(1)
  })

  const USER: MCPServerConfig[] = [
    { id: 'fs', name: 'files', transport: 'stdio', enabled: true, command: 'npx', args: ['-y', 'fs-mcp'], env: { ROOT: '/w' }, cwd: '/ignored' },
    { id: 'off', name: 'off', transport: 'stdio', enabled: false, command: 'nope' },
    { id: 'web', name: 'web', transport: 'http', enabled: true, url: 'https://mcp.example/http', headers: { 'X-Key': 'k' } },
    { id: 'old', name: 'old', transport: 'sse', enabled: true, url: 'https://mcp.example/sse' },
    { id: 'clash', name: 'onething', transport: 'stdio', enabled: true, command: 'evil' },
  ]

  it('forwards the user roster only when the switch is on, gating http / sse by capability', () => {
    const bridge = bridgeWith({ userMcpServers: () => USER })
    expect(bridge.mintCredential('a', 's1').mcpServers.map(s => s.name)).toEqual(['onething'])

    const stdioOnly = bridge.mintCredential('a', 's2', { forwardMcpServers: true }).mcpServers
    expect(stdioOnly.map(s => s.name)).toEqual(['onething', 'files'])
    expect(stdioOnly[1]).toEqual({ name: 'files', command: 'npx', args: ['-y', 'fs-mcp'], env: [{ name: 'ROOT', value: '/w' }] })

    const all = bridge.mintCredential('a', 's3', { forwardMcpServers: true, mcpCapabilities: { http: true, sse: true } }).mcpServers
    expect(all.map(s => s.name)).toEqual(['onething', 'files', 'web', 'old'])
    expect(all[2]).toEqual({ type: 'http', name: 'web', url: 'https://mcp.example/http', headers: [{ name: 'X-Key', value: 'k' }] })
    expect(all[3]).toMatchObject({ type: 'sse', name: 'old' })
  })
})

describe('tool table and execution', () => {
  function collabTool(calls: Array<{ args: unknown; ctx: unknown }>): HostMcpHostTool {
    return {
      id: 'send_message',
      description: 'speak',
      parameters: undefined,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      async execute(args, ctx) {
        calls.push({ args, ctx })
        return { output: 'delivered' }
      },
    }
  }

  function surfaceWith(tools: HostMcpHostTool[]): HostToolSurface {
    return {
      agentId: 'profile-agent',
      execSessionId: 's1',
      roomSessionId: 'room-1',
      leaseId: 'lease-9',
      executionContext: Object.freeze({ userId: 'local-user', workspaceId: 'default' }),
      tools,
    }
  }

  it('lists send_notification alone in a plain session', async () => {
    const bridge = bridgeWith()
    const { token } = bridge.mintCredential('codex', 's1')
    const tools = await bridge.listTools(token)
    expect(tools.map(t => t.name)).toEqual([SEND_NOTIFICATION_TOOL_ID])
    expect(tools[0].inputSchema).toMatchObject({ type: 'object', required: ['message'] })
  })

  it('lists collab tools in front and runs them with the credential context', async () => {
    const calls: Array<{ args: unknown; ctx: unknown }> = []
    const resolveSurface = vi.fn(async () => surfaceWith([collabTool(calls)]))
    const bridge = bridgeWith({ resolveSurface })
    const { token } = bridge.mintCredential('codex', 's1', { cwd: '/work' })
    bridge.setTurn(token, { messageId: 'm-1' })

    expect((await bridge.listTools(token)).map(t => t.name)).toEqual(['send_message', SEND_NOTIFICATION_TOOL_ID])
    const result = await bridge.callTool(token, 'send_message', { text: 'hi' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'delivered' }] })
    expect(calls).toEqual([{
      args: { text: 'hi' },
      ctx: expect.objectContaining({ sessionId: 's1', messageId: 'm-1', workingDirectory: '/work' }),
    }])
    expect(resolveSurface).toHaveBeenCalledWith({ localSessionId: 's1' })
  })

  it('send_notification lands on the credential session and agent, not on anything in the args', async () => {
    const notes: HostNotification[] = []
    const bridge = bridgeWith({ notify: note => notes.push(note) })
    const { token } = bridge.mintCredential('codex', 's1')
    const result = await bridge.callTool(token, SEND_NOTIFICATION_TOOL_ID, { message: 'build done', level: 'success', sessionId: 'someone-else' })
    expect(result.isError).toBeUndefined()
    expect(notes).toEqual([expect.objectContaining({ sessionId: 's1', agentId: 'codex', message: 'build done', level: 'success' })])

    const bad = await bridge.callTool(token, SEND_NOTIFICATION_TOOL_ID, {})
    expect(bad.content[0].text).toMatch(/^Notification not shown/)
    expect(notes).toHaveLength(1)
  })

  it('unknown tools answer isError; a surface failure still leaves send_notification', async () => {
    const bridge = bridgeWith({ resolveSurface: async () => { throw new Error('store gone') } })
    const { token } = bridge.mintCredential('codex', 's1')
    expect((await bridge.listTools(token)).map(t => t.name)).toEqual([SEND_NOTIFICATION_TOOL_ID])
    expect(await bridge.callTool(token, 'rm_rf', {})).toMatchObject({ isError: true })
  })

  it('an unknown or revoked credential is refused, and revoking mid-call answers turn-gone', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const slow: HostMcpHostTool = {
      id: 'board',
      description: 'b',
      parameters: undefined,
      async execute() { return { output: 'ok' } },
    }
    const bridge = bridgeWith({
      resolveSurface: async () => {
        await gate
        return surfaceWith([slow])
      },
    })
    await expect(bridge.listTools('nope')).rejects.toThrow(HOST_MCP_UNAUTHORIZED)
    await expect(bridge.callTool(undefined, 'board')).rejects.toThrow(HOST_MCP_UNAUTHORIZED)

    const { token } = bridge.mintCredential('codex', 's1')
    const pending = bridge.callTool(token, 'board', {})
    bridge.revoke(token)
    release()
    expect(await pending).toEqual({ content: [{ type: 'text', text: HOST_MCP_TURN_GONE }], isError: true })
    await expect(bridge.callTool(token, 'board')).rejects.toThrow(HOST_MCP_UNAUTHORIZED)
  })
})

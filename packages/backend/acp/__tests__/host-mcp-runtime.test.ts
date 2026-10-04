/**
 * ACP A4-b:宿主工具面的运行时接线(`acp-host-mcp-port.ts` + `HostMcpBridge` 的回合 / 作废面 +
 * `AcpSubsystem` 的三处作废)。
 *
 *  1. 端口:`serversFor` 按 agent 的两格开关签凭据、组名册(`hostTools: false` 不签、只剩透传);
 *     旧 id 认回现 id;`beginTurn` 把这一轮挂到钥匙背后,收场只摘自己那一轮。
 *  2. 作废:会话删了(`onSessionsDeleted`,含级联)、agent 从 connected 掉下来、dispose。
 *     「刚连上」不算掉下来 —— 连接器签完凭据才开会话,那一路会经过 disconnected → connected。
 *  3. 总线适配:`resource:event` 的 `session:<id>` / `deleted` → 被删的整串会话 id。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ACPAgentState, ACPSettings, AcpSessionState } from '@shared/contracts/acp'
import type { MCPServerConfig } from '@shared/mcp/types'
import { HostMcpBridge, type HostMcpBridgeDeps } from '../acp-host-mcp-bridge.js'
import { createAcpHostMcpPort, type AcpHostMcpAgentSwitches } from '../acp-host-mcp-port.js'
import { AcpSubsystem } from '../acp-subsystem.js'
import { onSessionsDeletedFromBus, type SessionDeletionBus } from '../acp-events.js'

const USER_SERVER: MCPServerConfig = {
  id: 'fs', name: 'fs', enabled: true, transport: 'stdio', command: 'mcp-fs', args: ['--root', '/'], env: {},
} as MCPServerConfig

function bridgeWith(overrides: HostMcpBridgeDeps = {}): HostMcpBridge {
  let counter = 0
  return new HostMcpBridge({
    faceUrl: () => 'http://127.0.0.1:43210',
    bridgePath: () => '/opt/onething/acp-mcp-bridge.cjs',
    execPath: '/usr/local/bin/node',
    userMcpServers: () => [USER_SERVER],
    resolveSurface: async () => undefined,
    notify: () => {},
    mintToken: () => `tok-${++counter}`,
    ...overrides,
  })
}

function portOver(bridge: HostMcpBridge, switches: Record<string, AcpHostMcpAgentSwitches> = {}, aliases: Record<string, string> = {}) {
  return createAcpHostMcpPort({
    bridge: () => bridge,
    canonicalAgentId: id => aliases[id] ?? id,
    agentSwitches: id => switches[id],
  })
}

describe('host MCP port', () => {
  it('signs a credential and hands back the stdio entry; the same pair keeps the same key across turns', async () => {
    const bridge = bridgeWith()
    const port = portOver(bridge)
    const first = await port.serversFor({ agentId: 'codex', localSessionId: 's1', cwd: '/w' })
    const again = await port.serversFor({ agentId: 'codex', localSessionId: 's1', cwd: '/w' })
    expect(first).toEqual([expect.objectContaining({ name: 'onething', command: '/usr/local/bin/node' })])
    expect(again).toEqual(first)
    expect(bridge.size).toBe(1)
    expect(bridge.lookup('tok-1')).toMatchObject({ agentId: 'codex', execSessionId: 's1', workingDirectory: '/w' })
  })

  it('http direct form when the handshake reports mcpCapabilities.http; forwards the roster only when switched on', async () => {
    const bridge = bridgeWith()
    const port = portOver(bridge, { gemini: { forwardMcpServers: true } })
    const servers = await port.serversFor({ agentId: 'gemini', localSessionId: 's1', cwd: '/w', mcpCapabilities: { http: true } })
    expect(servers).toEqual([
      expect.objectContaining({ type: 'http', name: 'onething', url: 'http://127.0.0.1:43210/api/mcp' }),
      expect.objectContaining({ name: 'fs', command: 'mcp-fs' }),
    ])
    const plain = await port.serversFor({ agentId: 'codex', localSessionId: 's1', cwd: '/w' })
    expect(plain.map(server => server.name)).toEqual(['onething'])
  })

  it('hostTools: false → no credential, no onething entry, only the forwarded roster', async () => {
    const bridge = bridgeWith()
    const port = portOver(bridge, { pi: { hostTools: false, forwardMcpServers: true }, quiet: { hostTools: false } })
    expect(await port.serversFor({ agentId: 'pi', localSessionId: 's1', cwd: '/w' })).toEqual([expect.objectContaining({ name: 'fs' })])
    expect(await port.serversFor({ agentId: 'quiet', localSessionId: 's1', cwd: '/w' })).toEqual([])
    expect(bridge.size).toBe(0)
  })

  it('no live bridge (not assembled) → empty list, beginTurn is a no-op', async () => {
    const port = createAcpHostMcpPort({ bridge: () => undefined, canonicalAgentId: id => id, agentSwitches: () => undefined })
    expect(await port.serversFor({ agentId: 'codex', localSessionId: 's1', cwd: '/w' })).toEqual([])
    expect(() => port.beginTurn!('codex', 's1', { messageId: 'm' })()).not.toThrow()
  })

  it('old agent ids are signed under the canonical id, so revokeAgent(currentId) reaches them', async () => {
    const bridge = bridgeWith()
    const port = portOver(bridge, {}, { 'codex-cli': 'codex' })
    await port.serversFor({ agentId: 'codex-cli', localSessionId: 's1', cwd: '/w' })
    expect(bridge.lookup('tok-1')?.agentId).toBe('codex')
    expect(bridge.revokeAgent('codex')).toBe(1)
  })

  it('beginTurn hangs the turn on the key and the returned function takes only its own turn off', async () => {
    const bridge = bridgeWith()
    const port = portOver(bridge)
    await port.serversFor({ agentId: 'codex', localSessionId: 's1', cwd: '/w' })
    const abort = new AbortController()
    const end1 = port.beginTurn!('codex', 's1', { messageId: 'm1', abortSignal: abort.signal })
    expect(bridge.lookup('tok-1')).toMatchObject({ messageId: 'm1', abortSignal: abort.signal })
    end1()
    expect(bridge.lookup('tok-1')?.messageId).toBeUndefined()
    expect(bridge.lookup('tok-1')?.abortSignal).toBeUndefined()

    // 中止之后立刻重发:上一轮迟到的收场不摘下一轮。
    const staleEnd = port.beginTurn!('codex', 's1', { messageId: 'm2' })
    port.beginTurn!('codex', 's1', { messageId: 'm3' })
    staleEnd()
    expect(bridge.lookup('tok-1')?.messageId).toBe('m3')
    // 没签过的那一对:什么都不做。
    expect(() => port.beginTurn!('codex', 'unknown', { messageId: 'x' })()).not.toThrow()
  })
})

// ── 子系统的三处作废 ─────────────────────────────────────────────────────────

function agentState(id: string, status: ACPAgentState['status']): ACPAgentState {
  return { config: { id, name: id, enabled: true, command: 'x' }, status, sessionCount: 0, activePromptCount: 0 } as ACPAgentState
}

function fakeManager() {
  const agentListeners = new Set<(state: ACPAgentState) => void>()
  return {
    initialize: vi.fn(),
    updateSettings: vi.fn(),
    shutdown: vi.fn(async () => {}),
    onSessionStateChanged: (_listener: (state: AcpSessionState) => void) => () => {},
    onAgentStateChanged: (listener: (state: ACPAgentState) => void) => {
      agentListeners.add(listener)
      return () => agentListeners.delete(listener)
    },
    push: (state: ACPAgentState) => { for (const listener of agentListeners) listener(state) },
    listenerCount: () => agentListeners.size,
  }
}

describe('AcpSubsystem revokes bridge credentials', () => {
  const SETTINGS: ACPSettings = { enabled: true, agents: [] }

  it('when a session is deleted (the deleted one and every cascaded child)', async () => {
    const bridge = bridgeWith()
    let deleted: ((ids: string[]) => void) | undefined
    const unsubscribe = vi.fn()
    const acp = new AcpSubsystem({
      manager: fakeManager(),
      settings: () => SETTINGS,
      hostMcpBridge: bridge,
      onSessionsDeleted: listener => { deleted = listener; return unsubscribe },
    })
    const kept = bridge.mintCredential('codex', 'keep').token
    const parent = bridge.mintCredential('codex', 'parent').token
    const child = bridge.mintCredential('gemini', 'child').token
    deleted!(['parent', 'child'])
    expect(bridge.lookup(parent)).toBeUndefined()
    expect(bridge.lookup(child)).toBeUndefined()
    expect(bridge.lookup(kept)).toBeDefined()
    await acp.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(bridge.size).toBe(0)
  })

  it('when the agent falls out of connected — but not on the way up to connected', async () => {
    const bridge = bridgeWith()
    const manager = fakeManager()
    const acp = new AcpSubsystem({ manager, settings: () => SETTINGS, hostMcpBridge: bridge })

    // 连接器签完凭据才开会话:disconnected → connecting → connected 这一路不许作废刚签的钥匙。
    const token = bridge.mintCredential('codex', 's1').token
    const other = bridge.mintCredential('gemini', 's1').token
    manager.push(agentState('codex', 'disconnected'))
    manager.push(agentState('codex', 'connecting'))
    manager.push(agentState('codex', 'connected'))
    expect(bridge.lookup(token)).toBeDefined()

    // 进程崩了:connected → error。
    manager.push(agentState('codex', 'error'))
    expect(bridge.lookup(token)).toBeUndefined()
    expect(bridge.lookup(other)).toBeDefined()

    // 闲置回收 / 刷新:connected → disconnected 同样作废。
    manager.push(agentState('gemini', 'connected'))
    manager.push(agentState('gemini', 'disconnected'))
    expect(bridge.lookup(other)).toBeUndefined()

    await acp.dispose()
    // 两条监听(状态广播 + 凭据作废)都退掉了。
    expect(manager.listenerCount()).toBe(0)
  })

  it('on dispose: every credential, and late deletions after dispose do not throw', async () => {
    const bridge = bridgeWith()
    let deleted: ((ids: string[]) => void) | undefined
    const acp = new AcpSubsystem({
      manager: fakeManager(),
      settings: () => SETTINGS,
      hostMcpBridge: bridge,
      onSessionsDeleted: listener => { deleted = listener; return () => {} },
    })
    bridge.mintCredential('codex', 's1')
    bridge.mintCredential('codex', 's2')
    await acp.dispose()
    expect(bridge.size).toBe(0)
    expect(() => deleted!(['s1'])).not.toThrow()
  })
})

describe('onSessionsDeletedFromBus', () => {
  function fakeBus() {
    const handlers = new Set<(envelope: { event: { ref: string; event: string; payload: unknown } }) => void>()
    const bus: SessionDeletionBus = {
      onGlobal: (_type, handler) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    }
    const emit = (ref: string, event: string, payload: unknown) => { for (const handler of handlers) handler({ event: { ref, event, payload } }) }
    return { bus, emit, size: () => handlers.size }
  }

  it('turns a session resource deletion into the deleted id plus the cascaded ones; ignores the rest', () => {
    const { bus, emit, size } = fakeBus()
    const seen: string[][] = []
    const stop = onSessionsDeletedFromBus(bus)(ids => seen.push(ids))
    emit('session:parent', 'deleted', { cascadedSessionIds: ['parent', 'child-1', 'child-2'] })
    emit('session:solo', 'deleted', { cascadedSessionIds: [] })
    emit('session:x', 'renamed', {})
    emit('dir:/tmp/a', 'deleted', { path: '/tmp/a' })
    expect(seen).toEqual([['parent', 'child-1', 'child-2'], ['solo']])
    stop()
    expect(size()).toBe(0)
  })
})

/**
 * ACP 登录桥(A3-c,方案 §3.5 / §3.9 ②):终端型在 `TerminalService` 里起「agent 起法 + 方法 args」,
 * 立刻答 terminalId,退出码 0 才清「要登录」并断开;agent 型调 `authenticate`。管家与终端服务都是桩。
 */
import { describe, expect, it, vi } from 'vitest'
import type { TerminalCreateRequest } from '@shared/ipc.js'
import type { TerminalExitStatus } from '@onething/backend/runtime/terminal/service.wiring'

vi.mock('@onething/backend/runtime/external-agents/spawn-env', () => ({
  resolveExternalAgentSpawnEnv: () => ({ PATH: '/bin', HTTPS_PROXY: 'http://proxy:1' }),
}))

const { createAcpAuthBridge } = await import('../auth-bridge.js')

const CONFIG = { id: 'claude', name: 'Claude', enabled: true, command: 'npx', args: ['-y', 'claude-agent-acp'], env: { A: '1' } }
const HANDSHAKE = {
  protocolVersion: 1,
  authMethods: [
    { id: 'claude-ai-login', name: 'Claude.ai', type: 'terminal', args: ['--cli', 'auth', 'login'], env: { B: '2' } },
    { id: 'claude-login', name: 'In-band' },
  ],
}

function harness(options: { terminal?: boolean; handshake?: unknown } = {}) {
  const created: TerminalCreateRequest[] = []
  const exits = new Map<string, (status: TerminalExitStatus) => void>()
  const manager = {
    getAgentState: vi.fn((agentId: string) => (agentId === 'claude' ? { config: CONFIG } : undefined)),
    getAgentHandshake: vi.fn(() => options.handshake as never),
    connectAgent: vi.fn(async () => { options.handshake = HANDSHAKE; return {} }),
    authenticateAgent: vi.fn(async () => ({})),
    markAgentAuthenticated: vi.fn(),
    disconnectAgent: vi.fn(async () => {}),
  }
  const bridge = createAcpAuthBridge({
    manager: manager as never,
    terminal: () => ({
      create(request: TerminalCreateRequest) {
        created.push(request)
        return { id: `t-${created.length}` } as never
      },
      onExit(id: string, listener: (status: TerminalExitStatus) => void) {
        exits.set(id, listener)
        return () => {}
      },
    }),
    terminalAvailable: () => options.terminal ?? true,
  })
  return { bridge, manager, created, exit: (id: string, status: TerminalExitStatus) => exits.get(id)?.(status) }
}

describe('createAcpAuthBridge', () => {
  it('终端型:没握过手先连;起「起法 + 方法 args」,env 三层叠,立刻答 terminalId', async () => {
    const { bridge, manager, created } = harness()
    expect(await bridge.authenticate('claude', 'claude-ai-login')).toEqual({ ok: true, terminalId: 't-1' })
    expect(manager.connectAgent).toHaveBeenCalledWith('claude')
    expect(created[0]).toMatchObject({
      command: 'npx',
      args: ['-y', 'claude-agent-acp', '--cli', 'auth', 'login'],
      owner: { kind: 'acp', agentId: 'claude' },
      env: { PATH: '/bin', HTTPS_PROXY: 'http://proxy:1', A: '1', B: '2' },
    })
    expect(manager.markAgentAuthenticated).not.toHaveBeenCalled()
  })

  it('终端型:退出码 0 → 清「要登录」并断开;非 0 → 都不动', async () => {
    const ok = harness({ handshake: HANDSHAKE })
    await ok.bridge.authenticate('claude', 'claude-ai-login')
    ok.exit('t-1', { exitCode: 0 })
    expect(ok.manager.markAgentAuthenticated).toHaveBeenCalledWith('claude')
    expect(ok.manager.disconnectAgent).toHaveBeenCalledWith('claude')

    const bad = harness({ handshake: HANDSHAKE })
    await bad.bridge.authenticate('claude', 'claude-ai-login')
    bad.exit('t-1', { exitCode: 1 })
    expect(bad.manager.markAgentAuthenticated).not.toHaveBeenCalled()
    expect(bad.manager.disconnectAgent).not.toHaveBeenCalled()
  })

  it('终端型但这台机器没有终端 → no-terminal,不起任何东西', async () => {
    const { bridge, created } = harness({ terminal: false, handshake: HANDSHAKE })
    expect(await bridge.authenticate('claude', 'claude-ai-login')).toMatchObject({ ok: false, code: 'no-terminal' })
    expect(created).toHaveLength(0)
    expect(bridge.terminalAvailable()).toBe(false)
  })

  it('agent 型 → 管家的 authenticateAgent;失败带原话', async () => {
    const { bridge, manager } = harness({ handshake: HANDSHAKE })
    expect(await bridge.authenticate('claude', 'claude-login')).toEqual({ ok: true })
    expect(manager.authenticateAgent).toHaveBeenCalledWith('claude', 'claude-login')
    manager.authenticateAgent.mockRejectedValueOnce(new Error('denied'))
    expect(await bridge.authenticate('claude', 'claude-login')).toEqual({ ok: false, code: 'failed', error: 'denied' })
  })

  it('名册里没有 / 没自报这种方法 → 结构化失败', async () => {
    const { bridge } = harness({ handshake: HANDSHAKE })
    expect(await bridge.authenticate('ghost', 'x')).toMatchObject({ ok: false, code: 'unknown-agent' })
    expect(await bridge.authenticate('claude', 'nope')).toMatchObject({ ok: false, code: 'unknown-method' })
  })
})

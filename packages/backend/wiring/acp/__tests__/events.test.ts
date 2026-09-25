/**
 * ACP 状态广播器(A0-2,§3.3):两条 manager 监听 → 两种全局事件;总线发送时才取、
 * 事件系统没起来就丢不抛;`AcpSubsystem` 构造时订上、`dispose()` 时退订。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ACPAgentState, ACPSettings, AcpSessionState } from '@onething/runtime/acp'

const bus = vi.hoisted(() => ({
  initialized: false,
  emitGlobal: vi.fn(),
}))

vi.mock('../../../events/index.js', () => ({
  isEventSystemInitialized: () => bus.initialized,
  getEventBus: () => {
    if (!bus.initialized) throw new Error('event system not assembled')
    return { emitGlobal: bus.emitGlobal }
  },
}))

const { installAcpStateBroadcaster } = await import('../events.js')
const { AcpSubsystem } = await import('../subsystem.js')

function fakeSource() {
  const session = new Set<(state: AcpSessionState) => void>()
  const agent = new Set<(state: ACPAgentState) => void>()
  return {
    session,
    agent,
    onSessionStateChanged: (listener: (state: AcpSessionState) => void) => {
      session.add(listener)
      return () => session.delete(listener)
    },
    onAgentStateChanged: (listener: (state: ACPAgentState) => void) => {
      agent.add(listener)
      return () => agent.delete(listener)
    },
  }
}

const SESSION_STATE: AcpSessionState = {
  localSessionId: 'local-1',
  agentId: 'fake',
  configOptions: [],
  commands: [{ name: 'review', description: 'Review' }],
  notices: [],
  process: { status: 'connected', pid: 1 },
}
const AGENT_STATE: ACPAgentState = {
  config: { id: 'fake', name: 'Fake', enabled: true, command: 'fake' },
  status: 'connected',
  sessionCount: 1,
  activePromptCount: 0,
}

beforeEach(() => {
  bus.initialized = false
  bus.emitGlobal.mockReset()
})

describe('installAcpStateBroadcaster', () => {
  it('把两条监听转成两种全局事件', () => {
    bus.initialized = true
    const source = fakeSource()
    installAcpStateBroadcaster(source)
    for (const listener of source.session) listener(SESSION_STATE)
    for (const listener of source.agent) listener(AGENT_STATE)
    expect(bus.emitGlobal.mock.calls).toEqual([
      [{ type: 'acp:session-state', state: SESSION_STATE }],
      [{ type: 'acp:agent-state', state: AGENT_STATE }],
    ])
  })

  it('事件系统还没起来:丢,不抛', () => {
    const source = fakeSource()
    installAcpStateBroadcaster(source)
    expect(() => {
      for (const listener of source.session) listener(SESSION_STATE)
    }).not.toThrow()
    expect(bus.emitGlobal).not.toHaveBeenCalled()
  })

  it('AcpSubsystem 构造时订上,dispose 时两条一起退订', async () => {
    const source = fakeSource()
    const settings: ACPSettings = { enabled: true, agents: [] }
    const subsystem = new AcpSubsystem({
      manager: { ...source, initialize: () => {}, updateSettings: () => {}, shutdown: async () => {} },
      settings: () => settings,
    })
    expect(source.session.size).toBe(1)
    expect(source.agent.size).toBe(1)
    await subsystem.dispose()
    expect(source.session.size).toBe(0)
    expect(source.agent.size).toBe(0)
  })
})

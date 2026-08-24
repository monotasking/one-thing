/**
 * acp 域,端到端穿过 dispatcher(结构债 P4c 第六批)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/acp.ts` 工厂的八条用例、
 * `@main/ipc/acp.ts` 的壳适配,以及 server 的八条 REST 路由 + `acp` facade adapter
 * 背后那台 `ServerSafeACPManager`。
 *
 * 只桩**管家**(`@onething/runtime/acp` 的 `ACPManager` 单例)与设置缓存,
 * **投影不桩** —— `*OnethingACP*ForIpc` 是真跑的,所以这组用例证的是「域把端口
 * 接对了」,而不是「域自己又实现了一遍」。
 *
 * 值得钉的四件:
 *  - 八条方法都在 router 的白名单上,未列的方法直接被 dispatcher 挡掉;
 *  - 写面(add / update / remove)落回设置缓存,并且**同一趟**把新设置喂给管家
 *    (`updateSettings`)—— 漏掉这一步就会出现「设置里有、管家不知道」的分裂;
 *  - 读面(getAgents / connect / refresh)在动作前先 `updateSettings`,与旧的
 *    `@main` 适配逐字同义;
 *  - 管家抛错时回的是 `{ success: false, error }` 而不是让 dispatcher 兜底 ——
 *    「agent 不存在」这类错误在两个宿主上是**同一句**(`ACP agent "<id>" not found`),
 *    所以本域没有按 transport 分叉的护栏。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { acpRouter } from '@shared/ipc/acp.js'

const manager = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  getAgentStates: vi.fn(() => [] as unknown[]),
  connectAgent: vi.fn(async (_agentId: string) => ({}) as unknown),
  disconnectAgent: vi.fn(async (_agentId: string) => {}),
  refreshAgent: vi.fn(async (_agentId: string) => ({}) as unknown),
  cancelSession: vi.fn(async (_sessionId: string, _agentId?: string) => {}),
}))

const settings = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({}) as Record<string, unknown>),
  saveSettings: vi.fn(),
}))

vi.mock('@onething/runtime/acp', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@onething/runtime/acp')
  return { ...actual, ACPManager: manager }
})
vi.mock('../../stores/settings.js', () => settings)

const AGENT = {
  id: 'agent-1',
  name: 'Demo',
  enabled: true,
  command: 'demo-agent',
}

async function loadDomain() {
  const [{ dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests }, { acpRpcHandlers }] =
    await Promise.all([import('../registry.js'), import('../domains/acp.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers }
}

describe('acp RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(() => {
    for (const fn of Object.values(manager)) fn.mockReset()
    manager.getAgentStates.mockReturnValue([])
    manager.connectAgent.mockResolvedValue({ config: AGENT, status: 'connected' })
    manager.refreshAgent.mockResolvedValue({ config: AGENT, status: 'connected' })
    manager.disconnectAgent.mockResolvedValue(undefined)
    manager.cancelSession.mockResolvedValue(undefined)
    settings.getSettings.mockReset().mockReturnValue({
      acp: { enabled: true, agents: [AGENT] },
    })
    settings.saveSettings.mockReset()
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    vi.resetModules()
  })

  it('exposes exactly the eight acp methods and refuses anything else', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)

    const unknown = await dispatchRpc({ domain: 'acp', method: 'streamPrompt', payload: {} })
    expect(unknown.ok).toBe(false)
    expect(unknown.ok === false && unknown.error?.code).toBe('UNKNOWN_METHOD')

    for (const method of [
      'getAgents',
      'addAgent',
      'updateAgent',
      'removeAgent',
      'connectAgent',
      'disconnectAgent',
      'refreshAgent',
      'cancelSession',
    ]) {
      const response = await dispatchRpc({
        domain: 'acp',
        method,
        payload: { agentId: AGENT.id, sessionId: 's1', config: AGENT },
      })
      expect(response.ok, method).toBe(true)
    }
  })

  it('projects the agent list off the live manager', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)
    manager.getAgentStates.mockReturnValue([{ config: AGENT, status: 'disconnected' }])

    const response = await dispatchRpc({ domain: 'acp', method: 'getAgents', payload: {} })
    expect(response.ok).toBe(true)
    expect(response.ok && response.data).toEqual({
      success: true,
      agents: [{ config: AGENT, status: 'disconnected' }],
    })
    // 读之前先把设置喂给管家 —— 与旧的 @main 适配逐字同义。
    expect(manager.updateSettings).toHaveBeenCalledWith({ enabled: true, agents: [AGENT] })
  })

  it('persists a new agent and hands the same settings to the manager', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)
    settings.getSettings.mockReturnValue({ acp: { enabled: true, agents: [] } })

    const response = await dispatchRpc({
      domain: 'acp',
      method: 'addAgent',
      payload: { config: { ...AGENT, id: '' } },
    })
    expect(response.ok).toBe(true)
    expect(settings.saveSettings).toHaveBeenCalledTimes(1)
    const saved = settings.saveSettings.mock.calls[0][0] as {
      acp: { agents: Array<{ id: string; command: string }> }
    }
    expect(saved.acp.agents).toHaveLength(1)
    expect(saved.acp.agents[0].command).toBe('demo-agent')
    // 落盘与喂管家是同一趟,否则设置里有、管家不知道。
    expect(manager.updateSettings).toHaveBeenCalledWith(saved.acp)
  })

  it('removes an agent through the settings cache', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)

    const response = await dispatchRpc({
      domain: 'acp',
      method: 'removeAgent',
      payload: { agentId: AGENT.id },
    })
    expect(response.ok).toBe(true)
    expect(response.ok && response.data).toEqual({ success: true })
    const saved = settings.saveSettings.mock.calls[0][0] as {
      acp: { agents: unknown[] }
    }
    expect(saved.acp.agents).toEqual([])
  })

  it('connects / disconnects / cancels through the real manager', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)

    const connected = await dispatchRpc({
      domain: 'acp',
      method: 'connectAgent',
      payload: { agentId: AGENT.id },
    })
    expect(connected.ok && connected.data).toEqual({
      success: true,
      agent: { config: AGENT, status: 'connected' },
    })
    expect(manager.connectAgent).toHaveBeenCalledWith(AGENT.id)

    await dispatchRpc({ domain: 'acp', method: 'disconnectAgent', payload: { agentId: AGENT.id } })
    expect(manager.disconnectAgent).toHaveBeenCalledWith(AGENT.id)

    await dispatchRpc({
      domain: 'acp',
      method: 'cancelSession',
      payload: { sessionId: 'session-1', agentId: AGENT.id },
    })
    expect(manager.cancelSession).toHaveBeenCalledWith('session-1', AGENT.id)
  })

  it('reports a manager failure as a structured error, not a thrown dispatch', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)
    manager.connectAgent.mockRejectedValue(new Error('ACP agent "ghost" not found'))

    const response = await dispatchRpc({
      domain: 'acp',
      method: 'connectAgent',
      payload: { agentId: 'ghost' },
    })
    expect(response.ok).toBe(true)
    expect(response.ok && response.data).toEqual({
      success: false,
      error: 'ACP agent "ghost" not found',
    })
  })
})

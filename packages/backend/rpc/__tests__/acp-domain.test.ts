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
  getSessionOptions: vi.fn(async () => ({ options: [] as unknown[], live: false })),
  setSessionOption: vi.fn(async () => ({ options: [] as unknown[], live: false })),
  getSessionState: vi.fn((_sessionId: string, _agentId?: string) => undefined as unknown),
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

/** 活实例的 `acp` 子系统(A1-a 名册)。缺省 null = 不装 backend 的单测,域退回整只管家。 */
const backendRef = vi.hoisted(() => ({ acp: null as null | Record<string, ReturnType<typeof vi.fn>> }))
vi.mock('../../current.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../current.js')>()
  return {
    ...actual,
    // 调度器会借实例的 `runTask` 记在途账;假实例原样执行。
    getCurrentBackendInstance: () => (backendRef.acp
      ? { acp: backendRef.acp, runTask: (_label: string, work: () => unknown) => work() }
      : null),
  }
})

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
    manager.getSessionOptions.mockResolvedValue({ options: [], live: false })
    manager.setSessionOption.mockResolvedValue({ options: [], live: false })
    manager.getSessionState.mockReturnValue(undefined)
    settings.getSettings.mockReset().mockReturnValue({
      acp: { enabled: true, agents: [AGENT] },
    })
    settings.saveSettings.mockReset()
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    backendRef.acp = null
    vi.resetModules()
  })

  it('exposes exactly the thirteen acp methods and refuses anything else', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)

    const unknown = await dispatchRpc({ domain: 'acp', method: 'streamPrompt', payload: {} })
    expect(unknown.ok).toBe(false)
    expect(unknown.ok === false && unknown.error?.code).toBe('UNKNOWN_METHOD')

    const expected = [
      'getAgents',
      'addAgent',
      'updateAgent',
      'removeAgent',
      'connectAgent',
      'disconnectAgent',
      'refreshAgent',
      'cancelSession',
      'sessionOptions',
      'setSessionOption',
      'sessionState',
      'detect',
      'refreshRegistry',
    ]
    expect(expected).toHaveLength(13)
    expect([...acpRouter.methods].sort()).toEqual([...expected].sort())
    for (const method of expected) {
      const response = await dispatchRpc({
        domain: 'acp',
        method,
        payload: { agentId: AGENT.id, sessionId: 's1', config: AGENT },
      })
      expect(response.ok, method).toBe(true)
    }
  })

  it('reads a session state snapshot off the manager, null when there is none', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)

    const empty = await dispatchRpc({ domain: 'acp', method: 'sessionState', payload: { sessionId: 's1' } })
    expect(empty.ok && empty.data).toBe(null)

    const state = {
      localSessionId: 's1',
      agentId: AGENT.id,
      acpSessionId: 'acp-1',
      configOptions: [],
      commands: [{ name: 'plan', description: 'Plan it' }],
      notices: [],
      process: { status: 'connected' },
    }
    manager.getSessionState.mockReturnValue(state)
    const found = await dispatchRpc({ domain: 'acp', method: 'sessionState', payload: { sessionId: 's1', agentId: AGENT.id } })
    expect(found.ok && found.data).toEqual(state)
    expect(manager.getSessionState).toHaveBeenLastCalledWith('s1', AGENT.id)
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

  describe('有活实例时走名册(A1-a)', () => {
    const SEED_ROW = {
      config: { id: 'gemini', name: 'Gemini CLI', enabled: true, command: 'gemini', args: ['--acp'] },
      status: 'disconnected',
      sessionCount: 0,
      activePromptCount: 0,
      manifest: { id: 'gemini', name: 'Gemini CLI', launch: { command: 'gemini', args: ['--acp'] } },
      source: 'builtin',
      detect: { installed: true, version: '0.61.0', checkedAt: 1 },
    }

    function installBackend() {
      backendRef.acp = {
        applySettings: vi.fn(async () => {}),
        agentStates: vi.fn(() => [SEED_ROW]),
        agentState: vi.fn((id: string) => (id === 'gemini' ? SEED_ROW : undefined)),
        detect: vi.fn(async () => [SEED_ROW]),
        refreshRegistry: vi.fn(async () => [SEED_ROW]),
        roster: vi.fn(() => [{
          manifest: SEED_ROW.manifest,
          source: 'builtin',
          effective: SEED_ROW.config,
        }]),
      }
      return backendRef.acp
    }

    it('getAgents 的行来自子系统:带 manifest / source / detect,管家不再直接吃设置', async () => {
      const acp = installBackend()
      const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
      resetRpcRegistryForTests()
      dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)

      const response = await dispatchRpc({ domain: 'acp', method: 'getAgents', payload: {} })
      expect(response.ok && response.data).toEqual({ success: true, agents: [SEED_ROW] })
      expect(acp.applySettings).toHaveBeenCalledWith({ enabled: true, agents: [AGENT] })
      expect(manager.updateSettings).not.toHaveBeenCalled()
    })

    it('detect({ agentId }) 与 refreshRegistry() 转给子系统,答整张名册', async () => {
      const acp = installBackend()
      const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
      resetRpcRegistryForTests()
      dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)

      const detected = await dispatchRpc({ domain: 'acp', method: 'detect', payload: { agentId: 'gemini' } })
      expect(detected.ok && detected.data).toEqual({ success: true, agents: [SEED_ROW] })
      expect(acp.detect).toHaveBeenCalledWith('gemini')

      await dispatchRpc({ domain: 'acp', method: 'detect', payload: {} })
      expect(acp.detect).toHaveBeenLastCalledWith(undefined)

      const refreshed = await dispatchRpc({ domain: 'acp', method: 'refreshRegistry', payload: {} })
      expect(refreshed.ok && refreshed.data).toEqual({ success: true, agents: [SEED_ROW] })
      expect(acp.refreshRegistry).toHaveBeenCalledTimes(1)

      acp.refreshRegistry.mockRejectedValueOnce(new Error('offline'))
      const failed = await dispatchRpc({ domain: 'acp', method: 'refreshRegistry', payload: {} })
      expect(failed.ok && failed.data).toEqual({ success: false, error: 'offline' })
    })

    it('updateAgent 改一台种子 agent:设置里没有它,新建一条覆盖', async () => {
      installBackend()
      const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
      resetRpcRegistryForTests()
      dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)

      const response = await dispatchRpc({
        domain: 'acp',
        method: 'updateAgent',
        payload: { config: { id: 'gemini', name: 'Gemini CLI', enabled: false, command: 'gemini', args: ['--experimental-acp'] } },
      })
      expect(response.ok && response.data).toMatchObject({ success: true })
      const saved = settings.saveSettings.mock.calls[0][0] as { acp: { agents: Array<Record<string, unknown>> } }
      expect(saved.acp.agents.map(agent => agent.id)).toEqual([AGENT.id, 'gemini'])
      // 稀疏:与 manifest 相等的名字 / 命令没存,只留改了的参数与显式给的 enabled。
      expect(saved.acp.agents[1]).toEqual({ id: 'gemini', enabled: false, args: ['--experimental-acp'] })
    })

    it('addAgent 收 basedOn:没写命令就从那一台补;同 id 撞名册拒;非法 secretEnv 拒', async () => {
      installBackend()
      settings.getSettings.mockReturnValue({ acp: { enabled: true, agents: [] } })
      const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
      resetRpcRegistryForTests()
      dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)

      const copied = await dispatchRpc({
        domain: 'acp',
        method: 'addAgent',
        payload: { config: { id: 'gemini-work', name: 'Gemini·工作', enabled: true, command: '', basedOn: 'gemini', secretEnv: ['GEMINI_API_KEY'] } },
      })
      expect(copied.ok && copied.data).toMatchObject({ success: true })
      const saved = settings.saveSettings.mock.calls[0][0] as { acp: { agents: Array<Record<string, unknown>> } }
      expect(saved.acp.agents[0]).toMatchObject({
        id: 'gemini-work',
        basedOn: 'gemini',
        command: 'gemini',
        args: ['--acp'],
        secretEnv: ['GEMINI_API_KEY'],
      })

      // 名册里那一台还没有覆盖:addAgent 存一条稀疏覆盖(只留与 manifest 不同的格)。
      const seedOverride = await dispatchRpc({ domain: 'acp', method: 'addAgent', payload: { config: { ...AGENT, id: 'gemini' } } })
      expect(seedOverride.ok && seedOverride.data).toMatchObject({ success: true })
      const savedSeed = settings.saveSettings.mock.calls[1][0] as { acp: { agents: Array<Record<string, unknown>> } }
      expect(savedSeed.acp.agents.at(-1)).toEqual({ id: 'gemini', name: 'Demo', enabled: true, command: 'demo-agent' })

      const badSecret = await dispatchRpc({
        domain: 'acp',
        method: 'addAgent',
        payload: { config: { ...AGENT, id: 'x', secretEnv: ['not ok'] } },
      })
      expect(badSecret.ok && badSecret.data).toMatchObject({ success: false })

      const missingBase = await dispatchRpc({
        domain: 'acp',
        method: 'addAgent',
        payload: { config: { id: 'y', name: 'Y', enabled: true, command: '', basedOn: 'ghost' } },
      })
      expect(missingBase.ok && missingBase.data).toEqual({ success: false, error: 'ACP agent "ghost" not found' })
    })
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
// Adapter fixtures explicitly belong to the local operator on both transports.
vi.mock('../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({ findMeta: () => ({}) }) }
})

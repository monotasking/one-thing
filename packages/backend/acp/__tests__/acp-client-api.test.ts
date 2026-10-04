/**
 * acp 域,端到端穿过 dispatcher(结构债 P4c 第六批)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/acp.ts` 工厂的八条用例、
 * `@main/ipc/acp.ts` 的壳适配,以及 server 的八条 REST 路由 + `acp` facade adapter
 * 背后那台 `ServerSafeACPManager`。
 *
 * 只桩**管家**(`@onething/backend/acp` 的 `ACPManager` 单例)与设置缓存,
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
  setSessionMode: vi.fn(async (_sessionId: string, _cwd: string | undefined, _modeId: string, _agentId?: string) => undefined as unknown),
  getAuthBridge: vi.fn(() => undefined as unknown),
  reconnectAgent: vi.fn(async (_agentId: string) => ({}) as unknown),
  listRemoteSessions: vi.fn(async (_agentId: string, _cwd?: string) => [] as unknown[]),
  adoptRemoteSession: vi.fn(async () => ({}) as unknown),
  forkSession: vi.fn(async () => ({}) as unknown),
  linkedLocalSessions: vi.fn((_agentId: string, _acpSessionId: string) => [] as string[]),
  canonicalAgentId: vi.fn((agentId: string) => agentId),
}))

const settings = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({}) as Record<string, unknown>),
  saveSettings: vi.fn(),
}))

vi.mock('@onething/backend/acp', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@onething/backend/acp')
  return { ...actual, ACPManager: manager }
})
vi.mock('../../settings/settings-store.js', () => settings)

/** `rpc.acp` 那一只 logger 的 warn:选项失败那一行要带 agent 的原话与错误码。 */
const acpLogWarn = vi.hoisted(() => vi.fn())
vi.mock('@onething/backend/logging/logging-configure', async importOriginal => {
  const actual = await importOriginal<typeof import('@onething/backend/logging/logging-configure')>()
  return {
    ...actual,
    getLogger: (ns: string) => {
      const logger = actual.getLogger(ns)
      if (ns !== 'rpc.acp') return logger
      return new Proxy(logger, {
        get: (target, key, receiver) => (key === 'warn' ? acpLogWarn : Reflect.get(target, key, receiver)),
      })
    },
  }
})

/** 活实例的 `acp` 子系统(A1-a 名册)。缺省 null = 不装 backend 的单测,域退回整只管家。 */
const backendRef = vi.hoisted(() => ({ acp: null as null | Record<string, ReturnType<typeof vi.fn>> }))
vi.mock('../../backend-current.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../backend-current.js')>()
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
    await Promise.all([import('../../http-server/http-server-dispatch-table.js'), import('../acp-client-api.js')])
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
    manager.setSessionMode.mockResolvedValue(undefined)
    manager.getAuthBridge.mockReturnValue(undefined)
    manager.reconnectAgent.mockResolvedValue({ config: AGENT, status: 'connected' })
    manager.listRemoteSessions.mockResolvedValue([])
    manager.linkedLocalSessions.mockReturnValue([])
    manager.canonicalAgentId.mockImplementation((agentId: string) => agentId)
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

  it('exposes exactly the nineteen acp methods and refuses anything else', async () => {
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
      'setSessionMode',
      'detect',
      'refreshRegistry',
      'authenticate',
      'listRemoteSessions',
      'adoptSession',
      'forkSession',
      'reconnectAgent',
    ]
    expect(expected).toHaveLength(19)
    expect([...acpRouter.methods].sort()).toEqual([...expected].sort())
    for (const method of expected) {
      const response = await dispatchRpc({
        domain: 'acp',
        method,
        payload: { agentId: AGENT.id, sessionId: 's1', config: AGENT, methodId: 'm1', modeId: 'code' },
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

  it('switches the session mode through the manager and answers the folded state (A2-b)', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)
    const state = {
      localSessionId: 's1',
      agentId: AGENT.id,
      configOptions: [],
      commands: [],
      notices: [],
      modes: { current: 'code', available: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] },
      process: { status: 'connected' },
    }
    manager.setSessionMode.mockResolvedValue(state)
    const switched = await dispatchRpc({ domain: 'acp', method: 'setSessionMode', payload: { sessionId: 's1', modeId: 'code' } })
    expect(switched.ok && switched.data).toEqual({ success: true, state })
    expect(manager.setSessionMode).toHaveBeenLastCalledWith('s1', '/work/s1', 'code', undefined)

    manager.setSessionMode.mockRejectedValue(new Error('No ACP agent holds session "s1"'))
    const failed = await dispatchRpc({ domain: 'acp', method: 'setSessionMode', payload: { sessionId: 's1', modeId: 'code', agentId: AGENT.id } })
    expect(failed.ok && failed.data).toEqual({ success: false, error: 'No ACP agent holds session "s1"' })
    expect(manager.setSessionMode).toHaveBeenLastCalledWith('s1', '/work/s1', 'code', AGENT.id)

    const missing = await dispatchRpc({ domain: 'acp', method: 'setSessionMode', payload: { sessionId: 's1', modeId: '' } })
    expect(missing.ok && missing.data).toEqual({ success: false, error: 'modeId is required' })
  })

  it('option failures log and answer the ACP layer\'s detailed sentence, with the JSON-RPC code', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)
    acpLogWarn.mockClear()

    // ACP 层交出来的样子:话已拼好 agent 的原话,对端原来那只错误挂在 cause 上。
    const agentSide = Object.assign(new Error('Internal error'), { code: -32603, data: 'The Claude Agent session has ended. Please start a new session.' })
    const detailed = new Error('Internal error: The Claude Agent session has ended. Please start a new session.', {
      cause: { code: -32603, message: 'Internal error', data: agentSide.data },
    })
    manager.setSessionOption.mockRejectedValue(detailed)
    const failed = await dispatchRpc({
      domain: 'acp',
      method: 'setSessionOption',
      payload: { agentId: AGENT.id, sessionId: 's1', optionId: 'model', value: 'sonnet' },
    })
    expect(failed.ok && failed.data).toEqual({ success: false, options: [], live: false, error: detailed.message })
    expect(acpLogWarn).toHaveBeenLastCalledWith('acp session options failed', { error: detailed.message, code: -32603 })

    manager.getSessionOptions.mockRejectedValue(new Error('ACP connection is not available'))
    const read = await dispatchRpc({ domain: 'acp', method: 'sessionOptions', payload: { agentId: AGENT.id, sessionId: 's1' } })
    expect(read.ok && read.data).toEqual({ success: false, options: [], live: false, error: 'ACP connection is not available' })
    // 不是对端答的:没有错误码那一格。
    expect(acpLogWarn).toHaveBeenLastCalledWith('acp session options failed', { error: 'ACP connection is not available' })
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

  it('authenticate 交给登录桥;没挂桥答 unavailable(A3-c)', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)

    const none = await dispatchRpc({ domain: 'acp', method: 'authenticate', payload: { agentId: AGENT.id, methodId: 'login' } })
    expect(none.ok && none.data).toMatchObject({ ok: false, code: 'unavailable' })

    const authenticate = vi.fn(async () => ({ ok: true, terminalId: 't-1' }))
    manager.getAuthBridge.mockReturnValue({ terminalAvailable: () => true, authenticate })
    const started = await dispatchRpc({ domain: 'acp', method: 'authenticate', payload: { agentId: AGENT.id, methodId: 'login' } })
    expect(started.ok && started.data).toEqual({ ok: true, terminalId: 't-1' })
    expect(authenticate).toHaveBeenCalledWith(AGENT.id, 'login')
  })

  it('A5:listRemoteSessions 把「没自报能力」答成 unsupported;reconnectAgent 答 { ok, state }', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)

    manager.listRemoteSessions.mockResolvedValueOnce([{ acpSessionId: 'r1', cwd: '/w' }])
    manager.linkedLocalSessions.mockReturnValueOnce(['s1'])
    const listed = await dispatchRpc({ domain: 'acp', method: 'listRemoteSessions', payload: { agentId: AGENT.id } })
    expect(listed.ok && listed.data).toEqual({ ok: true, sessions: [{ acpSessionId: 'r1', cwd: '/w', adoptedSessionId: 's1' }] })

    manager.listRemoteSessions.mockRejectedValueOnce(Object.assign(new Error('no list'), { code: 'unsupported' }))
    const unsupported = await dispatchRpc({ domain: 'acp', method: 'listRemoteSessions', payload: { agentId: AGENT.id } })
    expect(unsupported.ok && unsupported.data).toEqual({ ok: false, code: 'unsupported', error: 'no list' })

    const reconnected = await dispatchRpc({ domain: 'acp', method: 'reconnectAgent', payload: { agentId: AGENT.id } })
    expect(manager.reconnectAgent).toHaveBeenCalledWith(AGENT.id)
    expect(reconnected.ok && reconnected.data).toEqual({ ok: true, state: { config: AGENT, status: 'connected' } })

    manager.reconnectAgent.mockRejectedValueOnce(new Error('ACP agent "ghost" not found'))
    const failed = await dispatchRpc({ domain: 'acp', method: 'reconnectAgent', payload: { agentId: 'ghost' } })
    expect(failed.ok && failed.data).toEqual({ ok: false, error: 'ACP agent "ghost" not found' })
  })

  it('A5:认领已认领过的会话直接答那一条,不再 load', async () => {
    const { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, acpRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(acpRouter, acpRpcHandlers)
    manager.linkedLocalSessions.mockReturnValue(['s1'])
    const adopted = await dispatchRpc({
      domain: 'acp',
      method: 'adoptSession',
      payload: { agentId: AGENT.id, acpSessionId: 'r1', cwd: '/work/s1' },
    })
    expect(adopted.ok && adopted.data).toEqual({ ok: true, sessionId: 's1', imported: 0, alreadyAdopted: true })
    expect(manager.adoptRemoteSession).not.toHaveBeenCalled()
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
// A5 的认领 / 分叉走会话入口交出的那组「以调用方身份」的步骤建本地会话;这组用例不验那条路(`acp/__tests__/
// session-lifecycle.test.ts` 与 gate:acp ⑳㉑ 验),给一只轻的替身。包根归位 B(2026-10-04)之前替身打在 `sessions` 域文件上
// (那时 ACP 动态 import 它),现在打在那组步骤住的文件上,答的仍是同样的四个结局。
vi.mock('../../session/session-caller-ops.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../session/session-caller-ops.js')>(),
  createPlainSessionAs: vi.fn(async () => ({ success: false, error: 'sessions domain stubbed' })),
  authorizeSessionCascadeDelete: vi.fn(),
  clampSessionWorkingDirectory: vi.fn((_context: unknown, workingDirectory: unknown) => ({ ok: true, workingDirectory })),
  runSessionOpAs: vi.fn(async () => ({ kind: 'ok', result: { content: [] } })),
}))
// Adapter fixtures explicitly belong to the local operator on both transports.
vi.mock('../../session/session-access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../session/session-access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({ findMeta: () => ({}) }) }
})
// `setSessionMode` 读会话的工作目录(开会话要 cwd);不装 backend 的单测给一张最小的会话表。
vi.mock('../../session/session-reads.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../session/session-reads.js')>()
  return {
    ...actual,
    sessionReads: { ...actual.sessionReads, getSession: (id: string) => (id === 's1' ? { id, workingDirectory: '/work/s1' } : undefined) },
  }
})

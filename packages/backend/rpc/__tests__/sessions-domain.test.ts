/**
 * sessions 域,端到端穿过 dispatcher(结构债 P4c 第五批)。
 *
 * 接的是被删掉的四处转发的测试位:`apps/electron/src/ipc/sessions.ts` 工厂
 * (连同 `__tests__/sessions.test.ts`)、`@main/ipc/sessions.ts` 的壳适配、bridge 上
 * 那 26 条包装,以及 server 的 REST 面 + sessions/messages/chat 三个 facade adapter
 * 里对应的方法。
 *
 * 只桩**仓本体**(`@onething/backend/store`)与四个装配侧端口,**投影不桩** ——
 * `@onething/runtime/sessions` 的那批 `*OnethingSession*` / `*ForIpc` 是真跑的,
 * 所以这组用例证的是「域把端口接对了」,而不是「域自己又实现了一遍」。
 *
 * 值得钉的三件:
 *  - 26 条方法都在 router 的白名单上,一条不多一条不少 —— 尤其是那四条从前
 *    **不在契约表里**的字面量通道(add-system-message / remove-files-changed-message /
 *    remove-git-status-message / remove-message)如今在名册上有名有姓;
 *  - `create` 的三条规矩(自带 id 的格式、不认领已存在的会话、kind 只认 'room')
 *    连同失败文案一字不差地落在运行时那本规矩书上 —— 抄错一个分支就是改行为;
 *  - `kind: 'room'` 走的是**建房那本规则书**(`ensureCollabGroupRoom`),不是普通建会话。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { sessionsRouter } from '@shared/ipc/sessions.js'

const store = vi.hoisted(() => ({
  getSessionsList: vi.fn(() => [] as unknown[]),
  getSessionDetails: vi.fn(),
  getSessionMessages: vi.fn(),
  getSessionMessagesPage: vi.fn(),
  getSessionUserMessageMarkers: vi.fn(),
  getSessionCacheStats: vi.fn(),
  invalidateSessionCache: vi.fn(),
  getSessionTokenUsage: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  createBranchSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  updateSessionPin: vi.fn(),
  updateSessionArchived: vi.fn(),
  updateSessionModel: vi.fn(),
  updateSessionAgent: vi.fn(),
  updateSessionPermissionMode: vi.fn(),
  addMessage: vi.fn(),
  deleteMessage: vi.fn(),
  setCurrentSessionId: vi.fn(),
}))

const collab = vi.hoisted(() => ({
  ensureCollabGroupRoom: vi.fn(),
  /** 协调器在不在场 —— `create` 的 http 分叉现在按它决定收不收 `kind`。 */
  isCollabV3RuntimeRunning: vi.fn(() => false),
}))
const todoPlan = vi.hoisted(() => ({
  deleteSessionAiTodo: vi.fn(async () => {}),
  notifyTodoPlanActiveSessionChanged: vi.fn(),
}))
const toc = vi.hoisted(() => ({ readSessionSegments: vi.fn(async () => []) }))
const variables = vi.hoisted(() => ({ workdirGateway: { write: vi.fn(async () => {}) } }))
const agents = vi.hoisted(() => ({
  DEFAULT_AGENT_ID: 'default-agent',
  agentExists: vi.fn(() => true),
}))

/** 三处 `http` 分支要碰的进程内设施(收尾那三件)。 */
const engine = vi.hoisted(() => ({
  getController: vi.fn(() => undefined as unknown),
  abort: vi.fn(),
}))
const events = vi.hoisted(() => ({
  destroySession: vi.fn(),
  streamDestroySession: vi.fn(),
}))
const permission = vi.hoisted(() => ({ clearSession: vi.fn() }))

/**
 * S2b:主读路径收口后,`getMessages` / `getMessagesPage` 从 `store.js` 改走
 * `session/reads.js` 的读门面 —— 门面在 `fromEvents()` 上取投影(批 6b 之后是
 * 唯一路)。为了逐字证「投影到得了这两条入口」,这里桩的是门面脚下的**两口井**
 * (events 投影 / 原始仓)而**不桩门面本体**:读门面真跑,只有井是假的。
 */
const storesSessions = vi.hoisted(() => ({
  getSessionMessages: vi.fn(),
  getSessionMessagesPage: vi.fn(),
}))
const eventsReads = vi.hoisted(() => ({
  eventsListMessages: vi.fn(),
  eventsPageMessages: vi.fn(),
}))

vi.mock('../../store.js', () => store)
vi.mock('../../stores/sessions.js', () => storesSessions)
vi.mock('../../session/events-reads.js', () => eventsReads)
vi.mock('../../wiring/collab/index.js', () => collab)
vi.mock('../../wiring/todo-plan/store.js', () => todoPlan)
vi.mock('../../wiring/toc/index.js', () => toc)
vi.mock('../../wiring/variables/gateways.js', () => variables)
vi.mock('../../wiring/agents/index.js', () => agents)
vi.mock('../../wiring/engine/index.js', () => ({ getStreamEngine: () => engine }))
vi.mock('../../wiring/permission/index.js', () => ({ Permission: permission }))
vi.mock('../../events/index.js', () => ({
  getEventBus: () => ({ destroySession: events.destroySession }),
  getStreamChannel: () => ({ destroySession: events.streamDestroySession }),
}))

/** 联网宿主的 dispatch context —— server 壳 mint 出来的那一只的形状。 */
const HTTP_CONTEXT = {
  transport: 'http' as const,
  ownerUid: 'alice',
  workspaceId: 'w1',
  sandboxRoot: '/tmp/onething-sandbox/alice/w1',
}

/** renderer 的草稿 id 形状 —— 合法 UUID v4。 */
const SESSION_ID = '0f1e2d3c-4b5a-4678-89ab-cdef01234567'

async function loadDomain() {
  const [{ dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests }, { sessionsRpcHandlers }] =
    await Promise.all([import('../registry.js'), import('../domains/sessions.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, sessionsRpcHandlers }
}

describe('sessions RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    for (const fn of Object.values(store)) fn.mockReset()
    store.getSessionsList.mockReturnValue([])
    store.getSession.mockReturnValue(undefined)
    collab.ensureCollabGroupRoom.mockReset()
    todoPlan.deleteSessionAiTodo.mockReset().mockResolvedValue(undefined)
    todoPlan.notifyTodoPlanActiveSessionChanged.mockReset()
    agents.agentExists.mockReset().mockReturnValue(true)
    engine.getController.mockReset().mockReturnValue(undefined)
    engine.abort.mockReset()
    events.destroySession.mockReset()
    events.streamDestroySession.mockReset()
    permission.clearSession.mockReset()
    variables.workdirGateway.write.mockReset().mockResolvedValue(undefined)

    const { resetRpcRegistryForTests, registerRouterHandlers, sessionsRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(sessionsRouter, sessionsRpcHandlers)
  })

  afterEach(async () => {
    dispose?.()
    dispose = undefined
    const { resetRpcRegistryForTests } = await loadDomain()
    resetRpcRegistryForTests()
    vi.restoreAllMocks()
  })

  it('exposes exactly the twenty-six methods — including the four ex-literal channels', async () => {
    const { sessionsRouter } = await import('@shared/ipc/sessions.js')
    expect([...sessionsRouter.methods]).toEqual([
      'list',
      'listMeta',
      'activate',
      'getMessages',
      'getMessagesPage',
      'getUserMarkers',
      'getSegments',
      'create',
      'switch',
      'get',
      'delete',
      'rename',
      'updatePin',
      'updateArchived',
      'updateWorkingDirectory',
      'updateModel',
      'updateAgent',
      'updatePermissionMode',
      'createBranch',
      'getCacheStats',
      'evictCache',
      'getTokenUsage',
      'addSystemMessage',
      'removeFilesChangedMessage',
      'removeGitStatusMessage',
      'removeMessage',
    ])
    expect(sessionsRouter.methods).toHaveLength(26)
    // 推送不在这里:router 没有推送面。
    for (const push of ['onMessagesChanged', 'onContextSizeUpdated', 'emit']) {
      expect(sessionsRouter.methods).not.toContain(push)
    }
  })

  it('lists sessions off the assembly-layer store (metadata, both aliases)', async () => {
    const { dispatchRpc } = await loadDomain()
    store.getSessionsList.mockReturnValue([{ id: SESSION_ID, name: 'One' }])

    await expect(
      dispatchRpc({ domain: 'sessions', method: 'listMeta', payload: {} }),
    ).resolves.toEqual({ ok: true, data: { success: true, sessions: [{ id: SESSION_ID, name: 'One' }] } })
    // `list` 是旧的 `sessions:get-all`,与 `listMeta` 同一条实现(零调用点,留作对账)。
    await expect(
      dispatchRpc({ domain: 'sessions', method: 'list', payload: {} }),
    ).resolves.toEqual({ ok: true, data: { success: true, sessions: [{ id: SESSION_ID, name: 'One' }] } })
    expect(store.getSessionsList).toHaveBeenCalledTimes(2)
  })

  it('keeps the three create-session rules — id shape, no adoption, kind is room-only', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(
      dispatchRpc({ domain: 'sessions', method: 'create', payload: { name: 'x', sessionId: 'not-a-uuid' } }),
    ).resolves.toEqual({ ok: true, data: { success: false, error: 'Invalid session id' } })

    store.getSession.mockReturnValue({ id: SESSION_ID, messages: [] })
    await expect(
      dispatchRpc({ domain: 'sessions', method: 'create', payload: { name: 'x', sessionId: SESSION_ID } }),
    ).resolves.toEqual({ ok: true, data: { success: false, error: 'Session id already exists' } })

    store.getSession.mockReturnValue(undefined)
    await expect(
      dispatchRpc({ domain: 'sessions', method: 'create', payload: { name: 'x', kind: 'work' } }),
    ).resolves.toEqual({ ok: true, data: { success: false, error: 'Invalid session kind' } })

    expect(store.createSession).not.toHaveBeenCalled()
    expect(collab.ensureCollabGroupRoom).not.toHaveBeenCalled()
  })

  it('drops an illegal workspaceId instead of failing the create (absent = default space)', async () => {
    const { dispatchRpc } = await loadDomain()
    store.createSession.mockReturnValue({ id: SESSION_ID, name: 'Named', messages: [] })

    await expect(dispatchRpc({
      domain: 'sessions',
      method: 'create',
      payload: { name: 'Named', sessionId: SESSION_ID, workspaceId: '../escape' },
    })).resolves.toEqual({
      ok: true,
      data: { success: true, session: { id: SESSION_ID, name: 'Named', messages: [] } },
    })
    expect(store.createSession).toHaveBeenCalledWith(SESSION_ID, 'Named', { workspaceId: undefined })
  })

  it("routes kind:'room' onto the one room rulebook, not the plain create path", async () => {
    const { dispatchRpc } = await loadDomain()
    collab.ensureCollabGroupRoom.mockReturnValue({ success: true, session: { id: SESSION_ID } })

    await expect(dispatchRpc({
      domain: 'sessions',
      method: 'create',
      payload: { name: '', sessionId: SESSION_ID, kind: 'room', room: { memberAgentIds: ['a1'] } },
    })).resolves.toEqual({ ok: true, data: { success: true, session: { id: SESSION_ID } } })

    expect(collab.ensureCollabGroupRoom).toHaveBeenCalledWith(
      'New Chat',
      { memberAgentIds: ['a1'] },
      { sessionId: SESSION_ID },
    )
    expect(store.createSession).not.toHaveBeenCalled()
  })

  it('activates through the store and wakes the detached todo window', async () => {
    const { dispatchRpc } = await loadDomain()
    store.getSessionDetails.mockReturnValue({ id: SESSION_ID, messageCount: 3 })

    await expect(
      dispatchRpc({ domain: 'sessions', method: 'activate', payload: { sessionId: SESSION_ID } }),
    ).resolves.toEqual({
      ok: true,
      data: { success: true, session: { id: SESSION_ID, messageCount: 3 }, messageCount: 3 },
    })
    expect(store.setCurrentSessionId).toHaveBeenCalledWith(SESSION_ID)
    expect(todoPlan.notifyTodoPlanActiveSessionChanged).toHaveBeenCalledTimes(1)
  })

  it('cascades the AI todo delete over every session the store删掉的 id', async () => {
    const { dispatchRpc } = await loadDomain()
    store.deleteSession.mockReturnValue({ deletedIds: [SESSION_ID, 'child-1'], deletedCount: 2 })

    await expect(
      dispatchRpc({ domain: 'sessions', method: 'delete', payload: { sessionId: SESSION_ID } }),
    ).resolves.toEqual({ ok: true, data: { success: true, deletedCount: 2 } })
    expect(todoPlan.deleteSessionAiTodo).toHaveBeenCalledWith(SESSION_ID)
    expect(todoPlan.deleteSessionAiTodo).toHaveBeenCalledWith('child-1')
  })

  it('carries the four ex-literal channels: add / remove-files-changed / remove-git-status / remove', async () => {
    const { dispatchRpc } = await loadDomain()
    const message = { id: 'system-1', role: 'system', content: '{"type":"files-changed"}', timestamp: 1 }
    store.getSession.mockReturnValue({ id: SESSION_ID, messages: [message] })

    // 旧通道:'add-system-message'
    await expect(dispatchRpc({
      domain: 'sessions',
      method: 'addSystemMessage',
      payload: { sessionId: SESSION_ID, message },
    })).resolves.toEqual({ ok: true, data: { success: true } })
    expect(store.addMessage).toHaveBeenCalledWith(SESSION_ID, message)

    // 旧通道:'remove-files-changed-message'
    await expect(dispatchRpc({
      domain: 'sessions',
      method: 'removeFilesChangedMessage',
      payload: { sessionId: SESSION_ID },
    })).resolves.toEqual({ ok: true, data: { success: true, removedId: 'system-1' } })
    expect(store.deleteMessage).toHaveBeenCalledWith(SESSION_ID, 'system-1')

    // 旧通道:'remove-git-status-message' —— 没有那条标记 = 成功且 removedId 为 null
    await expect(dispatchRpc({
      domain: 'sessions',
      method: 'removeGitStatusMessage',
      payload: { sessionId: SESSION_ID },
    })).resolves.toEqual({ ok: true, data: { success: true, removedId: null } })

    // 旧通道:'remove-message'
    await expect(dispatchRpc({
      domain: 'sessions',
      method: 'removeMessage',
      payload: { sessionId: SESSION_ID, messageId: 'system-1' },
    })).resolves.toEqual({ ok: true, data: { success: true } })
  })

  it('keeps the session-update guards: room agents, unknown agent, illegal permission mode', async () => {
    const { dispatchRpc } = await loadDomain()

    store.getSession.mockReturnValue({ id: SESSION_ID, kind: 'room', messages: [] })
    await expect(dispatchRpc({
      domain: 'sessions',
      method: 'updateAgent',
      payload: { sessionId: SESSION_ID, agentId: 'a1' },
    })).resolves.toEqual({
      ok: true,
      data: {
        success: false,
        error: 'Room sessions bind agents per activation; the agent cannot be set directly',
      },
    })

    store.getSession.mockReturnValue({ id: SESSION_ID, messages: [] })
    agents.agentExists.mockReturnValue(false)
    await expect(dispatchRpc({
      domain: 'sessions',
      method: 'updateAgent',
      payload: { sessionId: SESSION_ID, agentId: 'nope' },
    })).resolves.toEqual({ ok: true, data: { success: false, error: 'Agent not found' } })

    await expect(dispatchRpc({
      domain: 'sessions',
      method: 'updatePermissionMode',
      payload: { sessionId: SESSION_ID, permissionMode: 'yolo' },
    })).resolves.toEqual({ ok: true, data: { success: false, error: 'Invalid permission mode' } })
    expect(store.updateSessionPermissionMode).not.toHaveBeenCalled()
  })

  it('http clamps the working directory into the sandbox root; ipc does not clamp', async () => {
    const { dispatchRpc } = await loadDomain()
    // 一个**真实存在**但落在沙箱根之外的目录:两条传输面的差别因此只剩「夹不夹」,
    // 不掺进「目录存不存在」那道判定。
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-sessions-domain-'))
    try {
      // 越界 —— 文案与被删掉的 server 路由逐字相同。
      await expect(dispatchRpc(
        {
          domain: 'sessions',
          method: 'updateWorkingDirectory',
          payload: { sessionId: SESSION_ID, workingDirectory: outside },
        },
        HTTP_CONTEXT,
      )).resolves.toEqual({
        ok: true,
        data: {
          success: false,
          error: 'Working directory must stay inside the workspace sandbox root.',
        },
      })
      expect(variables.workdirGateway.write).not.toHaveBeenCalled()

      // 桌面不夹:同一条路径原样落到 `fs.stat` 那道判定,然后写下去。
      await expect(dispatchRpc({
        domain: 'sessions',
        method: 'updateWorkingDirectory',
        payload: { sessionId: SESSION_ID, workingDirectory: outside },
      })).resolves.toEqual({ ok: true, data: { success: true } })
      expect(variables.workdirGateway.write).toHaveBeenCalledWith(SESSION_ID, outside)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('http delete aborts the live stream and tears the session channels down; ipc does not', async () => {
    const { dispatchRpc } = await loadDomain()
    store.deleteSession.mockReturnValue({ deletedIds: [SESSION_ID, 'child-1'], deletedCount: 2 })
    engine.getController.mockReturnValue({})

    await expect(dispatchRpc(
      { domain: 'sessions', method: 'delete', payload: { sessionId: SESSION_ID } },
      HTTP_CONTEXT,
    )).resolves.toEqual({ ok: true, data: { success: true, deletedCount: 2 } })

    expect(engine.abort).toHaveBeenCalledWith(SESSION_ID, 'session deleted')
    expect(engine.abort).toHaveBeenCalledWith('child-1', 'session deleted')
    expect(events.destroySession).toHaveBeenCalledWith('child-1')
    expect(events.streamDestroySession).toHaveBeenCalledWith('child-1')
    expect(permission.clearSession).toHaveBeenCalledWith(SESSION_ID)

    // 桌面那条路一件也不做(迁移前 `@main` 本来就没有这一段)。
    engine.abort.mockReset()
    events.destroySession.mockReset()
    events.streamDestroySession.mockReset()
    permission.clearSession.mockReset()
    await dispatchRpc({ domain: 'sessions', method: 'delete', payload: { sessionId: SESSION_ID } })
    expect(engine.abort).not.toHaveBeenCalled()
    expect(events.destroySession).not.toHaveBeenCalled()
    expect(events.streamDestroySession).not.toHaveBeenCalled()
    expect(permission.clearSession).not.toHaveBeenCalled()
  })

  /**
   * P4 终态批 B(拍板 #12):`create` 的 http 分叉从「按传输一刀切」换成「按协调器
   * 在不在场」。两支都要钉,因为这条判据同时是 `/api/capabilities` 里 `collabRooms`
   * 的货源 —— 判反了就会出现「界面开着而请求被拒」的半开状态。
   */
  it('http refuses a create `kind` only when no collab runtime is in the process', async () => {
    const { dispatchRpc } = await loadDomain()
    collab.ensureCollabGroupRoom.mockReturnValue({ success: true, session: { id: SESSION_ID } })
    collab.isCollabV3RuntimeRunning.mockReturnValue(false)

    const roomPayload = {
      name: 'x',
      sessionId: SESSION_ID,
      kind: 'room',
      room: { memberAgentIds: ['a1'] },
    }

    await expect(dispatchRpc(
      { domain: 'sessions', method: 'create', payload: roomPayload },
      HTTP_CONTEXT,
    )).resolves.toEqual({
      ok: true,
      data: { success: false, error: "Session kind 'room' is not supported on the server host" },
    })
    expect(collab.ensureCollabGroupRoom).not.toHaveBeenCalled()

    // 协调器在场(桌面的内嵌 HTTP 面):走与 ipc 完全同一条建房路。
    collab.isCollabV3RuntimeRunning.mockReturnValue(true)
    await expect(dispatchRpc(
      { domain: 'sessions', method: 'create', payload: roomPayload },
      HTTP_CONTEXT,
    )).resolves.toEqual({ ok: true, data: { success: true, session: { id: SESSION_ID } } })
    expect(collab.ensureCollabGroupRoom).toHaveBeenCalledTimes(1)

    // ipc 一格没动:桌面从来不问这个问题。
    collab.isCollabV3RuntimeRunning.mockReturnValue(false)
    await expect(dispatchRpc({
      domain: 'sessions',
      method: 'create',
      payload: roomPayload,
    })).resolves.toEqual({ ok: true, data: { success: true, session: { id: SESSION_ID } } })
    expect(collab.ensureCollabGroupRoom).toHaveBeenCalledTimes(2)
  })

  it('rejects a method that is not on the router allowlist', async () => {
    const { dispatchRpc } = await loadDomain()
    const response = await dispatchRpc({ domain: 'sessions', method: 'updateMaxTokens', payload: {} })
    expect(response.ok).toBe(false)
  })

  /**
   * S2b step B:主读路径收口到 `sessionReads`,事件投影因此能到 UI 的两条读入口。
   * 批 6b(§15.22)烧掉 `ONETHING_SESSION_READ` 并删掉读门面的抄本兜底之后,
   * 这里的判据从"两档对照"收成一条:**两条读入口都必须落在投影上**;把调用点
   * 改回 `store.*` 直读,这几条当场红。
   */
  describe('read-path routing (S2b):getMessages/getMessagesPage 都落在投影上', () => {
    const RAW = [{ id: 'raw-1', role: 'user', content: 'raw', timestamp: 1 }]
    const EVT = [{ id: 'evt-1', role: 'user', content: 'events', timestamp: 2 }]

    beforeEach(() => {
      storesSessions.getSessionMessages.mockReset()
      storesSessions.getSessionMessagesPage.mockReset()
      eventsReads.eventsListMessages.mockReset()
      eventsReads.eventsPageMessages.mockReset()
    })

    it('getMessages 读投影,而不是仓里那份', async () => {
      const { dispatchRpc } = await loadDomain()
      // 仓里那份故意与投影不同 —— 唯一能分出"收没收口"的就是这个分岔。
      storesSessions.getSessionMessages.mockReturnValue(structuredClone(RAW))
      store.getSessionMessages.mockReturnValue(structuredClone(RAW))
      eventsReads.eventsListMessages.mockReturnValue(structuredClone(EVT))

      const res = await dispatchRpc({ domain: 'sessions', method: 'getMessages', payload: { sessionId: SESSION_ID } })
      expect((res as { data: { success: boolean } }).data.success).toBe(true)
      expect((res as { data: { messages: { id: string }[] } }).data.messages.map(m => m.id)).toEqual(['evt-1'])
      expect(eventsReads.eventsListMessages).toHaveBeenCalledWith(SESSION_ID)
    })

    it('getMessages: preserves NOT_FOUND for a missing session, but success:[] for an existing empty one', async () => {
      const { dispatchRpc } = await loadDomain()
      // 会话存在性仍然问仓(投影折不出消息 ≠ 查无此会话),所以这两条与收口前逐字相同。
      eventsReads.eventsListMessages.mockReturnValue(undefined)

      storesSessions.getSessionMessages.mockReturnValue(undefined)
      store.getSessionMessages.mockReturnValue(undefined)
      await expect(
        dispatchRpc({ domain: 'sessions', method: 'getMessages', payload: { sessionId: SESSION_ID } }),
      ).resolves.toEqual({ ok: true, data: { success: false, error: 'Session not found' } })

      storesSessions.getSessionMessages.mockReturnValue([])
      store.getSessionMessages.mockReturnValue([])
      await expect(
        dispatchRpc({ domain: 'sessions', method: 'getMessages', payload: { sessionId: SESSION_ID } }),
      ).resolves.toEqual({ ok: true, data: { success: true, messages: [] } })
    })

    it('getMessagesPage 读投影分页(信封原样透传)', async () => {
      const { dispatchRpc } = await loadDomain()
      const rawPage = { success: true, messages: structuredClone(RAW), hasMoreBefore: false, hasMoreAfter: true, totalCount: 1 }
      const evtPage = { success: true, messages: structuredClone(EVT), hasMoreBefore: true, hasMoreAfter: false, totalCount: 2 }
      storesSessions.getSessionMessagesPage.mockReturnValue(rawPage)
      store.getSessionMessagesPage.mockReturnValue(rawPage)
      eventsReads.eventsPageMessages.mockReturnValue(evtPage)

      const res = await dispatchRpc({ domain: 'sessions', method: 'getMessagesPage', payload: { sessionId: SESSION_ID } })
      const data = (res as { data: { messages: { id: string }[]; hasMoreBefore: boolean; hasMoreAfter: boolean; totalCount: number } }).data
      expect(data.messages.map(m => m.id)).toEqual(['evt-1'])
      expect(data.hasMoreBefore).toBe(true)
      expect(data.hasMoreAfter).toBe(false)
      expect(data.totalCount).toBe(2)
      expect(eventsReads.eventsPageMessages).toHaveBeenCalled()
    })
  })
})

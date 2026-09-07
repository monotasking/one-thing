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
import { SESSION_EVENT_TYPES } from '@onething/core/events'
import { collectSessionCascadeDeleteIds } from '@onething/core/session'
import { installSessionLayerForTest } from '../../session/testing/session-layer.js'
import { createSessionListQuery } from '../../session/index.js'
import type { SessionCommands } from '../../session/commands.js'
import type { SessionReadPorts } from '../../session/reads.js'
import { createSessionAccess } from '../../session/access.js'

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
  getController: vi.fn((_sessionId: string) => undefined as unknown),
  abort: vi.fn(),
}))
const events = vi.hoisted(() => ({
  destroySession: vi.fn(),
  streamDestroySession: vi.fn(),
  /** 改名之后那一发 —— 域现在也往总线上写,不只是删会话时拆通道。 */
  emit: vi.fn(async () => undefined),
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
vi.mock('../../session/events-reads.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../session/events-reads.js')>(),
  ...eventsReads,
}))
vi.mock('../../wiring/collab/index.js', () => collab)
vi.mock('../../wiring/todo-plan/store.js', () => todoPlan)
vi.mock('../../wiring/toc/index.js', () => toc)
vi.mock('../../wiring/variables/gateways.js', () => variables)
vi.mock('../../wiring/agents/index.js', () => agents)
vi.mock('../../wiring/engine/index.js', () => ({ getStreamEngine: () => engine }))
vi.mock('../../wiring/permission/index.js', () => ({ Permission: permission }))
vi.mock('../../events/index.js', () => ({
  getEventBus: () => ({ destroySession: events.destroySession, emit: events.emit }),
  getStreamChannel: () => ({ destroySession: events.streamDestroySession }),
}))

/** 联网宿主的 dispatch context —— server 壳 mint 出来的那一只的形状。 */
const HTTP_CONTEXT = {
  transport: 'http' as const,
  ownerUid: 'local-user',
  workspaceId: 'default',
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
  const ownership = new Map<string, import('../../session/access.js').SessionOwnershipRecord>()
  let dispose: (() => void) | undefined
  let fixture: ReturnType<typeof installSessionLayerForTest>

  beforeEach(async () => {
    ownership.clear()
    fixture = installSessionLayerForTest({
      // Domain adaptation fixtures have an owned index record even when the body port fails.
      access: createSessionAccess({ findMeta: id => ownership.get(id) ?? {} }),
      deletionPorts: {
        targets: id => collectSessionCascadeDeleteIds(store.getSessionsList() as never, id),
        abortAndDrain: async id => { if (engine.getController(id)) engine.abort(id, 'session deleted') },
        flush: async () => {},
        remove: async id => store.deleteSession(id),
      },
      listSessions: createSessionListQuery({
        listSessions: () => store.getSessionsList() as never,
        access: createSessionAccess({ findMeta: id => ownership.get(id) ?? {} }),
      }),
      store: storesSessions as unknown as SessionReadPorts['store'],
      eventReads: eventsReads,
      commands: {
        patchSession: () => true,
        appendMessage: (id, payload) => store.addMessage(id, payload.message),
        deleteMessage: (id, payload) => store.deleteMessage(id, 'messageId' in payload ? payload.messageId : undefined),
      } satisfies Pick<SessionCommands, 'patchSession' | 'appendMessage' | 'deleteMessage'> as unknown as SessionCommands,
    })
    for (const fn of Object.values(store)) fn.mockReset()
    store.getSessionsList.mockReturnValue([])
    store.getSession.mockReturnValue(undefined)
    collab.ensureCollabGroupRoom.mockReset()
    // B2:建房的闸从「http 才问」改成无条件问协调器在不在场。现役宿主(Vue 桌面 /
    // React 壳)的 backend 都带 `collab: true`,所以缺省摆成"在场" —— 那条闸自己的
    // 用例再把它扳到两边去。
    collab.isCollabV3RuntimeRunning.mockReset().mockReturnValue(true)
    todoPlan.deleteSessionAiTodo.mockReset().mockResolvedValue(undefined)
    todoPlan.notifyTodoPlanActiveSessionChanged.mockReset()
    agents.agentExists.mockReset().mockReturnValue(true)
    engine.getController.mockReset().mockReturnValue(undefined)
    engine.abort.mockReset()
    events.destroySession.mockReset()
    events.streamDestroySession.mockReset()
    events.emit.mockReset().mockResolvedValue(undefined)
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
    await fixture.dispose()
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

  it('applies the same workspace query after authorization for both aliases and transports', async () => {
    const { dispatchRpc } = await loadDomain()
    const visible = { id: SESSION_ID, workspaceId: 'project-a', ownerUserId: 'alice', ownerWorkspaceId: 'tenant' }
    const elsewhere = { ...visible, id: 'elsewhere', workspaceId: 'project-b' }
    const foreign = { ...visible, id: 'foreign', ownerUserId: 'bob' }
    const foreignTenant = { ...visible, id: 'foreign-tenant', ownerWorkspaceId: 'project-a' }
    const legacy = { ...visible, id: 'legacy', workspaceId: undefined }
    const records = [elsewhere, foreign, visible, foreignTenant, legacy]
    store.getSessionsList.mockReturnValue(records)
    for (const transport of ['ipc', 'http'] as const) {
      const context = { transport, ownerUid: 'alice', workspaceId: 'tenant' }
      for (const method of ['list', 'listMeta']) {
        await expect(dispatchRpc({ domain: 'sessions', method, payload: { workspaceId: 'project-a' } }, context))
          .resolves.toEqual({ ok: true, data: { success: true, sessions: [visible] } })
        await expect(dispatchRpc({ domain: 'sessions', method, payload: {} }, context))
          .resolves.toEqual({ ok: true, data: { success: true, sessions: [elsewhere, visible, legacy] } })
        await expect(dispatchRpc({ domain: 'sessions', method, payload: { workspaceId: 'default' } }, context))
          .resolves.toEqual({ ok: true, data: { success: true, sessions: [legacy] } })
      }
    }
    expect(records).toEqual([elsewhere, foreign, visible, foreignTenant, legacy])
    expect(store.createSession).not.toHaveBeenCalled()
    expect(store.addMessage).not.toHaveBeenCalled()
  })

  /**
   * **列表投影是"原样交出索引元数据"**(共享层读侧补齐 E 批的勘察结论)。
   *
   * 这一批立项时以为 `isPinned` 没进 `listMeta`;真机一查是**已经在**的
   * (439 条里 11 条带着它)。域这一层根本没有投影 —— `listMeta` 就是
   * `store.getSessionsList()` 本身,索引里有什么就交出什么。所以这里钉的不是
   * "把 isPinned 加进来",而是**"别哪天有人在这里加一层挑字段的投影"**:那正是
   * 让 `isPinned` / `kind` / `lastMessagePreview` 悄悄消失的唯一途径。
   */
  it('listMeta 原样交出索引元数据 —— isPinned / kind / 新增的两格一个都不掉', async () => {
    const { dispatchRpc } = await loadDomain()
    const meta = {
      id: SESSION_ID,
      name: 'Pinned one',
      createdAt: 1,
      updatedAt: 2,
      isPinned: true,
      kind: 'room',
      messageCount: 12,
      previewText: '第一句',
      lastMessagePreview: '最近说到这儿',
      workspaceId: 'default',
    }
    store.getSessionsList.mockReturnValue([meta])

    await expect(
      dispatchRpc({ domain: 'sessions', method: 'listMeta', payload: {} }),
    ).resolves.toEqual({ ok: true, data: { success: true, sessions: [meta] } })
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
    expect(store.createSession).toHaveBeenCalledWith(SESSION_ID, 'Named', { workspaceId: undefined, initialOwner: { userId: 'local-user', workspaceId: 'default' } })
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
      { sessionId: SESSION_ID, initialOwner: { userId: 'local-user', workspaceId: 'default' } },
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

  /**
   * 改名要发一条 `session:renamed`(读路战役 7e:桌面壳听得见、别的客户端听不见)。
   *
   * 从前这条 RPC 改完盘就结束了 —— 全仓唯一的 `session:renamed` 产地是自动起题
   * (`core/engine/core-stream-engine.ts` 的 `generateAndApplySessionTitle`),显式
   * 改名一发都不发,于是浏览器那一份 / 另一扇窗里的名字要等整表重拉才跟上。
   */
  it('rename 成功时往总线上发一条 session:renamed(sessionId + name 都对)', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(
      dispatchRpc({ domain: 'sessions', method: 'rename', payload: { sessionId: SESSION_ID, newName: '新名字' } }),
    ).resolves.toEqual({ ok: true, data: { success: true } })

    expect(store.renameSession).toHaveBeenCalledWith(SESSION_ID, '新名字')
    expect(events.emit).toHaveBeenCalledTimes(1)
    expect(events.emit).toHaveBeenCalledWith(SESSION_ID, {
      type: SESSION_EVENT_TYPES.SESSION_RENAMED,
      name: '新名字',
    })
  })

  it('rename 失败时一发都不发(盘上没变,别让别人显示一个不存在的名字)', async () => {
    const { dispatchRpc } = await loadDomain()
    store.renameSession.mockImplementation(() => {
      throw new Error('rename failed')
    })

    await expect(
      dispatchRpc({ domain: 'sessions', method: 'rename', payload: { sessionId: SESSION_ID, newName: '新名字' } }),
    ).resolves.toEqual({ ok: true, data: { success: false, error: 'rename failed' } })

    expect(events.emit).not.toHaveBeenCalled()
  })

  /**
   * 改一条**不存在**的会话:仓层早就知道(`applyMetadataMutation` 拿不到 session 就
   * 回 false),从前那条布尔被 `stores/sessions.ts` 吞掉,于是一路回 success、还顺手
   * 推一条改名出去 —— 别的客户端会因此显示一个不存在的名字。09-02 收紧:布尔传出来,
   * 投影据此回 `Session not found`,这一路自然一发都不发。
   */
  it('改不存在的会话:success:false(Session not found)且 emit 零调用', async () => {
    const { dispatchRpc } = await loadDomain()
    // 仓层那条「没改到」的布尔 —— 现在它到得了域这一层。
    store.renameSession.mockReturnValue(false)

    await expect(
      dispatchRpc({ domain: 'sessions', method: 'rename', payload: { sessionId: SESSION_ID, newName: '新名字' } }),
    ).resolves.toEqual({ ok: true, data: { success: false, error: 'Session not found' } })

    expect(events.emit).not.toHaveBeenCalled()
  })

  /**
   * **两处产地同形**。这条不看域自己发了什么(上面那条已经钉死了),看的是
   * **自动起题那一发**至今仍是 `{ type, name }` 两格 —— 谁哪天在引擎那边往载荷里
   * 添一格(或把 `name` 改名),这里当场红,免得两个产地各说各话:消费方
   * (`apps/desktop-react/src/data/sessions-source.ts` 判据 b、renderer 的 chat store)
   * 只认这两格,而它分不清一条 `session:renamed` 是谁发的。
   */
  it('载荷形状与自动起题那一发逐字同形 —— 引擎源码里也只有 { type, name } 两格', async () => {
    const { dispatchRpc } = await loadDomain()
    await dispatchRpc({ domain: 'sessions', method: 'rename', payload: { sessionId: SESSION_ID, newName: '新名字' } })
    const emitted = (events.emit.mock.calls as unknown as unknown[][])[0]?.[1] as Record<string, unknown>
    expect(Object.keys(emitted)).toEqual(['type', 'name'])

    const engineSource = fs.readFileSync(
      new URL('../../../core/engine/core-stream-engine.ts', import.meta.url),
      'utf-8',
    )
    // 引擎那两发(正常 + 兜底标题)都长这样:type 一行、name 一行,再无第三格。
    const engineEmits = engineSource.match(
      /type:\s*SESSION_EVENT_TYPES\.SESSION_RENAMED,\s*\n\s*name:\s*\w+,\s*\n\s*\}/g,
    )
    const allRenamedEmits = engineSource.match(/SESSION_EVENT_TYPES\.SESSION_RENAMED/g)
    expect(engineEmits?.length ?? 0).toBeGreaterThan(0)
    expect(engineEmits?.length).toBe(allRenamedEmits?.length)
  })

  it('cascades the AI todo delete over every session the store删掉的 id', async () => {
    const { dispatchRpc } = await loadDomain()
    store.getSessionsList.mockReturnValue([{ id: SESSION_ID }, { id: 'child-1', parentSessionId: SESSION_ID }])
    store.deleteSession.mockReturnValue({ deletedIds: [SESSION_ID, 'child-1'], deletedCount: 2 })

    await expect(
      dispatchRpc({ domain: 'sessions', method: 'delete', payload: { sessionId: SESSION_ID } }),
    ).resolves.toEqual({ ok: true, data: { success: true, deletedCount: 2 } })
    expect(todoPlan.deleteSessionAiTodo).toHaveBeenCalledWith(SESSION_ID)
    expect(todoPlan.deleteSessionAiTodo).toHaveBeenCalledWith('child-1')
  })

  it('rejects the complete cascade before abort or delete if a child belongs to another owner', async () => {
    const { dispatchRpc } = await loadDomain()
    store.getSessionsList.mockReturnValue([{ id: SESSION_ID }, { id: 'alice-child', parentSessionId: SESSION_ID }])
    ownership.set('alice-child', { ownerUserId: 'alice', ownerWorkspaceId: 'default' })
    engine.getController.mockReturnValue({})
    const result = await dispatchRpc({ domain: 'sessions', method: 'delete', payload: { sessionId: SESSION_ID } })
    expect(result).toMatchObject({ ok: false, error: { message: 'Session not found' } })
    expect(engine.abort).not.toHaveBeenCalled()
    expect(store.deleteSession).not.toHaveBeenCalled()
    expect(todoPlan.deleteSessionAiTodo).not.toHaveBeenCalled()
    expect(permission.clearSession).not.toHaveBeenCalled()
    expect(events.destroySession).not.toHaveBeenCalled()
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
      //
      // C0 R2:"桌面"这句话要**声明**出来了 —— `resolveRpcSandbox` 的判据从
      // `transport === 'ipc'` 换成了 `isHostLocallyTrusted()`(两个桌面壳都在装配时
      // 写 `{ origin: 'desktop-embedded' }`)。喂进去的 context 一个字没改;声明只
      // 罩住这一段,上面那半条(未声明 + http = 照夹)必须留在"未声明"里。
      const { configureHostLocalTrust } = await import('../../server/host-trust.js')
      const restoreDesktopTrust = configureHostLocalTrust({ origin: 'desktop-embedded' })
      try {
        await expect(dispatchRpc({
          domain: 'sessions',
          method: 'updateWorkingDirectory',
          payload: { sessionId: SESSION_ID, workingDirectory: outside },
        })).resolves.toEqual({ ok: true, data: { success: true } })
        expect(variables.workdirGateway.write).toHaveBeenCalledWith(SESSION_ID, outside)
      } finally {
        restoreDesktopTrust()
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('a locally trusted http face does not clamp the working directory (files 方案 1 的第二个消费者)', async () => {
    // 08-31 真机账单:React 壳(内嵌面,已声明可信)从项目建会话的第二步落目录
    // 被沙箱逐次拒掉,渲染层又吞了 success:false —— 会话落成空目录,外部 agent
    // 拒启。声明可信后 http 走 ipc 那一列;强制收紧环境变量仍压得住(反证)。
    const { dispatchRpc } = await loadDomain()
    const { configureHostLocalTrust } = await import('../../server/host-trust.js')
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-sessions-trust-'))
    const restore = configureHostLocalTrust({ origin: 'desktop-embedded', host: '127.0.0.1' })
    try {
      await expect(dispatchRpc(
        {
          domain: 'sessions',
          method: 'updateWorkingDirectory',
          payload: { sessionId: SESSION_ID, workingDirectory: outside },
        },
        HTTP_CONTEXT,
      )).resolves.toEqual({ ok: true, data: { success: true } })
      expect(variables.workdirGateway.write).toHaveBeenCalledWith(SESSION_ID, outside)

      // 反证:ONETHING_SERVER_FILES_SANDBOX=1 压过声明,夹持原样。
      process.env.ONETHING_SERVER_FILES_SANDBOX = '1'
      try {
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
      } finally {
        delete process.env.ONETHING_SERVER_FILES_SANDBOX
      }
    } finally {
      restore()
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  /**
   * B2(方案 §2.2「面」):这四步收尾从「http 才做」改成**无条件做**。
   *
   * 两半各钉一条:
   *  - 有活流时,两种 transport 做的是**同一件事**(桌面因此多一个修正:删掉一条
   *    还在生成的会话会中止那条流,不再让它对着一个已删的会话继续写);
   *  - 没有任何进程内活计时整段是 **no-op** —— 这正是"无条件跑"成立的理由。
   */
  it('delete aborts the live stream and tears the session channels down on both transports (B2)', async () => {
    const { dispatchRpc } = await loadDomain()
    store.getSessionsList.mockReturnValue([{ id: SESSION_ID }, { id: 'child-1', parentSessionId: SESSION_ID }])
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

    // 桌面(ipc)从 B2 起做同样四件事 —— 逐调用对齐,不是"差不多"。
    engine.abort.mockReset()
    events.destroySession.mockReset()
    events.streamDestroySession.mockReset()
    permission.clearSession.mockReset()
    fixture.sessionLayer.deletion.reopen(SESSION_ID)
    fixture.sessionLayer.deletion.reopen('child-1')
    await dispatchRpc({ domain: 'sessions', method: 'delete', payload: { sessionId: SESSION_ID } })
    expect(engine.abort.mock.calls).toEqual([
      [SESSION_ID, 'session deleted'],
      ['child-1', 'session deleted'],
    ])
    expect(events.destroySession).toHaveBeenCalledWith('child-1')
    expect(events.streamDestroySession).toHaveBeenCalledWith('child-1')
    expect(permission.clearSession).toHaveBeenCalledWith(SESSION_ID)
  })

  it('delete is a no-op teardown when the session has nothing live in this process (B2)', async () => {
    const { dispatchRpc } = await loadDomain()
    store.deleteSession.mockReturnValue({ deletedIds: [SESSION_ID], deletedCount: 1 })
    // 没有活流 —— `getController` 交白卷,引擎一次都不该被碰。
    engine.getController.mockReturnValue(undefined)

    await expect(dispatchRpc(
      { domain: 'sessions', method: 'delete', payload: { sessionId: SESSION_ID } },
    )).resolves.toEqual({ ok: true, data: { success: true, deletedCount: 1 } })

    expect(engine.abort).not.toHaveBeenCalled()
    // 清询问与拆通道本来就是"没有就不做"的守卫式调用(核实过 B1 报告里那条)。
    expect(permission.clearSession).toHaveBeenCalledWith(SESSION_ID)
    expect(events.destroySession).toHaveBeenCalledWith(SESSION_ID)
    expect(events.streamDestroySession).toHaveBeenCalledWith(SESSION_ID)
  })

  /**
   * P4 终态批 B(拍板 #12):`create` 的分叉从「按传输一刀切」换成「按协调器在不
   * 在场」。两支都要钉,因为这条判据同时是 `/api/capabilities` 里 `collabRooms`
   * 的货源 —— 判反了就会出现「界面开着而请求被拒」的半开状态。
   *
   * B2(方案 §2.2「面」)去掉了剩下那半个 `transport === 'http' &&`:actor 在不在
   * 场是进程事实。于是**没有 collab 的进程从 ipc 也建不出死房**,这是本批唯一一处
   * 对 ipc 收紧的地方(现役宿主的 backend 都带 `collab: true`,判据在那里恒真)。
   */
  it('refuses a create `kind` whenever no collab runtime is in the process — either transport', async () => {
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

    // ipc 也走同一条判据:协调器在场就建(与上面那条 http 逐字同一个答案)。
    await expect(dispatchRpc({
      domain: 'sessions',
      method: 'create',
      payload: roomPayload,
    })).resolves.toEqual({ ok: true, data: { success: true, session: { id: SESSION_ID } } })
    expect(collab.ensureCollabGroupRoom).toHaveBeenCalledTimes(2)

    // B2 的收紧:协调器不在场时 ipc 也拒(从前只有 http 会拒)。
    collab.isCollabV3RuntimeRunning.mockReturnValue(false)
    await expect(dispatchRpc({
      domain: 'sessions',
      method: 'create',
      payload: roomPayload,
    })).resolves.toEqual({
      ok: true,
      data: { success: false, error: "Session kind 'room' is not supported on the server host" },
    })
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

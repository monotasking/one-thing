/**
 * chat 域,端到端穿过 dispatcher(结构债 P4c 第五批)。
 *
 * 接的是被删掉的四处转发的测试位:`apps/electron/src/ipc/chat.ts` 工厂里那六条、
 * `@main/ipc/chat.ts` 的壳适配(两只工厂在 2026-08-22 的 #21 之后已整只删掉)、
 * bridge 上那六条包装,
 * 以及 server 的五条 REST 路由 + `/api/sessions/:id/system-prompt-snapshot`
 * 与它们背后的 `chat` / `prompts` 两个 facade adapter 和 `streams.abort/active`。
 *
 * 只桩**仓本体**(`@onething/backend/store`)与装配侧的四个端口(引擎 / 权限 /
 * 事件总线 / 协作房停止),**投影不桩** —— `@onething/runtime` 那批
 * `*ForIpc` 是真跑的,所以这组用例证的是「域把端口接对了」,而不是「域自己又
 * 实现了一遍」。
 *
 * 值得钉的四件:
 *  - 六条方法都在 router 的白名单上(第七条「工具审批后恢复流」在 2026-08-22 的
 *    #21 里整条删除 —— 没有第七条要钉了);
 *  - `abortStream` 带 sessionId 时走的是**完整收尾**:叫引擎停、清权限、把还
 *    挂着的 step 判死、落 `isStreaming:false`、补 `stream:complete{aborted:true}`;
 *  - `abortStream` 在**没有活流**时如实回 `{ success: false }` —— 这是
 *    `abortOnethingStreamsForIpc` 的语义(渲染层靠它决定要不要就地收尾),
 *    不是「请求收到了」;
 *  - `getActiveStreams` 读的是引擎自己的活会话表,字段名只有 `sessionIds`。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { chatRouter } from '@shared/ipc/chat.js'

const store = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSettings: vi.fn(() => ({}) as unknown),
  updateMessageThinkingTime: vi.fn(),
  updateMessageStep: vi.fn(),
  updateMessageStreaming: vi.fn(),
  flushSessionSave: vi.fn(),
}))

const engine = vi.hoisted(() => ({
  abort: vi.fn(() => false),
  abortAll: vi.fn(),
  getActiveSessionIds: vi.fn(() => [] as string[]),
}))
const permission = vi.hoisted(() => ({ clearSession: vi.fn() }))
// §16.25 钥匙②:停止按钮按**活 run 登记簿**寻址(不再按 `isStreaming` 反查),
// 消息本体从折叠产物取。域把这两口接对了没有,就是本用例要钉的事。
const runs = vi.hoisted(() => ({ currentSessionRun: vi.fn() }))
const reads = vi.hoisted(() => ({ sessionReads: { getMessage: vi.fn() } }))
const collab = vi.hoisted(() => ({ abortCollabRoomTurnForStop: vi.fn(() => false), preflightCollabRoomStop: vi.fn((id: string) => [id]) }))
const eventBus = vi.hoisted(() => ({ emit: vi.fn(async () => {}) }))
const prompt = vi.hoisted(() => ({ buildSystemPromptSnapshot: vi.fn() }))
const providers = vi.hoisted(() => ({
  generateChatTitle: vi.fn(),
  isProviderSupported: vi.fn(() => false),
}))

vi.mock('../../store.js', () => store)
vi.mock('../../wiring/engine/index.js', () => ({ getStreamEngine: () => engine }))
vi.mock('../../wiring/permission/index.js', () => ({ Permission: permission }))
vi.mock('../../wiring/collab/index.js', () => collab)
vi.mock('../../events/index.js', () => ({ getEventBus: () => eventBus }))
vi.mock('../../session/runs.js', () => runs)
vi.mock('../../session/reads.js', () => reads)
vi.mock('../../wiring/engine/prompt/system-prompt-snapshot.js', () => prompt)
vi.mock('../../wiring/providers/index.js', () => providers)
vi.mock('../../wiring/engine/stream/provider-helpers.js', () => ({
  resolveProviderAuth: vi.fn(),
  getProviderApiType: vi.fn(),
}))
vi.mock('../../wiring/usage/bill-side-line.js', () => ({ billTitleUsage: () => () => {} }))

const SESSION_ID = 'session-1'

async function loadDomain() {
  const [{ dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests }, { chatRpcHandlers }] =
    await Promise.all([import('../registry.js'), import('../domains/chat.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, chatRpcHandlers }
}

describe('chat RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    for (const fn of Object.values(store)) fn.mockReset()
    store.getSettings.mockReturnValue({})
    engine.abort.mockReset().mockReturnValue(false)
    engine.abortAll.mockReset()
    engine.getActiveSessionIds.mockReset().mockReturnValue([])
    permission.clearSession.mockReset()
    collab.abortCollabRoomTurnForStop.mockReset().mockReturnValue(false)
    collab.preflightCollabRoomStop.mockReset().mockImplementation(id => [id])
    eventBus.emit.mockReset().mockResolvedValue(undefined)
    prompt.buildSystemPromptSnapshot.mockReset()
    runs.currentSessionRun.mockReset()
    reads.sessionReads.getMessage.mockReset()

    const { resetRpcRegistryForTests, registerRouterHandlers, chatRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(chatRouter, chatRpcHandlers)
  })

  afterEach(async () => {
    dispose?.()
    dispose = undefined
    const { resetRpcRegistryForTests } = await loadDomain()
    resetRpcRegistryForTests()
    vi.restoreAllMocks()
  })

  it('exposes exactly the six methods — the seventh stays on the hand-written channel', async () => {
    const { chatRouter } = await import('@shared/ipc/chat.js')
    expect([...chatRouter.methods]).toEqual([
      'getHistory',
      'generateTitle',
      'getSystemPromptSnapshot',
      'updateMessageThinkingTime',
      'abortStream',
      'getActiveStreams',
    ])
    expect(chatRouter.methods).toHaveLength(6)
  })

  it('reads chat history off the assembly-layer store', async () => {
    const { dispatchRpc } = await loadDomain()
    store.getSession.mockReturnValue({
      id: SESSION_ID,
      messages: [{ id: 'm1', role: 'user', content: 'hi' }],
    })

    const response = await dispatchRpc({
      domain: 'chat',
      method: 'getHistory',
      payload: { sessionId: SESSION_ID },
    })
    expect(response).toMatchObject({ ok: true })
    expect((response as { data: { success: boolean; messages: unknown[] } }).data)
      .toMatchObject({ success: true })
    expect(store.getSession).toHaveBeenCalledWith(SESSION_ID)
  })

  it('reports an unknown session honestly instead of an empty history', async () => {
    const { dispatchRpc } = await loadDomain()
    store.getSession.mockReturnValue(undefined)

    await expect(
      dispatchRpc({ domain: 'chat', method: 'getHistory', payload: { sessionId: 'nope' } }),
    ).resolves.toEqual({ ok: true, data: { success: false, error: 'Session not found' } })
  })

  it('generates a title through the runtime projection (no provider configured → local fallback)', async () => {
    const { dispatchRpc } = await loadDomain()
    // `isProviderSupported` 回 false,投影自己退回「截取用户那句话」那条本地路 ——
    // 域这一侧只负责把设置、provider 适配与计费回调接上。
    const response = await dispatchRpc({
      domain: 'chat',
      method: 'generateTitle',
      payload: { message: 'Build a web runtime architecture for onething' },
    }) as { ok: boolean; data: { success: boolean; title: string } }

    expect(response.ok).toBe(true)
    expect(response.data.success).toBe(true)
    expect(typeof response.data.title).toBe('string')
    expect(response.data.title.length).toBeGreaterThan(0)
    expect(providers.generateChatTitle).not.toHaveBeenCalled()
  })

  it('serves the system prompt snapshot the live stream would actually ship', async () => {
    const { dispatchRpc } = await loadDomain()
    prompt.buildSystemPromptSnapshot.mockResolvedValue({ sessionId: SESSION_ID, systemPrompt: 'x' })

    await expect(
      dispatchRpc({
        domain: 'chat',
        method: 'getSystemPromptSnapshot',
        payload: { sessionId: SESSION_ID },
      }),
    ).resolves.toEqual({
      ok: true,
      data: { success: true, snapshot: { sessionId: SESSION_ID, systemPrompt: 'x' } },
    })
    expect(prompt.buildSystemPromptSnapshot).toHaveBeenCalledWith(SESSION_ID)
  })

  it('writes thinking time through the store mutator and reports a missing message', async () => {
    const { dispatchRpc } = await loadDomain()
    store.updateMessageThinkingTime.mockReturnValue(true)
    await expect(
      dispatchRpc({
        domain: 'chat',
        method: 'updateMessageThinkingTime',
        payload: { sessionId: SESSION_ID, messageId: 'm1', thinkingTime: 3.5 },
      }),
    ).resolves.toEqual({ ok: true, data: { success: true } })
    expect(store.updateMessageThinkingTime).toHaveBeenCalledWith(SESSION_ID, 'm1', 3.5)

    store.updateMessageThinkingTime.mockReturnValue(false)
    await expect(
      dispatchRpc({
        domain: 'chat',
        method: 'updateMessageThinkingTime',
        payload: { sessionId: SESSION_ID, messageId: 'nope', thinkingTime: 1.25 },
      }),
    ).resolves.toEqual({ ok: true, data: { success: false } })
  })

  it('aborts one session: engine stop + permission clear + full stream cleanup', async () => {
    const { dispatchRpc } = await loadDomain()
    engine.abort.mockReturnValue(true)
    runs.currentSessionRun.mockReturnValue({ runId: 'run-1', assistantMessageId: 'assistant-1' })
    reads.sessionReads.getMessage.mockReturnValue({
      id: 'assistant-1',
      steps: [{ id: 'step-1', status: 'running', toolCall: { status: 'executing' } }],
    })

    await expect(
      dispatchRpc({ domain: 'chat', method: 'abortStream', payload: { sessionId: SESSION_ID } }),
    ).resolves.toEqual({ ok: true, data: { success: true } })

    expect(engine.abort).toHaveBeenCalledWith(SESSION_ID)
    expect(permission.clearSession).toHaveBeenCalledWith(SESSION_ID)
    // 收尾三件:判死那一步、落 isStreaming:false、把这条会话冲盘。
    expect(store.updateMessageStep).toHaveBeenCalledWith(
      SESSION_ID,
      'assistant-1',
      'step-1',
      expect.objectContaining({ status: 'cancelled' }),
    )
    expect(store.updateMessageStreaming).toHaveBeenCalledWith(SESSION_ID, 'assistant-1', false)
    expect(store.flushSessionSave).toHaveBeenCalledWith(SESSION_ID)
    // 寻址口自证:问的是登记簿,拿到的 id 才去折叠产物取消息。
    expect(runs.currentSessionRun).toHaveBeenCalledWith(SESSION_ID)
    expect(reads.sessionReads.getMessage).toHaveBeenCalledWith(SESSION_ID, 'assistant-1')
    // 事件三条:step:updated / message:updated / stream:complete{aborted:true}。
    const emitted = (eventBus.emit.mock.calls as unknown as unknown[][])
      .map(call => (call[1] as { type: string }).type)
    expect(emitted).toEqual(['step:updated', 'message:updated', 'stream:complete'])
  })

  /**
   * 反证(§16.25 钥匙②):**一条早就收尾、却还挂着 `isStreaming: true` 的消息**
   * 不许被停止按钮摸到。
   *
   * 这正是老寻址(`session.messages.find(m => m.isStreaming)`)的坏死方式:
   * `updateMessageStreaming(false)` 一旦空转,那一格永远留着 `true`,下一次停止
   * 就会去判死一条早已结束的消息的 step。今天判据换成登记簿 —— 没有活 run 就
   * 没有要停的流,那一格布尔说什么都不算数。
   */
  it('never addresses a settled message by its stale isStreaming flag', async () => {
    const { dispatchRpc } = await loadDomain()
    engine.abort.mockReturnValue(false)
    runs.currentSessionRun.mockReturnValue(undefined)
    reads.sessionReads.getMessage.mockReturnValue({
      id: 'assistant-1',
      isStreaming: true,
      steps: [{ id: 'step-1', status: 'running' }],
    })

    await expect(
      dispatchRpc({ domain: 'chat', method: 'abortStream', payload: { sessionId: SESSION_ID } }),
    ).resolves.toEqual({ ok: true, data: { success: false } })

    expect(reads.sessionReads.getMessage).not.toHaveBeenCalled()
    expect(store.updateMessageStep).not.toHaveBeenCalled()
    expect(store.updateMessageStreaming).not.toHaveBeenCalled()
  })

  it('answers `success:false` when nothing was actually running', async () => {
    const { dispatchRpc } = await loadDomain()
    engine.abort.mockReturnValue(false)
    runs.currentSessionRun.mockReturnValue(undefined)

    await expect(
      dispatchRpc({ domain: 'chat', method: 'abortStream', payload: { sessionId: SESSION_ID } }),
    ).resolves.toEqual({ ok: true, data: { success: false } })
    // 「没停下什么」不等于「没试过」:权限照清,与迁移前逐字相同。
    expect(permission.clearSession).toHaveBeenCalledWith(SESSION_ID)
  })

  it('fixes the authorized active target list before aborting each session', async () => {
    const { dispatchRpc } = await loadDomain()
    engine.getActiveSessionIds.mockReturnValue([SESSION_ID, 'session-2'])
    await expect(
      dispatchRpc({ domain: 'chat', method: 'abortStream', payload: {} }),
    ).resolves.toEqual({ ok: true, data: { success: true } })
    expect(engine.abortAll).not.toHaveBeenCalled()
    expect(engine.abort.mock.calls).toEqual([[SESSION_ID], ['session-2']])
  })

  it('routes a room stop to the collab turn before the engine ever sees it', async () => {
    const { dispatchRpc } = await loadDomain()
    // 房间会话上没有流(W18 之后轮次跑在发言人的执行会话里),所以
    // `engine.abort` 回 false —— 停下来的是协作那一侧。
    collab.abortCollabRoomTurnForStop.mockReturnValue(true)
    store.getSession.mockReturnValue(undefined)

    await expect(
      dispatchRpc({ domain: 'chat', method: 'abortStream', payload: { sessionId: 'room-1' } }),
    ).resolves.toEqual({ ok: true, data: { success: true } })
    expect(collab.abortCollabRoomTurnForStop).toHaveBeenCalledWith('room-1', { executionContext: { userId: 'local-user', workspaceId: 'default' } })
  })

  it('rejects the entire batch before stopping an earlier room when a later room has a foreign execution target', async () => {
    const { dispatchRpc } = await loadDomain()
    engine.getActiveSessionIds.mockReturnValue(['room-1', 'room-2'])
    collab.preflightCollabRoomStop.mockImplementation(id => {
      if (id === 'room-2') throw new Error('Session not found')
      return [id, 'local-execution']
    })
    await expect(dispatchRpc({ domain: 'chat', method: 'abortStream', payload: {} }))
      .resolves.toMatchObject({ ok: false })
    expect(engine.abort).not.toHaveBeenCalled()
    expect(collab.abortCollabRoomTurnForStop).not.toHaveBeenCalled()
    expect(permission.clearSession).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('lists active streams off the engine, under the one field name `sessionIds`', async () => {
    const { dispatchRpc } = await loadDomain()
    engine.getActiveSessionIds.mockReturnValue([SESSION_ID, 'session-2'])

    const response = await dispatchRpc({
      domain: 'chat',
      method: 'getActiveStreams',
      payload: {},
    }) as { ok: boolean; data: Record<string, unknown> }
    expect(response).toEqual({
      ok: true,
      data: { success: true, sessionIds: [SESSION_ID, 'session-2'] },
    })
    // 被删掉的 `GET /api/streams/active` 回的是 `streams` —— 那个名字不再存在。
    expect(response.data).not.toHaveProperty('streams')
  })
})
// Adapter fixtures explicitly belong to the local operator on both transports.
vi.mock('../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({ findMeta: () => ({}) }) }
})

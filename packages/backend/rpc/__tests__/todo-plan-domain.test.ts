/**
 * Todo / plan 的数据面，端到端穿过 dispatcher。
 *
 * 这个域是**部分迁移**的，所以这里额外守两件事：
 *  - 路由表里只有数据面六个方法，窗口动作（open/hide/toggle/pin）不许溜进来；
 *  - `revealDirectory` 在未注入宿主端口的宿主上照实说"不支持"，而不是让 no-op
 *    冒充成功（迁移前 server 给的就是这句实话）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionAccess } from '../../session/access.js'
import { installSessionLayerForTest } from '../../session/testing/session-layer.js'
import { todoPlanRouter } from '@shared/ipc/todo-plan.js'

const store = vi.hoisted(() => ({
  currentSessionId: vi.fn(),
  canRevealTodoPlanDirectory: vi.fn(),
  createUserTodoNote: vi.fn(),
  deleteUserTodoNote: vi.fn(),
  readTodoPlanSnapshotForSession: vi.fn(),
  renameUserTodoNote: vi.fn(),
  revealTodoPlanDirectory: vi.fn(),
  updateTodoPlanDocument: vi.fn(),
}))

vi.mock('../../wiring/todo-plan/store.js', () => store)
vi.mock('../../stores/app-state.js', () => ({ getCurrentSessionId: store.currentSessionId }))

const ownerRows = new Map([
  ['session-1', {}],
  ['alice-session', { ownerUserId: 'alice', ownerWorkspaceId: 'tenant' }],
])
const alice = { transport: 'http' as const, ownerUid: 'alice', workspaceId: 'tenant' }
const bob = { transport: 'http' as const, ownerUid: 'bob', workspaceId: 'tenant' }

const SNAPSHOT = { directory: '/todo', userNotes: [], sessionId: 'session-1' }
const DOCUMENT = { id: 'note-1', title: 'Today', content: '- [ ] Ship' }

async function loadDomain() {
  const [
    { dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests },
    { todoPlanRpcHandlers },
  ] = await Promise.all([
    import('../registry.js'),
    import('../domains/todo-plan.js'),
  ])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, todoPlanRpcHandlers }
}

describe('todo-plan RPC domain (data half only)', () => {
  let dispose: (() => void) | undefined
  let sessionFixture: ReturnType<typeof installSessionLayerForTest>

  beforeEach(async () => {
    store.currentSessionId.mockReset().mockReturnValue('session-1')
    sessionFixture = installSessionLayerForTest({ access: createSessionAccess({ findMeta: id => ownerRows.get(id) }) })
    store.canRevealTodoPlanDirectory.mockReset().mockReturnValue(true)
    store.readTodoPlanSnapshotForSession.mockReset().mockResolvedValue(SNAPSHOT)
    store.createUserTodoNote.mockReset().mockResolvedValue(DOCUMENT)
    store.updateTodoPlanDocument.mockReset().mockResolvedValue(DOCUMENT)
    store.renameUserTodoNote.mockReset().mockResolvedValue(DOCUMENT)
    store.deleteUserTodoNote.mockReset().mockResolvedValue(undefined)
    store.revealTodoPlanDirectory.mockReset().mockResolvedValue(undefined)
    const { resetRpcRegistryForTests, registerRouterHandlers, todoPlanRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(todoPlanRouter, todoPlanRpcHandlers)
  })

  afterEach(async () => {
    await sessionFixture.dispose()
    dispose?.()
    dispose = undefined
  })

  it('get / create / update / rename / delete reach the store with the caller payload', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({
      domain: 'todo-plan',
      method: 'get',
      payload: { sessionId: 'session-1' },
    })).resolves.toEqual({ ok: true, data: { success: true, snapshot: SNAPSHOT } })
    expect(store.readTodoPlanSnapshotForSession).toHaveBeenCalledWith({ sessionId: 'session-1' })

    await dispatchRpc({ domain: 'todo-plan', method: 'create', payload: { title: 'Today', content: 'x' } })
    expect(store.createUserTodoNote).toHaveBeenCalledWith('Today', 'x')

    const update = { scope: 'session-ai-todo', content: '- [ ] Ship' }
    await dispatchRpc({ domain: 'todo-plan', method: 'update', payload: update })
    expect(store.updateTodoPlanDocument).toHaveBeenCalledWith({ ...update, sessionId: 'session-1' })

    await dispatchRpc({ domain: 'todo-plan', method: 'rename', payload: { id: 'note-1', title: 'Later' } })
    expect(store.renameUserTodoNote).toHaveBeenCalledWith('note-1', 'Later')

    await expect(dispatchRpc({
      domain: 'todo-plan',
      method: 'delete',
      payload: { id: 'note-1' },
    })).resolves.toEqual({ ok: true, data: { success: true } })
    expect(store.deleteUserTodoNote).toHaveBeenCalledWith('note-1')
  })

  it('revealDirectory runs when the host injected the port', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({
      domain: 'todo-plan',
      method: 'revealDirectory',
      payload: {},
    })).resolves.toEqual({ ok: true, data: { success: true } })
    expect(store.revealTodoPlanDirectory).toHaveBeenCalledTimes(1)
  })

  it('revealDirectory says "not available" on a host without the port — no fake success', async () => {
    const { dispatchRpc } = await loadDomain()
    store.canRevealTodoPlanDirectory.mockReturnValue(false)

    await expect(dispatchRpc({
      domain: 'todo-plan',
      method: 'revealDirectory',
      payload: {},
    })).resolves.toEqual({
      ok: true,
      data: {
        success: false,
        error: 'Opening the todo plan directory is not available in this host.',
      },
    })
    expect(store.revealTodoPlanDirectory).not.toHaveBeenCalled()
  })

  it('the window half never reached this domain', async () => {
    const { dispatchRpc } = await loadDomain()

    for (const method of ['openWindow', 'hideWindow', 'toggleWindow', 'setWindowPinned']) {
      await expect(dispatchRpc({ domain: 'todo-plan', method, payload: {} })).resolves.toEqual({
        ok: false,
        error: { message: `Unknown RPC method "todo-plan.${method}"`, code: 'UNKNOWN_METHOD' },
      })
    }
  })

  it('a store failure comes back as ok:false, not a rejection', async () => {
    const { dispatchRpc } = await loadDomain()
    store.readTodoPlanSnapshotForSession.mockRejectedValue(new Error('todo dir unreadable'))

    await expect(dispatchRpc({
      domain: 'todo-plan',
      method: 'get',
      payload: {},
    })).resolves.toEqual({
      ok: true,
      data: { success: false, error: 'todo dir unreadable' },
    })
  })
  it.each(['get', 'update'] as const)('%s rejects an explicit foreign session before touching todo files', async method => {
    const { dispatchRpc } = await loadDomain()
    const result = await dispatchRpc({
      domain: 'todo-plan', method,
      payload: { sessionId: 'alice-session', scope: 'session-ai-todo', content: 'stolen' },
    }, bob)
    expect(result).toMatchObject({ ok: false, error: { message: 'Session not found' } })
    expect(store.readTodoPlanSnapshotForSession).not.toHaveBeenCalled()
    expect(store.updateTodoPlanDocument).not.toHaveBeenCalled()
  })

  it.each(['get', 'update'] as const)('%s authorizes the actual active session when the request omits its id', async method => {
    store.currentSessionId.mockReturnValue('alice-session')
    const { dispatchRpc } = await loadDomain()
    const result = await dispatchRpc({
      domain: 'todo-plan', method, payload: { scope: 'session-ai-todo', content: 'stolen' },
    }, bob)
    expect(result).toMatchObject({ ok: false, error: { message: 'Session not found' } })
    expect(store.readTodoPlanSnapshotForSession).not.toHaveBeenCalled()
    expect(store.updateTodoPlanDocument).not.toHaveBeenCalled()
  })

  it('pins the authorized active id before the store performs asynchronous work', async () => {
    store.currentSessionId.mockReturnValueOnce('alice-session').mockReturnValue('session-1')
    const { dispatchRpc } = await loadDomain()
    await dispatchRpc({ domain: 'todo-plan', method: 'get', payload: {} }, alice)
    expect(store.currentSessionId).toHaveBeenCalledTimes(1)
    expect(store.readTodoPlanSnapshotForSession).toHaveBeenCalledWith({ sessionId: 'alice-session' })
  })

  it('reads only global notes without an active session and refuses an AI todo write', async () => {
    store.currentSessionId.mockReturnValue(undefined)
    const { dispatchRpc } = await loadDomain()
    expect(await dispatchRpc({ domain: 'todo-plan', method: 'get', payload: {} }, bob)).toMatchObject({ ok: true })
    expect(store.readTodoPlanSnapshotForSession).toHaveBeenCalledWith({ sessionId: undefined })
    expect(await dispatchRpc({
      domain: 'todo-plan', method: 'update', payload: { scope: 'session-ai-todo', content: 'x' },
    }, bob)).toMatchObject({ ok: false, error: { message: 'Session not found' } })
    expect(store.updateTodoPlanDocument).not.toHaveBeenCalled()
  })

  it('global user notes retain the fixed-operator contract independently of the active session', async () => {
    store.currentSessionId.mockReturnValue('alice-session')
    const { dispatchRpc } = await loadDomain()
    const request = { scope: 'user-note', id: 'note-1', content: 'updated' }
    await dispatchRpc({ domain: 'todo-plan', method: 'update', payload: request }, bob)
    expect(store.updateTodoPlanDocument).toHaveBeenCalledWith(request)
    expect(store.currentSessionId).not.toHaveBeenCalled()
  })

})

/**
 * Todo / plan 的数据面，端到端穿过 dispatcher。
 *
 * 这个域是**部分迁移**的，所以这里额外守两件事：
 *  - 路由表里只有数据面六个方法，窗口动作（open/hide/toggle/pin）不许溜进来；
 *  - `revealDirectory` 在未注入宿主端口的宿主上照实说"不支持"，而不是让 no-op
 *    冒充成功（迁移前 server 给的就是这句实话）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  canRevealTodoPlanDirectory: vi.fn(),
  createUserTodoNote: vi.fn(),
  deleteUserTodoNote: vi.fn(),
  readTodoPlanSnapshot: vi.fn(),
  renameUserTodoNote: vi.fn(),
  revealTodoPlanDirectory: vi.fn(),
  updateTodoPlanDocument: vi.fn(),
}))

vi.mock('../../todo-plan/store.js', () => store)

const SNAPSHOT = { directory: '/todo', userNotes: [], sessionId: 'session-1' }
const DOCUMENT = { id: 'note-1', title: 'Today', content: '- [ ] Ship' }

async function loadDomain() {
  const [{ dispatchRpc, resetRpcRegistryForTests }, { registerTodoPlanRpcDomain }] = await Promise.all([
    import('../registry.js'),
    import('../domains/todo-plan.js'),
  ])
  return { dispatchRpc, resetRpcRegistryForTests, registerTodoPlanRpcDomain }
}

describe('todo-plan RPC domain (data half only)', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    store.canRevealTodoPlanDirectory.mockReset().mockReturnValue(true)
    store.readTodoPlanSnapshot.mockReset().mockResolvedValue(SNAPSHOT)
    store.createUserTodoNote.mockReset().mockResolvedValue(DOCUMENT)
    store.updateTodoPlanDocument.mockReset().mockResolvedValue(DOCUMENT)
    store.renameUserTodoNote.mockReset().mockResolvedValue(DOCUMENT)
    store.deleteUserTodoNote.mockReset().mockResolvedValue(undefined)
    store.revealTodoPlanDirectory.mockReset().mockResolvedValue(undefined)
    const { resetRpcRegistryForTests, registerTodoPlanRpcDomain } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerTodoPlanRpcDomain()
  })

  afterEach(() => {
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
    expect(store.readTodoPlanSnapshot).toHaveBeenCalledWith({ sessionId: 'session-1' })

    await dispatchRpc({ domain: 'todo-plan', method: 'create', payload: { title: 'Today', content: 'x' } })
    expect(store.createUserTodoNote).toHaveBeenCalledWith('Today', 'x')

    const update = { scope: 'session-ai-todo', content: '- [ ] Ship' }
    await dispatchRpc({ domain: 'todo-plan', method: 'update', payload: update })
    expect(store.updateTodoPlanDocument).toHaveBeenCalledWith(update)

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
    store.readTodoPlanSnapshot.mockRejectedValue(new Error('todo dir unreadable'))

    await expect(dispatchRpc({
      domain: 'todo-plan',
      method: 'get',
      payload: {},
    })).resolves.toEqual({
      ok: true,
      data: { success: false, error: 'todo dir unreadable' },
    })
  })
})

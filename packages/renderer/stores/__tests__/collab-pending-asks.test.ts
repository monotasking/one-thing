/**
 * R6 — the approval badge is derived, not accumulated (P1-3), and board
 * snapshots arrive in whatever order the transports feel like (P2-18).
 *
 * The badge used to be ±1 event accounting, which cannot be right even in
 * principle: core emits `permission:request` for the HEAD of a session's prompt
 * queue only, while every prompt — queued followers included — emits
 * `permission:settled`. The ledger drifted negative, a clamp hid it, and
 * nothing rebuilt it on reload, so a window reopened over a worker waiting for
 * approval showed no badge at all.
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCollabBoardStore } from '../collabBoard'

const mocks = vi.hoisted(() => ({
  handlers: [] as Array<(envelope: { sessionId: string; event: unknown }) => void>,
  boardGet: vi.fn(),
  getPendingPermissions: vi.fn(),
}))

vi.mock('@/platform', () => ({
  platformApi: {
    onSessionEvent: (handler: (envelope: { sessionId: string; event: unknown }) => void) => {
      mocks.handlers.push(handler)
      return () => {}
    },
    getPendingPermissions: mocks.getPendingPermissions,
  },
}))

vi.mock('@/platform/collab-client', () => ({
  collabApi: { boardGet: mocks.boardGet },
}))

function emit(sessionId: string, event: unknown): void {
  for (const handler of mocks.handlers) handler({ sessionId, event })
}

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    rev: 1,
    title: '给项目加 status.txt',
    status: 'doing',
    assigneeAgentId: 'fe',
    createdBy: { type: 'user' },
    workSessionIds: ['work-1'],
    rejections: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

beforeEach(() => {
  mocks.handlers.length = 0
  mocks.boardGet.mockReset()
  mocks.getPendingPermissions.mockReset()
  mocks.getPendingPermissions.mockResolvedValue({ success: true, pending: [] })
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('collabBoard store: 审批徽标对账 (P1-3)', () => {
  it('rebuilds the badge on a cold open — the events this window never saw', async () => {
    mocks.boardGet.mockResolvedValue({
      success: true,
      board: { version: 1, seq: 3, tasks: [task()] },
    })
    mocks.getPendingPermissions.mockResolvedValue({
      success: true,
      pending: [{ id: 'p1', sessionId: 'work-1', type: 'bash' }],
    })

    const store = useCollabBoardStore()
    await store.load('room-1')

    expect(mocks.getPendingPermissions).toHaveBeenCalledWith('work-1')
    expect(store.hasPendingAsk('work-1')).toBe(true)
  })

  it('only asks about the workers that can actually be waiting', async () => {
    mocks.boardGet.mockResolvedValue({
      success: true,
      board: {
        version: 1,
        tasks: [
          task({ id: 'a', status: 'doing', workSessionIds: ['work-doing'] }),
          task({ id: 'b', status: 'done', workSessionIds: ['work-done'] }),
          task({ id: 'c', status: 'todo', workSessionIds: [] }),
        ],
      },
    })

    const store = useCollabBoardStore()
    await store.load('room-1')

    expect(mocks.getPendingPermissions).toHaveBeenCalledTimes(1)
    expect(mocks.getPendingPermissions).toHaveBeenCalledWith('work-doing')
  })

  it('counts queued prompts too — a session behind its own queue still waits on you', async () => {
    mocks.getPendingPermissions.mockResolvedValue({
      success: true,
      pending: [
        { id: 'p1', sessionId: 'work-1', promptState: 'actionable' },
        { id: 'p2', sessionId: 'work-1', promptState: 'queued' },
      ],
    })

    const store = useCollabBoardStore()
    await store.reconcilePending('work-1')

    expect(store.pendingAsks['work-1']).toBe(2)
  })

  it('re-derives from the queue on a permission event instead of counting deltas', async () => {
    vi.useFakeTimers()
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    // A settle with no matching request used to drive the ledger negative; the
    // clamp then hid the drift until a real ask failed to show a badge.
    mocks.getPendingPermissions.mockResolvedValue({ success: true, pending: [] })
    emit('work-1', { type: 'permission:settled' })
    await vi.advanceTimersByTimeAsync(300)
    expect(store.pendingAsks['work-1']).toBe(0)

    mocks.getPendingPermissions.mockResolvedValue({
      success: true,
      pending: [{ id: 'p1', sessionId: 'work-1' }],
    })
    emit('work-1', { type: 'permission:request' })
    await vi.advanceTimersByTimeAsync(300)
    expect(store.hasPendingAsk('work-1')).toBe(true)
  })

  it('coalesces a burst of permission events into one read', async () => {
    vi.useFakeTimers()
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    emit('work-1', { type: 'permission:settled' })
    emit('work-1', { type: 'permission:request' })
    emit('work-1', { type: 'permission:settled' })
    await vi.advanceTimersByTimeAsync(300)

    expect(mocks.getPendingPermissions).toHaveBeenCalledTimes(1)
  })

  it('keeps the last known count when the read fails — silence is not an empty queue', async () => {
    mocks.getPendingPermissions.mockResolvedValue({
      success: true,
      pending: [{ id: 'p1', sessionId: 'work-1' }],
    })
    const store = useCollabBoardStore()
    await store.reconcilePending('work-1')
    expect(store.hasPendingAsk('work-1')).toBe(true)

    mocks.getPendingPermissions.mockRejectedValue(new Error('bridge down'))
    await store.reconcilePending('work-1')
    expect(store.hasPendingAsk('work-1')).toBe(true)
  })
})

describe('collabBoard store: 快照顺序 (P2-18)', () => {
  it('drops a snapshot older than the one on screen', () => {
    const store = useCollabBoardStore()
    store.applySnapshot('room-1', { version: 1, seq: 5, tasks: [task({ title: '新' })] } as never)
    store.applySnapshot('room-1', { version: 1, seq: 4, tasks: [task({ title: '旧' })] } as never)

    expect(store.boardFor('room-1')?.tasks[0].title).toBe('新')
  })

  it('accepts a newer one, and re-accepts an equal seq (idempotent repaint)', () => {
    const store = useCollabBoardStore()
    store.applySnapshot('room-1', { version: 1, seq: 4, tasks: [task({ title: '旧' })] } as never)
    store.applySnapshot('room-1', { version: 1, seq: 5, tasks: [task({ title: '新' })] } as never)
    expect(store.boardFor('room-1')?.tasks[0].title).toBe('新')

    store.applySnapshot('room-1', { version: 1, seq: 5, tasks: [task({ title: '同号重画' })] } as never)
    expect(store.boardFor('room-1')?.tasks[0].title).toBe('同号重画')
  })

  it('never freezes a legacy board that carries no seq at all', () => {
    const store = useCollabBoardStore()
    store.applySnapshot('room-1', { version: 1, tasks: [task({ title: '一' })] } as never)
    store.applySnapshot('room-1', { version: 1, tasks: [task({ title: '二' })] } as never)

    expect(store.boardFor('room-1')?.tasks[0].title).toBe('二')
  })

  it('guards the broadcast path, not just direct writes', () => {
    const store = useCollabBoardStore()
    store.ensureSubscribed()

    emit('room-1', { type: 'collab:board-changed', board: { version: 1, seq: 9, tasks: [task({ title: '新' })] } })
    emit('room-1', { type: 'collab:board-changed', board: { version: 1, seq: 8, tasks: [task({ title: '旧' })] } })

    expect(store.boardFor('room-1')?.tasks[0].title).toBe('新')
  })
})

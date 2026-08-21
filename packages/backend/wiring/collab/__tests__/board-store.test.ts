/**
 * W13.4 — board broadcast coalescing (父文档 §10.9).
 *
 * A single tool call walks a card through several writes; each one used to fan
 * a whole board snapshot at the renderer. The event REPLACES the snapshot, so
 * a 30ms trailing merge is lossless — but only if the last snapshot wins and
 * the audit trail keeps every step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollabBoard } from '@onething/runtime/collab'

const mocks = vi.hoisted(() => ({
  emitted: [] as Array<{ sessionId: string; event: { type?: string; board?: CollabBoard } }>,
  files: new Map<string, unknown>(),
  appended: [] as string[],
  removed: [] as string[],
}))

vi.mock('@onething/core/storage', () => ({
  readJsonFile: <T>(filePath: string, fallback: T) =>
    (mocks.files.has(filePath) ? mocks.files.get(filePath) as T : fallback),
  writeJsonFile: (filePath: string, value: unknown) => { mocks.files.set(filePath, value) },
}))

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: () => {},
    existsSync: (filePath: string) => mocks.files.has(filePath),
    appendFileSync: (_path: string, line: string) => { mocks.appended.push(line) },
    rmSync: (filePath: string) => { mocks.removed.push(filePath) },
  },
}))

vi.mock('@onething/runtime/storage', () => ({ getOnethingStorePath: () => '/tmp/onething-board-test' }))

vi.mock('../../../events/index.js', () => ({
  getEventBus: () => ({
    emit: async (sessionId: string, event: { type?: string; board?: CollabBoard }) => {
      mocks.emitted.push({ sessionId, event })
    },
  }),
}))

const boardStore = await import('../board-store.js')

const ROOM = 'room-1'
const USER = { type: 'user' as const }

function broadcasts(): Array<CollabBoard | undefined> {
  return mocks.emitted
    .filter(entry => entry.event.type === 'collab:board-changed')
    .map(entry => entry.event.board)
}

beforeEach(() => {
  vi.useFakeTimers()
  boardStore.shutdownCollabBoardBroadcasts()
  mocks.emitted.length = 0
  mocks.appended.length = 0
  mocks.removed.length = 0
  mocks.files.clear()
})

afterEach(() => {
  boardStore.shutdownCollabBoardBroadcasts()
  vi.useRealTimers()
})

describe('collab:board-changed coalescing', () => {
  it('collapses a burst into ONE broadcast carrying the final board', async () => {
    for (let index = 0; index < 5; index++) {
      await boardStore.applyBoardAction(ROOM, { action: 'create', title: `卡 ${index}` }, USER)
    }
    // Still inside the window: nothing has gone out yet.
    expect(broadcasts()).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(30)
    const sent = broadcasts()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.tasks).toHaveLength(5)
    expect(sent[0]?.tasks.map(task => task.title)).toEqual(['卡 0', '卡 1', '卡 2', '卡 3', '卡 4'])
  })

  it('does not throttle the audit trail — every step is still appended', async () => {
    for (let index = 0; index < 5; index++) {
      await boardStore.applyBoardAction(ROOM, { action: 'create', title: `卡 ${index}` }, USER)
    }
    expect(mocks.appended).toHaveLength(5)
  })

  it('starts a fresh window after the flush (a later change is not swallowed)', async () => {
    await boardStore.applyBoardAction(ROOM, { action: 'create', title: '第一张' }, USER)
    await vi.advanceTimersByTimeAsync(30)
    await boardStore.applyBoardAction(ROOM, { action: 'create', title: '第二张' }, USER)
    await vi.advanceTimersByTimeAsync(30)

    const sent = broadcasts()
    expect(sent).toHaveLength(2)
    expect(sent[1]?.tasks).toHaveLength(2)
  })

  it('keeps rooms independent', async () => {
    await boardStore.applyBoardAction(ROOM, { action: 'create', title: 'A' }, USER)
    await boardStore.applyBoardAction('room-2', { action: 'create', title: 'B' }, USER)
    await vi.advanceTimersByTimeAsync(30)

    expect(mocks.emitted.filter(entry => entry.sessionId === ROOM)).toHaveLength(1)
    expect(mocks.emitted.filter(entry => entry.sessionId === 'room-2')).toHaveLength(1)
  })

  it('drops a pending repaint on clear/shutdown instead of emitting into a dead room', async () => {
    await boardStore.applyBoardAction(ROOM, { action: 'create', title: 'A' }, USER)
    boardStore.clearCollabBoardBroadcast(ROOM)
    await vi.advanceTimersByTimeAsync(60)
    expect(broadcasts()).toHaveLength(0)

    await boardStore.applyBoardAction(ROOM, { action: 'create', title: 'B' }, USER)
    boardStore.shutdownCollabBoardBroadcasts()
    await vi.advanceTimersByTimeAsync(60)
    expect(broadcasts()).toHaveLength(0)
  })

  it('clearCollabBoard 清掉卡片与审计轨,seq 继续往前走', async () => {
    await boardStore.applyBoardAction(ROOM, { action: 'create', title: 'A' }, USER)
    await boardStore.applyBoardAction(ROOM, { action: 'create', title: 'B' }, USER)
    await vi.advanceTimersByTimeAsync(30)
    const before = broadcasts().at(-1)!
    mocks.emitted.length = 0

    const result = await boardStore.clearCollabBoard(ROOM)
    await vi.advanceTimersByTimeAsync(30)

    expect(result.clearedTaskCount).toBe(2)
    expect(boardStore.loadCollabBoard(ROOM).tasks).toEqual([])
    expect(mocks.removed.some(filePath => filePath.endsWith('activity.jsonl'))).toBe(true)
    const sent = broadcasts()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.tasks).toEqual([])
    // 空看板的 seq 必须更大,否则渲染层会把它当过期到达丢掉 —— 界面上就"没清"。
    expect((sent[0]?.seq ?? 0) > (before.seq ?? 0)).toBe(true)
  })

  it('从没有过看板的房:清空是彻底的空操作,不凭空写出一个 board.json', async () => {
    const result = await boardStore.clearCollabBoard('room-never-had-a-board')
    await vi.advanceTimersByTimeAsync(30)

    expect(result.clearedTaskCount).toBe(0)
    expect(mocks.files.size).toBe(0)
    expect(broadcasts()).toHaveLength(0)
  })

  it('清空排在在飞写入之后:后到的创建落在空看板上,而不是把旧快照写回去', async () => {
    const pending = boardStore.applyBoardAction(ROOM, { action: 'create', title: '旧' }, USER)
    const cleared = boardStore.clearCollabBoard(ROOM)
    const late = boardStore.applyBoardAction(ROOM, { action: 'create', title: '新' }, USER)
    await Promise.all([pending, cleared, late])

    expect(boardStore.loadCollabBoard(ROOM).tasks.map(task => task.title)).toEqual(['新'])
  })

  it('coalesces the coordinator-internal patch path too', async () => {
    const created = await boardStore.applyBoardAction(ROOM, { action: 'create', title: 'A' }, USER)
    const taskId = created.task!.id
    await vi.advanceTimersByTimeAsync(30)
    mocks.emitted.length = 0

    await boardStore.patchCollabTask(ROOM, taskId, { status: 'doing' })
    await boardStore.patchCollabTask(ROOM, taskId, { workSessionIds: ['work-1'] })
    expect(broadcasts()).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(30)
    const sent = broadcasts()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.tasks[0].status).toBe('doing')
    expect(sent[0]?.tasks[0].workSessionIds).toEqual(['work-1'])
  })
})

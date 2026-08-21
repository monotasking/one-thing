/**
 * 工作会话的 cwd 归属(2026-08-11 止血 6,
 * `docs/audit/self-hosting-gap-audit-2026-08-11.md` P0-4)。
 *
 * 这一条以前是无条件的:每开一次工、每续一次做,工作会话的工作目录都被重新盖回
 * 群 folder。于是一张「去仓库里改这个 bug」的卡,worker 一开工就被切进
 * `~/.onething/collab-rooms/<id>/` —— 它看不见那个仓库,只能在空屋子里摸索。
 *
 * 现在的口径与紧邻的 permissionMode 同一条:**缺席才给默认值**。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSessionFacadeMock } from '../../../../session/testing/facade-mock.js'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { workingDirectory?: string; messages: unknown[] }>(),
  workdirWrites: [] as Array<{ sessionId: string; workingDirectory: string }>,
  ensuredRooms: [] as string[],
  roomFolder: '/store/collab-rooms/room-1',
}))

// P0.2 ③:业务代码改走 `sessionCommands` / `sessionReads`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。这两扇门换成共用替身,
// 读写落在下面同一份假会话表上 —— 与迁移前 `store.js` 假表的语义逐条对齐。
vi.mock('../../../../session/reads.js', () => import('../../../../session/testing/facade-mock.js'))
vi.mock('../../../../session/commands.js', () => import('../../../../session/testing/facade-mock.js'))
bindSessionFacadeMock((id: string) => mocks.sessions.get(id))

vi.mock('../../../agents/index.js', () => ({
  findAgent: (agentId: string) => ({ id: agentId, name: agentId, isActive: true }),
}))

vi.mock('../../../engine/index.js', () => ({
  getStreamEngineSafe: () => ({
    hasCommandTarget: () => true,
    getChannel: () => 'ipc',
  }),
}))

vi.mock('../../../../events/index.js', () => ({
  getEventBus: () => ({
    onAny: (_sessionId: string, handler: (envelope: unknown) => void) => {
      handlers.push(handler)
      return () => {}
    },
    // 总线是同步投递的:一 emit 就把这条工作回合收成 complete,免得测试等墙钟。
    emit: async (sessionId: string) => {
      for (const handler of handlers) handler({ sessionId, event: { type: 'stream:complete' } })
    },
  }),
}))

vi.mock('../../../../store.js', () => ({
  getSession: (id: string) => mocks.sessions.get(id),
  createSessionWithoutFocus: (id: string) => {
    mocks.sessions.set(id, { messages: [] })
  },
  updateSessionCollab: () => true,
  updateSessionAgent: () => true,
  updateSessionModel: () => true,
  updateSessionPermissionMode: () => true,
  updateSessionWorkingDirectory: (sessionId: string, workingDirectory: string) => {
    mocks.workdirWrites.push({ sessionId, workingDirectory })
    const session = mocks.sessions.get(sessionId)
    if (session) session.workingDirectory = workingDirectory
    return true
  },
}))

vi.mock('@onething/runtime/collab/drive-guard', () => ({
  issueCollabDriveToken: () => 'drive-token',
}))

vi.mock('../../room-folder.js', () => ({
  collabRoomFolder: () => mocks.roomFolder,
  ensureCollabRoomFolder: (roomSessionId: string) => {
    mocks.ensuredRooms.push(roomSessionId)
    return mocks.roomFolder
  },
}))

vi.mock('../../turn-primitives.js', () => ({
  abortCollabZombieStream: () => {},
  collabAgentModelFields: () => ({}),
  collabDriveEnvelope: (input: Record<string, unknown>) => input,
  scanCollabRoomSays: () => ({ says: [] }),
}))

const handlers: Array<(envelope: unknown) => void> = []

const { createCollabEngineWorkerPort } = await import('../worker-mind-port.js')

function runRequest(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'fe',
    workerId: 'w-1',
    cardId: 'card-1',
    roomSessionId: 'room-1',
    title: '修一个 bug',
    ...overrides,
  } as Parameters<ReturnType<typeof createCollabEngineWorkerPort>['runWorkTurn']>[0]
}

describe('collab worker port · 工作会话的 cwd', () => {
  beforeEach(() => {
    mocks.sessions.clear()
    mocks.workdirWrites = []
    mocks.ensuredRooms = []
    handlers.length = 0
  })

  it('一条全新的工作会话仍然落在群 folder 上(交付物语义不变)', async () => {
    const port = createCollabEngineWorkerPort({ newWorkSessionId: () => 'work-1' })
    const result = await port.runWorkTurn(runRequest())

    expect(result.outcome).toBe('complete')
    expect(mocks.ensuredRooms).toEqual(['room-1'])
    expect(mocks.workdirWrites).toEqual([
      { sessionId: 'work-1', workingDirectory: '/store/collab-rooms/room-1' },
    ])
  })

  it('任务自带工作目录时不被切回群目录', async () => {
    mocks.sessions.set('work-1', { workingDirectory: '/Users/me/repo', messages: [] })

    const port = createCollabEngineWorkerPort({ newWorkSessionId: () => 'work-1' })
    await port.runWorkTurn(runRequest({ workSessionId: 'work-1' }))

    expect(mocks.workdirWrites).toEqual([])
    // 群 folder 连建都不建 —— 没人要用它。
    expect(mocks.ensuredRooms).toEqual([])
    expect(mocks.sessions.get('work-1')?.workingDirectory).toBe('/Users/me/repo')
  })

  it('续做时一轮一轮地重盖也不会发生(第二轮读到的仍是原 cwd)', async () => {
    const port = createCollabEngineWorkerPort({ newWorkSessionId: () => 'work-1' })
    await port.runWorkTurn(runRequest())
    // 第一轮之后会话上有了群 folder;此时用户把它指向真正的仓库。
    mocks.sessions.get('work-1')!.workingDirectory = '/Users/me/repo'
    mocks.workdirWrites = []
    mocks.ensuredRooms = []

    await port.runWorkTurn(runRequest({ workSessionId: 'work-1' }))

    expect(mocks.workdirWrites).toEqual([])
    expect(mocks.sessions.get('work-1')?.workingDirectory).toBe('/Users/me/repo')
  })

  it('空白串不算「带了 cwd」', async () => {
    mocks.sessions.set('work-1', { workingDirectory: '   ', messages: [] })
    const port = createCollabEngineWorkerPort({ newWorkSessionId: () => 'work-1' })
    await port.runWorkTurn(runRequest({ workSessionId: 'work-1' }))
    expect(mocks.workdirWrites).toEqual([
      { sessionId: 'work-1', workingDirectory: '/store/collab-rooms/room-1' },
    ])
  })
})

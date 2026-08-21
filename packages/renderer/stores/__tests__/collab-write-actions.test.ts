/**
 * 协作写路径收进 store action(架构收敛 C4 §4)。
 *
 * 收敛前「写完镜像怎么更新」这条约定散在各个组件里,而且**三种回路**各不相同:
 * 看板靠回复回填快照、房间配置靠 `session:collab-updated` 事件、表情靠
 * `message:updated` 广播。新加一个写入点选错回路或者干脆忘了回填,症状只有
 * "点了没反应",没有任何东西会报错。
 *
 * 这一组钉的是约定现在有了落点:action 自己负责回填,组件只管说话。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollabBoard } from '@shared/ipc.js'
import { useCollabBoardStore } from '../collabBoard'
import { useSessionsStore } from '../sessions'
import { useChatStore } from '../chat'

const api = vi.hoisted(() => ({
  onSessionEvent: vi.fn(() => () => {}),
  getPendingPermissions: vi.fn(),
  createSession: vi.fn(),
  getSessionsList: vi.fn(),
}))

/** collab 域走通用 RPC 通道(P4a):方法名是 router 上的动词,入参是信封。 */
const collab = vi.hoisted(() => ({
  boardGet: vi.fn(),
  boardAct: vi.fn(),
  taskStop: vi.fn(),
  roomUpdate: vi.fn(),
  roomSetBudgets: vi.fn(),
  roomSetFrozen: vi.fn(),
  roomClearHistory: vi.fn(),
  messageReact: vi.fn(),
  roomRevokeLease: vi.fn(),
  coordinatorGet: vi.fn(),
}))

vi.mock('@/platform', () => ({ platformApi: api }))
vi.mock('@/platform/collab-client', () => ({ collabApi: collab }))

function board(seq: number, title: string): CollabBoard {
  return {
    version: 1,
    seq,
    tasks: [{
      id: 'task-1',
      rev: seq,
      title,
      status: 'todo',
      createdBy: { type: 'user' },
      workSessionIds: [],
      rejections: 0,
      createdAt: 0,
      updatedAt: 0,
    }],
  } as CollabBoard
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  api.getPendingPermissions.mockResolvedValue({ success: true, pending: [] })
  api.getSessionsList.mockResolvedValue({ success: true, sessions: [] })
})

describe('collabBoard 写 action:回填约定 = 回复带的那份快照', () => {
  it('写成功当场落账,不用等 30ms 合并广播', async () => {
    const store = useCollabBoardStore()
    collab.boardAct.mockResolvedValue({ success: true, board: board(2, '写登录页(已移动)') })

    const response = await store.actBoard('room-1', {
      action: 'move',
      taskId: 'task-1',
      status: 'done',
      expectedRev: 1,
    } as never)

    expect(collab.boardAct).toHaveBeenCalledWith({
      roomSessionId: 'room-1',
      action: expect.objectContaining({ action: 'move' }),
    })
    expect(response.success).toBe(true)
    expect(store.boardFor('room-1')?.tasks[0].title).toBe('写登录页(已移动)')
  })

  it('被拒但带板的回复照样重画 —— 冲突提示的底气', async () => {
    const store = useCollabBoardStore()
    store.applySnapshot('room-1', board(1, '写登录页'))
    collab.boardAct.mockResolvedValue({
      success: false,
      error: 'Task task-1 changed (rev 7)',
      board: board(7, '写登录页(已被他人改名)'),
    })

    const response = await store.actBoard('room-1', { action: 'move' } as never)

    expect(response.success).toBe(false)
    expect(store.boardFor('room-1')?.tasks[0].title).toBe('写登录页(已被他人改名)')
  })

  it('不带板的失败不动账本 —— 屏幕上还是刚才那份', async () => {
    const store = useCollabBoardStore()
    store.applySnapshot('room-1', board(3, '写登录页'))
    collab.boardAct.mockResolvedValue({ success: false, error: 'Not a room session' })

    await store.actBoard('room-1', { action: 'move' } as never)

    expect(store.boardFor('room-1')?.tasks[0].title).toBe('写登录页')
    expect(store.boardFor('room-1')?.seq).toBe(3)
  })

  it('桥抛错不吞:错抛给调用方,提示语归 UI', async () => {
    const store = useCollabBoardStore()
    collab.boardAct.mockRejectedValue(new Error('bridge down'))
    await expect(store.actBoard('room-1', { action: 'move' } as never)).rejects.toThrow('bridge down')
  })

  it('停止执行:卡的收敛跟着广播回来,回复带板也照收', async () => {
    const store = useCollabBoardStore()
    collab.taskStop.mockResolvedValue({ success: true, stopped: true })

    const response = await store.stopTask('room-1', 'task-1')

    expect(collab.taskStop).toHaveBeenCalledWith({ roomSessionId: 'room-1', taskId: 'task-1' })
    expect(response.stopped).toBe(true)
  })
})

/**
 * 人级停止(E5)的 store action。
 *
 * 这一条的回填约定与看板那几条**刻意不同**:撤成之后一个字都不本地改 —— 牌撤掉
 * 房间会立刻补发下一张,那份新账只有运行时算得出,`collab:coordinator-changed`
 * 会把它播回来。抢先删一行的话,补发出去的那张牌会在界面上凭空少半秒。
 *
 * `expectedEpoch` 由 store 现取而不是让调用方传:代数是屏幕上那份快照的属性,
 * 不是按钮的参数 —— 让每个入口自己去翻,就是给它们各自翻错的机会。
 */
describe('collabBoard 人级停止(E5):epoch 由 store 现取', () => {
  function seedCoordinator(store: ReturnType<typeof useCollabBoardStore>, floorEpoch: number) {
    store.applyCoordinatorSnapshot('room-1', {
      roomSessionId: 'room-1',
      floorEpoch,
      turns: [],
      queue: [],
      speaking: [],
      typing: [],
      seq: 1,
      at: Date.now(),
    } as never)
  }

  it('撤牌带上快照里的代数,结果原样回给 UI', async () => {
    const store = useCollabBoardStore()
    seedCoordinator(store, 5)
    collab.roomRevokeLease.mockResolvedValue({
      success: true,
      result: { ok: true, revoked: true, agentId: 'fe', epoch: 5 },
    })

    const result = await store.revokeLease('room-1', 'room-1#L2')

    expect(collab.roomRevokeLease).toHaveBeenCalledWith({
      roomSessionId: 'room-1',
      leaseId: 'room-1#L2',
      expectedEpoch: 5,
    })
    expect(result).toMatchObject({ ok: true, revoked: true, agentId: 'fe' })
  })

  it('epoch-stale 时顺手重取一次快照 —— 那正是「你这一屏过时了」的定义', async () => {
    const store = useCollabBoardStore()
    seedCoordinator(store, 5)
    collab.roomRevokeLease.mockResolvedValue({
      success: true,
      result: { ok: false, reason: 'epoch-stale', epoch: 6 },
    })
    collab.coordinatorGet.mockResolvedValue({ success: true, state: null })

    const result = await store.revokeLease('room-1', 'room-1#L2')

    expect(result.reason).toBe('epoch-stale')
    await vi.waitFor(() => {
      expect(collab.coordinatorGet).toHaveBeenCalledWith({ roomSessionId: 'room-1' })
    })
  })

  it('快照上没有代数(读不到这间房)就不发请求 —— 不拿一个猜的数去撤牌', async () => {
    const store = useCollabBoardStore()
    expect(await store.revokeLease('room-1', 'room-1#L2')).toEqual({ ok: false, reason: 'not-a-room' })
    expect(collab.roomRevokeLease).not.toHaveBeenCalled()
  })
})

describe('sessions 房间配置 action:回填约定 = session:collab-updated', () => {
  it('写完不重拉会话表 —— 镜像等事件推回来', async () => {
    const sessions = useSessionsStore()
    collab.roomUpdate.mockResolvedValue({ success: true })
    collab.roomSetBudgets.mockResolvedValue({ success: true })
    collab.roomSetFrozen.mockResolvedValue({ success: true })

    await sessions.updateCollabRoom('room-1', { pmAgentId: 'fe' })
    await sessions.setCollabRoomBudgets('room-1', { dailyCostUSD: 8 })
    await sessions.setCollabRoomFrozen('room-1', true)

    expect(collab.roomUpdate).toHaveBeenCalledWith({ roomSessionId: 'room-1', pmAgentId: 'fe' })
    expect(collab.roomSetBudgets).toHaveBeenCalledWith({ roomSessionId: 'room-1', dailyCostUSD: 8 })
    expect(collab.roomSetFrozen).toHaveBeenCalledWith({ roomSessionId: 'room-1', frozen: true })
    // 这就是 C4-α 的成果:七处全量重拉换成一条就地增量事件。
    expect(api.getSessionsList).not.toHaveBeenCalled()
  })

  it('失败原样返回,store 不替谁决定怎么说话', async () => {
    const sessions = useSessionsStore()
    collab.roomUpdate.mockResolvedValue({ success: false, error: '负责人必须是房间成员' })
    await expect(sessions.updateCollabRoom('room-1', { pmAgentId: 'x' }))
      .resolves.toEqual({ success: false, error: '负责人必须是房间成员' })
  })

  it('建房是"加一行":那一次全量重拉在 action 里,调用方不用记得刷', async () => {
    const sessions = useSessionsStore()
    api.createSession.mockResolvedValue({ success: true, session: { id: 'room-9', name: '新群' } })

    const response = await sessions.createCollabRoom('新群', { memberAgentIds: ['fe'] })

    expect(api.createSession).toHaveBeenCalledWith('新群', {
      kind: 'room',
      room: { memberAgentIds: ['fe'] },
    })
    expect(response.session?.id).toBe('room-9')
    expect(api.getSessionsList).toHaveBeenCalled()
  })

  it('建房失败不重拉', async () => {
    const sessions = useSessionsStore()
    api.createSession.mockResolvedValue({ success: false, error: '创建失败' })
    await sessions.createCollabRoom('新群', { memberAgentIds: [] })
    expect(api.getSessionsList).not.toHaveBeenCalled()
  })

  it('清空转录动的不是配置,所以那一次重拉也在 action 里', async () => {
    const sessions = useSessionsStore()
    collab.roomClearHistory.mockResolvedValue({ success: true })

    await sessions.clearCollabRoomHistory('room-1', true)

    expect(collab.roomClearHistory).toHaveBeenCalledWith({ roomSessionId: 'room-1', includeMemberDms: true })
    expect(api.getSessionsList).toHaveBeenCalled()
  })
})

describe('chat 表情 action:回填约定 = message:updated 广播', () => {
  it('过桥的每个参数都是原始值,一个字都不乐观写', async () => {
    const chat = useChatStore()
    collab.messageReact.mockResolvedValue({ success: true })

    await chat.reactToCollabMessage('room-1', 'msg-1', '👍', { type: 'user' })

    expect(collab.messageReact).toHaveBeenCalledWith({
      roomSessionId: 'room-1',
      messageId: 'msg-1',
      emoji: '👍',
      actor: { type: 'user' },
    })
    // 乐观写会让被拒的那一次留下痕迹;这里没有本地状态可查,正是"不写"的证据。
    expect(chat.sessionMessages.get('room-1')).toBeUndefined()
  })

  it('被拒的回复原样返回,由调用方留下失败痕迹', async () => {
    const chat = useChatStore()
    collab.messageReact.mockResolvedValue({ success: false, error: '这个表情不在调色板里' })
    await expect(chat.reactToCollabMessage('room-1', 'msg-1', '🦄', { type: 'user' }))
      .resolves.toEqual({ success: false, error: '这个表情不在调色板里' })
  })
})

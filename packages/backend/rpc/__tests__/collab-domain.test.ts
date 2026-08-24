/**
 * collab 域,端到端穿过 dispatcher(结构债 P4a 第三域)。
 *
 * 接的是被删掉的那十五条主进程 handler 的测试位(`apps/electron/src/main/__tests__/collab-ipc.test.ts`
 * 随源文件一起删掉,它的每一条断言搬到了这里)。这一层的全部职责是**把 patch
 * 原样送过河**:请求减去它的地址(roomSessionId)就是 patch,一个字段名都不该在
 * 中转里出现,抛出来的错翻译成一次线上失败。
 *
 * 逐字段手抄的那一版活生生丢过一个字段(budgets 的 `maxConcurrentTurns` 抄漏了
 * 几个月,而且不报错),所以下面除了行为测试还钉了三条**穷尽性**:枚举 shared
 * patch/请求类型的 keyof,逐键断言它真的到得了 app 层。新加字段漏抄就是红的 ——
 * 类型层(`Record<keyof …>` 少一个键编译不过)和运行时层各挡一道。
 *
 * 搬家本身另钉两件:十五个方法全在 router 的白名单上(少一个 = 渲染侧那一格
 * 静默失灵),以及 **`messageReact` 的 actor 仍然被钉死成用户** —— router 的
 * dispatch context 里没有「我是谁」,那颗钉子必须由处理者自己钉,wire 上传来的
 * actor 是被**无视**而不是被校验的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CollabAgentActivityGetRequest,
  CollabRoomBudgetsPatch,
  CollabRoomRevokeLeaseRequest,
  CollabRoomRevokeLeaseResult,
  CollabRoomUpdatePatch,
} from '@shared/ipc/collab.js'
import { collabRouter } from '@shared/ipc/collab.js'

const mocks = vi.hoisted(() => ({
  loadCollabBoard: vi.fn(() => ({ version: 1, tasks: [] }) as unknown),
  getCollabAgentActivity: vi.fn((_agentIds?: readonly string[]) => [] as unknown[]),
  getCollabCoordinatorState: vi.fn((_roomSessionId: string) => null as unknown),
  getCollabRoomSpend: vi.fn((_roomSessionId: string) => ({ success: true }) as unknown),
  listCollabRoomFolder: vi.fn((_roomSessionId: string) => ({ entries: [] }) as unknown),
  readCollabSchedulerLogTail: vi.fn((_roomSessionId: string, _options: unknown) => [] as unknown[]),
  setCollabRoomConfig: vi.fn((_roomSessionId: string, _patch: unknown) => ({ success: true })),
  setCollabRoomBudgets: vi.fn((_roomSessionId: string, _patch: unknown) => true),
  setCollabRoomFrozen: vi.fn((_roomSessionId: string, _frozen: boolean) => true),
  stopCollabTaskWork: vi.fn(async (_roomSessionId: string, _taskId: string) => true),
  ensureUserDmRoom: vi.fn((_agentId: string): string | null => 'agent-dm-fe'),
  reactToCollabMessage: vi.fn(() => ({ success: true, reactions: [] })),
  applyUserCollabBoardAction: vi.fn(async () => ({ success: true, board: { version: 1, tasks: [] } })),
  clearCollabRoomHistory: vi.fn(async () => ({ success: true, clearedMessageCount: 3 })),
  // 显式标注返回类型:成功与三条失败原因是**同一个**联合类型,让 vi.fn 从初值
  // 推断的话它只会认得成功那一半,后面 mock 一条 `epoch-stale` 就编译不过。
  revokeCollabRoomLease: vi.fn(
    async (_request: unknown): Promise<CollabRoomRevokeLeaseResult> => ({ ok: true, revoked: true }),
  ),
}))

vi.mock('../../wiring/collab/board-store.js', () => ({
  loadCollabBoard: (...args: unknown[]) => mocks.loadCollabBoard(...(args as [])),
}))

vi.mock('../../wiring/collab/index.js', () => ({
  applyUserCollabBoardAction: (...args: unknown[]) => mocks.applyUserCollabBoardAction(...(args as [])),
  clearCollabRoomHistory: (...args: unknown[]) => mocks.clearCollabRoomHistory(...(args as [])),
  ensureUserDmRoom: (...args: unknown[]) => mocks.ensureUserDmRoom(...(args as [string])),
  getCollabAgentActivity: (...args: unknown[]) =>
    mocks.getCollabAgentActivity(...(args as [readonly string[] | undefined])),
  getCollabCoordinatorState: (...args: unknown[]) => mocks.getCollabCoordinatorState(...(args as [string])),
  getCollabRoomSpend: (...args: unknown[]) => mocks.getCollabRoomSpend(...(args as [string])),
  listCollabRoomFolder: (...args: unknown[]) => mocks.listCollabRoomFolder(...(args as [string])),
  reactToCollabMessage: (...args: unknown[]) => mocks.reactToCollabMessage(...(args as [])),
  readCollabSchedulerLogTail: (...args: unknown[]) =>
    mocks.readCollabSchedulerLogTail(...(args as [string, unknown])),
  revokeCollabRoomLease: (...args: unknown[]) => mocks.revokeCollabRoomLease(...(args as [unknown])),
  setCollabRoomBudgets: (...args: unknown[]) => mocks.setCollabRoomBudgets(...(args as [string, unknown])),
  setCollabRoomConfig: (...args: unknown[]) => mocks.setCollabRoomConfig(...(args as [string, unknown])),
  setCollabRoomFrozen: (...args: unknown[]) => mocks.setCollabRoomFrozen(...(args as [string, boolean])),
  stopCollabTaskWork: (...args: unknown[]) => mocks.stopCollabTaskWork(...(args as [string, string])),
}))

const EMPTY_BOARD = { version: 1, tasks: [] }

async function loadDomain() {
  const [
    { dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests },
    { collabRpcHandlers },
  ] = await Promise.all([
    import('../registry.js'),
    import('../domains/collab.js'),
  ])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, collabRpcHandlers }
}

/** 一次调用 = 一个信封;成功时把 `data` 剥出来,断言写起来和从前一模一样。 */
async function call(method: string, payload?: unknown): Promise<unknown> {
  const { dispatchRpc } = await loadDomain()
  const response = await dispatchRpc({ domain: 'collab', method, payload })
  return response.ok ? response.data : response
}

let dispose: (() => void) | undefined

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.loadCollabBoard.mockReturnValue(EMPTY_BOARD)
  mocks.getCollabAgentActivity.mockReturnValue([])
  mocks.getCollabCoordinatorState.mockReturnValue(null)
  mocks.getCollabRoomSpend.mockReturnValue({ success: true })
  mocks.listCollabRoomFolder.mockReturnValue({ entries: [] })
  mocks.readCollabSchedulerLogTail.mockReturnValue([])
  mocks.setCollabRoomConfig.mockReturnValue({ success: true })
  mocks.setCollabRoomBudgets.mockReturnValue(true)
  mocks.setCollabRoomFrozen.mockReturnValue(true)
  mocks.stopCollabTaskWork.mockResolvedValue(true)
  mocks.ensureUserDmRoom.mockReturnValue('agent-dm-fe')
  mocks.reactToCollabMessage.mockReturnValue({ success: true, reactions: [] })
  mocks.applyUserCollabBoardAction.mockResolvedValue({ success: true, board: EMPTY_BOARD })
  mocks.clearCollabRoomHistory.mockResolvedValue({ success: true, clearedMessageCount: 3 })
  mocks.revokeCollabRoomLease.mockResolvedValue({ ok: true, revoked: true })
  const { resetRpcRegistryForTests, registerRouterHandlers, collabRpcHandlers } = await loadDomain()
  resetRpcRegistryForTests()
  dispose = registerRouterHandlers(collabRouter, collabRpcHandlers)
})

afterEach(() => {
  dispose?.()
  dispose = undefined
})

describe('collab RPC domain', () => {
  it('binds all fifteen methods — an unlisted one never reaches a handler', async () => {
    const { dispatchRpc } = await loadDomain()
    const methods = [
      'boardGet', 'boardAct', 'taskStop', 'roomRevokeLease', 'coordinatorGet',
      'agentActivityGet', 'schedulerLogTail', 'roomSetFrozen', 'roomSetBudgets',
      'roomSpendGet', 'roomUpdate', 'roomClearHistory', 'dmRoomEnsure',
      'roomFolderList', 'messageReact',
    ]

    for (const method of methods) {
      const response = await dispatchRpc({
        domain: 'collab',
        method,
        payload: {
          roomSessionId: 'room-1',
          taskId: 't1',
          leaseId: 'L1',
          expectedEpoch: 1,
          agentId: 'fe',
          messageId: 'm1',
          emoji: '\u{1F44D}',
          frozen: true,
          action: { action: 'list' },
        },
      })
      expect(response.ok, `${method} should dispatch`).toBe(true)
    }

    await expect(dispatchRpc({ domain: 'collab', method: 'nope', payload: {} }))
      .resolves.toMatchObject({ ok: false })
  })
})

describe('boardGet', () => {
  it('wraps the store snapshot in the contract shape', async () => {
    await expect(call('boardGet', { roomSessionId: 'room-1' }))
      .resolves.toEqual({ success: true, board: EMPTY_BOARD })
    expect(mocks.loadCollabBoard).toHaveBeenCalledWith('room-1')
  })

  it('turns a thrown error into a failed response', async () => {
    mocks.loadCollabBoard.mockImplementation(() => { throw new Error('store exploded') })
    await expect(call('boardGet', { roomSessionId: 'room-1' }))
      .resolves.toEqual({ success: false, error: 'store exploded' })
  })
})

describe('roomUpdate', () => {
  it('forwards only the fields present in the request', async () => {
    await expect(call('roomUpdate', { roomSessionId: 'room-1', memberAgentIds: ['pm'] }))
      .resolves.toEqual({ success: true })
    expect(mocks.setCollabRoomConfig).toHaveBeenCalledWith('room-1', { memberAgentIds: ['pm'] })
  })

  it('keeps an explicit null PM (clear) distinct from an absent one', async () => {
    await call('roomUpdate', { roomSessionId: 'room-1', pmAgentId: null })
    expect(mocks.setCollabRoomConfig).toHaveBeenCalledWith('room-1', { pmAgentId: null })
  })

  it('passes the app layer error through instead of a bare boolean', async () => {
    mocks.setCollabRoomConfig.mockReturnValue({ success: false, error: 'PM must be a room member' } as never)
    await expect(call('roomUpdate', { roomSessionId: 'room-1', pmAgentId: 'ghost' }))
      .resolves.toEqual({ success: false, error: 'PM must be a room member' })
  })

  it('turns a thrown error into a failed response', async () => {
    mocks.setCollabRoomConfig.mockImplementation(() => { throw new Error('store exploded') })
    await expect(call('roomUpdate', { roomSessionId: 'room-1', name: 'x' }))
      .resolves.toEqual({ success: false, error: 'store exploded' })
  })

  /**
   * 穷尽性:`CollabRoomUpdatePatch` 的每一个键都真的穿得过处理者。
   *
   * `Record<keyof CollabRoomUpdatePatch, …>` 是类型层的那道闸 —— shared 里加一个
   * 字段而这里没补,编译就红;下面的 toHaveBeenCalledWith 是运行时那道 ——
   * 中转要是又开始逐字段手抄且抄漏,断言就红。
   */
  it('shared patch 的每个键都到得了 app 层(keyof 穷尽)', async () => {
    const patch: Record<keyof CollabRoomUpdatePatch, unknown> = {
      name: '官网改版组',
      memberAgentIds: ['pm', 'fe'],
      pmAgentId: 'pm',
      permissionMode: 'normal',
      responseMode: 'serial',
      speakOrder: ['fe', 'pm'],
      relayLoops: 3,
    }
    await call('roomUpdate', { roomSessionId: 'room-1', ...patch })
    expect(mocks.setCollabRoomConfig).toHaveBeenCalledWith('room-1', patch)
    // 地址不是 patch 的一部分 —— 它是**哪间房**,不是"改什么"。
    expect(mocks.setCollabRoomConfig.mock.calls[0][1]).not.toHaveProperty('roomSessionId')
  })
})

/**
 * roomSetBudgets —— 在这次收敛之前全仓没有一条测试引用过这个通道,而它恰好就是
 * "逐字段手抄漏了一个"那起事故的现场。
 */
describe('roomSetBudgets', () => {
  it('carries the patch across and reports success', async () => {
    await expect(call('roomSetBudgets', { roomSessionId: 'room-1', dailyCostUSD: 12 }))
      .resolves.toEqual({ success: true })
    expect(mocks.setCollabRoomBudgets).toHaveBeenCalledWith('room-1', { dailyCostUSD: 12 })
  })

  it('"不是房间"翻译成一句明确的失败,而不是一个裸 false', async () => {
    mocks.setCollabRoomBudgets.mockReturnValue(false)
    await expect(call('roomSetBudgets', { roomSessionId: 'chat-1', maxChain: 4 }))
      .resolves.toEqual({ success: false, error: 'Not a room session' })
  })

  it('turns a thrown error into a failed response', async () => {
    mocks.setCollabRoomBudgets.mockImplementation(() => { throw new Error('store exploded') })
    await expect(call('roomSetBudgets', { roomSessionId: 'room-1', dailyCostUSD: 1 }))
      .resolves.toEqual({ success: false, error: 'store exploded' })
  })

  /** 同一条穷尽性纪律。`maxConcurrentTurns` 正是被抄漏的那一个,它在这张表里。 */
  it('shared patch 的每个键都到得了 app 层(keyof 穷尽)', async () => {
    const patch: Record<keyof CollabRoomBudgetsPatch, unknown> = {
      dailyCostUSD: 12,
      maxChain: 4,
      maxTurnToolCalls: 20,
      maxTurnSayCalls: 3,
      maxConcurrentTurns: 2,
    }
    await call('roomSetBudgets', { roomSessionId: 'room-1', ...patch })
    expect(mocks.setCollabRoomBudgets).toHaveBeenCalledWith('room-1', patch)
    expect(mocks.setCollabRoomBudgets.mock.calls[0][1]).not.toHaveProperty('roomSessionId')
  })
})

describe('roomSetFrozen', () => {
  it('翻译裸 false,成功时只回 success', async () => {
    await expect(call('roomSetFrozen', { roomSessionId: 'room-1', frozen: true }))
      .resolves.toEqual({ success: true })
    expect(mocks.setCollabRoomFrozen).toHaveBeenCalledWith('room-1', true)

    mocks.setCollabRoomFrozen.mockReturnValue(false)
    await expect(call('roomSetFrozen', { roomSessionId: 'chat-1', frozen: false }))
      .resolves.toEqual({ success: false, error: 'Not a room session' })
  })
})

describe('taskStop', () => {
  it('回报「这张卡此刻有没有在跑的执行」', async () => {
    await expect(call('taskStop', { roomSessionId: 'room-1', taskId: 't1' }))
      .resolves.toEqual({ success: true, stopped: true })
    expect(mocks.stopCollabTaskWork).toHaveBeenCalledWith('room-1', 't1')
  })

  it('turns a thrown error into a failed response', async () => {
    mocks.stopCollabTaskWork.mockRejectedValue(new Error('runtime exploded'))
    await expect(call('taskStop', { roomSessionId: 'room-1', taskId: 't1' }))
      .resolves.toEqual({ success: false, error: 'runtime exploded' })
  })
})

describe('boardAct (W16)', () => {
  it('carries the action across verbatim — the reducer owns what is legal', async () => {
    const action = { action: 'move', taskId: 't1', status: 'done', expectedRev: 4 }
    await expect(call('boardAct', { roomSessionId: 'room-1', action })).resolves
      .toEqual({ success: true, board: EMPTY_BOARD })
    expect(mocks.applyUserCollabBoardAction).toHaveBeenCalledWith('room-1', action)
  })

  it('never lets the renderer choose the actor (user is pinned app-side)', async () => {
    await call('boardAct', {
      roomSessionId: 'room-1',
      action: { action: 'complete', taskId: 't1', summary: 's' },
      actor: { type: 'agent', agentId: 'fe' },
    })
    expect(mocks.applyUserCollabBoardAction).toHaveBeenCalledWith('room-1', {
      action: 'complete',
      taskId: 't1',
      summary: 's',
    })
  })

  it('returns the rev conflict WITH the fresh board so the panel can repaint', async () => {
    mocks.applyUserCollabBoardAction.mockResolvedValue({
      success: false,
      error: 'Task t1 changed (rev 7) — re-read the board (action:"list") and retry with the current rev',
      board: EMPTY_BOARD,
    } as never)
    await expect(call('boardAct', {
      roomSessionId: 'room-1',
      action: { action: 'move', taskId: 't1', status: 'done', expectedRev: 4 },
    })).resolves.toEqual({
      success: false,
      error: 'Task t1 changed (rev 7) — re-read the board (action:"list") and retry with the current rev',
      board: EMPTY_BOARD,
    })
  })

  it('passes the room validation refusal through', async () => {
    mocks.applyUserCollabBoardAction.mockResolvedValue({ success: false, error: 'Not a room session' } as never)
    await expect(call('boardAct', { roomSessionId: 'chat-1', action: { action: 'list' } }))
      .resolves.toEqual({ success: false, error: 'Not a room session' })
  })

  it('refuses an action-less request instead of calling the app layer', async () => {
    await expect(call('boardAct', { roomSessionId: 'room-1' }))
      .resolves.toEqual({ success: false, error: 'Missing board action' })
    expect(mocks.applyUserCollabBoardAction).not.toHaveBeenCalled()
  })

  it('turns a thrown error into a failed response', async () => {
    mocks.applyUserCollabBoardAction.mockRejectedValue(new Error('store exploded'))
    await expect(call('boardAct', { roomSessionId: 'room-1', action: { action: 'list' } }))
      .resolves.toEqual({ success: false, error: 'store exploded' })
  })
})

describe('messageReact (W8)', () => {
  it('carries the four fields across in order', async () => {
    await expect(call('messageReact', {
      roomSessionId: 'room-1', messageId: 'm1', emoji: '\u{1F44D}', actor: { type: 'user' },
    })).resolves.toEqual({ success: true, reactions: [] })
    expect(mocks.reactToCollabMessage)
      .toHaveBeenCalledWith('room-1', 'm1', '\u{1F44D}', { type: 'user' })
  })

  it('passes the app layer refusal through (palette / room validation lives there)', async () => {
    mocks.reactToCollabMessage.mockReturnValue({ success: false, error: 'Unsupported reaction emoji' } as never)
    await expect(call('messageReact', {
      roomSessionId: 'room-1', messageId: 'm1', emoji: '\u{1F680}', actor: { type: 'user' },
    })).resolves.toEqual({ success: false, error: 'Unsupported reaction emoji' })
  })

  it('turns a thrown error into a failed response', async () => {
    mocks.reactToCollabMessage.mockImplementation(() => { throw new Error('store exploded') })
    await expect(call('messageReact', {
      roomSessionId: 'room-1', messageId: 'm1', emoji: '\u{1F44D}', actor: { type: 'user' },
    })).resolves.toEqual({ success: false, error: 'store exploded' })
  })

  /**
   * P2-20 的那颗钉子,原样活过了这次搬家:actor 钉死在处理者里,和 boardAct 钉死
   * 人的理由是同一条。表情是**归属** —— §3.5 B 把一位沉默成员的 emoji 读作它的
   * 回答 —— 所以能指名 actor 的渲染层就能把话安进别人嘴里。
   *
   * router 的 dispatch context 里**没有**「我是谁」这一格,所以这颗钉子不可能上移
   * 到通道层:它必须留在这里。wire 上那个 actor 是被**无视**的,不是被校验的。
   */
  it('pins the actor to the user, whatever the wire claims', async () => {
    await call('messageReact', {
      roomSessionId: 'room-1',
      messageId: 'm1',
      emoji: '\u{1F44D}',
      actor: { type: 'agent', agentId: 'pm' },
    })
    expect(mocks.reactToCollabMessage)
      .toHaveBeenCalledWith('room-1', 'm1', '\u{1F44D}', { type: 'user' })
  })

  it('works with no actor field at all — the wire no longer needs to send one', async () => {
    await call('messageReact', { roomSessionId: 'room-1', messageId: 'm1', emoji: '\u{1F44D}' })
    expect(mocks.reactToCollabMessage)
      .toHaveBeenCalledWith('room-1', 'm1', '\u{1F44D}', { type: 'user' })
  })
})

/**
 * 托管私聊房的 get-or-create(agent-im-dm.md D1)。同一条纪律:校验(同事/在职/
 * 查得到)全在 app 层,处理者只负责把 null 翻译成一句用户读得懂的失败。
 */
describe('dmRoomEnsure', () => {
  it('returns the derived room id the app layer resolved', async () => {
    await expect(call('dmRoomEnsure', { agentId: 'fe' }))
      .resolves.toEqual({ success: true, roomSessionId: 'agent-dm-fe' })
    expect(mocks.ensureUserDmRoom).toHaveBeenCalledWith('fe')
  })

  it('turns "no room for this agent" into an explicit refusal, not an empty success', async () => {
    mocks.ensureUserDmRoom.mockReturnValue(null)
    await expect(call('dmRoomEnsure', { agentId: 'gone' })).resolves.toEqual({
      success: false,
      error: '这个 agent 不能开私聊(已退休、不是同事,或者查无此人)',
    })
  })

  it('turns a thrown error into a failed response', async () => {
    mocks.ensureUserDmRoom.mockImplementation(() => { throw new Error('store exploded') })
    await expect(call('dmRoomEnsure', { agentId: 'fe' }))
      .resolves.toEqual({ success: false, error: 'store exploded' })
  })
})

/**
 * 清空聊天记录。次序(先停后删再播)与"到底清哪几处"全在 app 层 —— 处理者只负责
 * 把房间 id 带过去,以及把抛出来的错翻译成一次线上失败。
 */
describe('roomClearHistory', () => {
  it('carries the room id across and returns the app layer answer verbatim', async () => {
    await expect(call('roomClearHistory', { roomSessionId: 'room-1' }))
      .resolves.toEqual({ success: true, clearedMessageCount: 3 })
    // includeMemberDms 缺席时显式落 false —— 处理者归一化,不让 undefined 过河。
    expect(mocks.clearCollabRoomHistory).toHaveBeenCalledWith('room-1', { includeMemberDms: false })
  })

  it('includeMemberDms 只在显式为 true 时透传为 true', async () => {
    await call('roomClearHistory', { roomSessionId: 'room-1', includeMemberDms: true })
    expect(mocks.clearCollabRoomHistory).toHaveBeenCalledWith('room-1', { includeMemberDms: true })
  })

  it('turns a thrown error into a failed response', async () => {
    mocks.clearCollabRoomHistory.mockImplementation(() => { throw new Error('store exploded') })
    await expect(call('roomClearHistory', { roomSessionId: 'room-1' }))
      .resolves.toEqual({ success: false, error: 'store exploded' })
  })
})

describe('coordinatorGet', () => {
  it('「不是房间」是一次明确的失败,不是一份空快照', async () => {
    await expect(call('coordinatorGet', { roomSessionId: 'chat-1' }))
      .resolves.toEqual({ success: false, error: 'Not a room session' })

    mocks.getCollabCoordinatorState.mockReturnValue({ floorEpoch: 3 })
    await expect(call('coordinatorGet', { roomSessionId: 'room-1' }))
      .resolves.toEqual({ success: true, state: { floorEpoch: 3 } })
  })
})

describe('roomFolderList', () => {
  it('把列目录的结果摊进信封(folder / entries / missing / truncated)', async () => {
    mocks.listCollabRoomFolder.mockReturnValue({ folder: '/rooms/room-1', entries: [], missing: true })
    await expect(call('roomFolderList', { roomSessionId: 'room-1' }))
      .resolves.toEqual({ success: true, folder: '/rooms/room-1', entries: [], missing: true })
  })

  it('turns a thrown error into a failed response', async () => {
    mocks.listCollabRoomFolder.mockImplementation(() => { throw new Error('fs exploded') })
    await expect(call('roomFolderList', { roomSessionId: 'room-1' }))
      .resolves.toEqual({ success: false, error: 'fs exploded' })
  })
})

describe('roomSpendGet', () => {
  it('原样回 app 层算出的那份账(读账本是它自己的事)', async () => {
    mocks.getCollabRoomSpend.mockReturnValue({ success: true, spentTodayUSD: 1.5, dailyCostUSD: 10 })
    await expect(call('roomSpendGet', { roomSessionId: 'room-1' }))
      .resolves.toEqual({ success: true, spentTodayUSD: 1.5, dailyCostUSD: 10 })
  })
})

/**
 * Agent 活动快照的冷启动补水(D8 观测体系 §3.1)。
 *
 * 同一条整体透传纪律 —— 这扇门只有一格(`agentIds`),而「缺席等于全要」是 app 层
 * 的语义,处理者一个字都不该替它做主。下面那条穷尽性钉的就是这件事:shared 请求
 * 类型加一格而中转没跟上,编译当场红。
 */
describe('agentActivityGet (D8 O1)', () => {
  const ACTIVITY = {
    agentId: 'iris',
    seq: 3,
    at: 1_000,
    mind: { state: 'idle' as const },
    heldLeases: [],
    inbox: { depth: 0 },
    workers: [],
    deadLetterCount: 0,
  }

  it('把请求里那几位带过去,回一份快照数组', async () => {
    mocks.getCollabAgentActivity.mockReturnValue([ACTIVITY])
    await expect(call('agentActivityGet', { agentIds: ['iris'] }))
      .resolves.toEqual({ success: true, activities: [ACTIVITY] })
    expect(mocks.getCollabAgentActivity).toHaveBeenCalledWith(['iris'])
  })

  it('`agentIds` 缺席就是缺席 —— 处理者不替 app 层决定它等于什么', async () => {
    await call('agentActivityGet', {})
    expect(mocks.getCollabAgentActivity).toHaveBeenCalledWith(undefined)
    // 连整个 payload 都没有也一样(信封化之后 payload 一定在,但发一个 undefined
    // 的调用方仍然存在 —— daemon / 测试)。
    await call('agentActivityGet')
    expect(mocks.getCollabAgentActivity).toHaveBeenLastCalledWith(undefined)
  })

  it('空数组原样过河,不被兜回"全要"', async () => {
    await call('agentActivityGet', { agentIds: [] })
    expect(mocks.getCollabAgentActivity).toHaveBeenCalledWith([])
  })

  it('turns a thrown error into a failed response', async () => {
    mocks.getCollabAgentActivity.mockImplementation(() => { throw new Error('runtime exploded') })
    await expect(call('agentActivityGet', { agentIds: ['iris'] }))
      .resolves.toEqual({ success: false, error: 'runtime exploded' })
  })

  /** 同一条 keyof 穷尽纪律:请求类型的每一格都到得了 app 层。 */
  it('shared 请求的每个键都到得了 app 层(keyof 穷尽)', async () => {
    const request: Record<keyof CollabAgentActivityGetRequest, unknown> = {
      agentIds: ['iris', 'bram'],
    }
    await call('agentActivityGet', request)
    expect(mocks.getCollabAgentActivity).toHaveBeenCalledWith(['iris', 'bram'])
  })
})

describe('schedulerLogTail (D8 §3.3)', () => {
  it('缺 roomSessionId 时当场拒绝,不去读账', async () => {
    await expect(call('schedulerLogTail', {}))
      .resolves.toEqual({ success: false, error: 'Missing roomSessionId' })
    expect(mocks.readCollabSchedulerLogTail).not.toHaveBeenCalled()
  })

  it('limit / types 缺席就是缺席 —— 缺省交给读账函数自己', async () => {
    await call('schedulerLogTail', { roomSessionId: 'room-1' })
    expect(mocks.readCollabSchedulerLogTail).toHaveBeenCalledWith('room-1', {})

    await call('schedulerLogTail', { roomSessionId: 'room-1', limit: 40, types: ['wave'] })
    expect(mocks.readCollabSchedulerLogTail)
      .toHaveBeenLastCalledWith('room-1', { limit: 40, types: ['wave'] })
  })

  it('空 types 不过河(空数组等于「全要」,不是「一个都不要」)', async () => {
    await call('schedulerLogTail', { roomSessionId: 'room-1', types: [] })
    expect(mocks.readCollabSchedulerLogTail).toHaveBeenCalledWith('room-1', {})
  })
})

/**
 * 人级停止(E5)—— 三级停止的第三级。
 *
 * 这扇门的三格全是**地址**(哪间房、哪张牌、界面看见它时是第几代),而
 * `expectedEpoch` 那道乐观并发前置属于 app 层。所以这里钉两件事:整体透传
 * (处理者一个字段都不该拆开或抢先判)、以及失败原因**不被翻译成 error**
 * —— `epoch-stale` / `not-found` / `not-a-room` 三条都是可操作的结果,把它们
 * 塞进 `error` 就等于让界面对着一句人话去做分支。
 */
describe('roomRevokeLease (E5 人级停止)', () => {
  it('请求原样过河,结果原样回来', async () => {
    await expect(call('roomRevokeLease', {
      roomSessionId: 'room-1',
      leaseId: 'room-1#L2',
      expectedEpoch: 7,
    })).resolves.toEqual({ success: true, result: { ok: true, revoked: true } })
    expect(mocks.revokeCollabRoomLease).toHaveBeenCalledWith({
      roomSessionId: 'room-1',
      leaseId: 'room-1#L2',
      expectedEpoch: 7,
    })
  })

  it('可操作的失败原因原样回给界面,不被翻译成 error', async () => {
    mocks.revokeCollabRoomLease.mockResolvedValue({ ok: false, reason: 'epoch-stale', epoch: 9 })
    await expect(call('roomRevokeLease', { roomSessionId: 'room-1', leaseId: 'L1', expectedEpoch: 7 }))
      .resolves.toEqual({ success: true, result: { ok: false, reason: 'epoch-stale', epoch: 9 } })
  })

  it('真异常才走 error(运行时炸了,不是一次可操作的拒绝)', async () => {
    mocks.revokeCollabRoomLease.mockRejectedValue(new Error('runtime exploded'))
    await expect(call('roomRevokeLease', { roomSessionId: 'room-1', leaseId: 'L1', expectedEpoch: 7 }))
      .resolves.toEqual({ success: false, error: 'runtime exploded' })
  })

  /** 同一条 keyof 穷尽纪律:请求类型的每一格都到得了 app 层。 */
  it('shared 请求的每个键都到得了 app 层(keyof 穷尽)', async () => {
    const request: Record<keyof CollabRoomRevokeLeaseRequest, unknown> = {
      roomSessionId: 'room-1',
      leaseId: 'room-1#L4',
      expectedEpoch: 3,
    }
    await call('roomRevokeLease', request)
    expect(mocks.revokeCollabRoomLease).toHaveBeenCalledWith(request)
  })
})

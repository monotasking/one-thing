/**
 * D6-b 的**装配级**测试:v2 调度链删掉之后,那几扇配置门还站在原地吗。
 *
 * `room-config.ts` 里的每一个函数都是从 `coordinator.ts` 搬过来的,搬家本身不该
 * 改行为 —— 但它们的**执行方**全换了:喊停从「按 activeTurns 逐条 abort」换成
 * 租约换代,停活从协调器的 `activeByTask` 换成各位同事账里的子清单,清历史里
 * 那本 v2 内存账整个换成了房账。所以这份测试问的不是「函数还在不在」,而是
 * **「同一个用户动作,在新执行方上还落到同样的结果吗」**。
 *
 * 五组,对应 D6-b 交付面 + D6 补口:
 *
 *  1. **清空历史全链** —— 六处一起归零,先停后删,不是房就拒;
 *  2. **卡级停止的读口与停口**(缺口①)—— 账在子清单里,停口掐的是工作会话;
 *  3. **成员变更投 `room:membership-changed`**(缺口②)—— 折叠信封里看得见;
 *  4. **冻结/恢复与预算缓存** —— 总闸掐活、抬闸续做、改额度立刻生效;
 *  5. **响应模式 → 发言策略**(缺口③)—— 改设置当场换档,关着应用改的开箱补上。
 *
 * 假件与 `runtime-wiring.test.ts` 同一套(真磁盘 + 真规则 + 剧本化端口),理由
 * 见那份的文件头:要测的正是接线,把结构替掉就什么都没测。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSessionFacadeMock } from '../../../../session/testing/facade-mock.js'

interface FakeSession {
  id: string
  name: string
  kind?: string
  agentId?: string
  isArchived?: boolean
  permissionMode?: string
  collab?: Record<string, unknown>
  room?: {
    memberAgentIds: string[]
    frozen?: boolean
    dm?: boolean
    formerMembers?: Array<{ agentId: string; removedAt: number }>
    budgets?: Record<string, number>
    responseMode?: 'auto' | 'parallel' | 'serial'
    speakOrder?: string[]
    relayLoops?: number
  }
  messages: Array<Record<string, unknown>>
}

const AGENTS: Record<string, { id: string; name: string; systemPrompt: string }> = {
  fe: { id: 'fe', name: '小李', systemPrompt: '前端' },
  pm: { id: 'pm', name: '阿明', systemPrompt: '产品' },
  qa: { id: 'qa', name: 'Iris', systemPrompt: '测试' },
}

const mocks = vi.hoisted(() => ({
  storePath: '',
  sessions: new Map<string, unknown>(),
  emitted: [] as Array<{ sessionId: string; event: Record<string, unknown> }>,
  deleteListeners: [] as Array<(ids: readonly string[]) => void>,
  aborted: [] as string[],
  cleared: [] as string[],
}))

// P0.2 ③:业务代码改走 `sessionCommands` / `sessionReads`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。这两扇门换成共用替身,
// 读写落在下面同一份假会话表上 —— 与迁移前 `store.js` 假表的语义逐条对齐。
vi.mock('../../../../session/reads.js', () => import('../../../../session/testing/facade-mock.js'))
vi.mock('../../../../session/commands.js', async () => {
  const facade = await import('../../../../session/testing/facade-mock.js')
  return {
    sessionCommands: {
      ...facade.sessionCommands,
      // 清空历史迁移前走 `store.clearSessionMessages`;命令面上是 replaceAll{clear}。
      replaceAll: async (sessionId: string, payload: { messages: unknown[]; reason: string }) => {
        const session = mocks.sessions.get(sessionId) as FakeSession | undefined
        if (!session) return { replaced: false, previousCount: 0 }
        const previousCount = session.messages.length
        session.messages.length = 0
        session.messages.push(...(payload.messages as FakeSession['messages']))
        if (payload.reason === 'clear') mocks.cleared.push(sessionId)
        return { replaced: true, previousCount }
      },
    },
  }
})
bindSessionFacadeMock((id: string) => mocks.sessions.get(id))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingStorePath: () => mocks.storePath,
}))

vi.mock('../../../usage/index.js', () => ({
  getUsageLedger: () => ({ readRecordsInRange: async () => [] }),
}))

vi.mock('../../../usage/bill-side-line.js', () => ({
  billCollabPlanUsage: () => () => {},
}))

vi.mock('../../../providers/index.js', () => ({
  generateChatResponse: async () => '',
}))

vi.mock('../../../engine/stream/provider-helpers.js', () => ({
  getEffectiveProviderConfig: () => ({ providerId: '', providerConfig: null, model: '' }),
  resolveProviderAuth: async () => null,
}))

vi.mock('../../../engine/index.js', () => ({
  getStreamEngine: () => engineStub(),
  getStreamEngineSafe: () => engineStub(),
}))

vi.mock('../../../agents/index.js', () => ({
  findAgent: (id: string) => AGENTS[id],
  listAgents: () => Object.values(AGENTS),
  displayAgent: (id: string) => AGENTS[id],
}))

vi.mock('../../../../events/index.js', () => ({
  getEventBus: () => ({
    emit: async (sessionId: string, event: Record<string, unknown>) => {
      mocks.emitted.push({ sessionId, event })
    },
    onAny: () => () => {},
    onAnySession: () => () => {},
  }),
}))

vi.mock('../../../../store.js', () => ({
  getSettings: () => ({}),
  getSession: (id: string) => mocks.sessions.get(id),
  getSessionsList: () => [...mocks.sessions.values()],
  addMessage: (sessionId: string, message: Record<string, unknown>) => {
    (mocks.sessions.get(sessionId) as FakeSession | undefined)?.messages.push(message)
  },
  clearSessionMessages: async (sessionId: string) => {
    const session = mocks.sessions.get(sessionId) as FakeSession | undefined
    if (!session) return { cleared: false, clearedCount: 0 }
    const clearedCount = session.messages.length
    session.messages.length = 0
    mocks.cleared.push(sessionId)
    return { cleared: true, clearedCount }
  },
  createSession: (id: string, name: string) => createFake(id, name),
  createSessionWithoutFocus: (id: string, name: string) => createFake(id, name),
  updateSessionCollab: (id: string, patch: Record<string, unknown>) => {
    const session = mocks.sessions.get(id) as FakeSession | undefined
    if (!session) return false
    Object.assign(session, patch)
    return true
  },
  updateSessionAgent: (id: string, agentId: string) => {
    const session = mocks.sessions.get(id) as FakeSession | undefined
    if (session) session.agentId = agentId
    return true
  },
  updateSessionArchived: () => true,
  updateSessionWorkingDirectory: () => true,
  updateSessionPermissionMode: (id: string, mode: string) => {
    const session = mocks.sessions.get(id) as FakeSession | undefined
    if (session) session.permissionMode = mode
    return true
  },
  updateMessageMentions: () => true,
  updateMessageReplyTo: () => true,
  renameSession: (id: string, name: string) => {
    const session = mocks.sessions.get(id) as FakeSession | undefined
    if (session) session.name = name
    return true
  },
  onSessionsDeleted: (listener: (ids: readonly string[]) => void) => {
    mocks.deleteListeners.push(listener)
    return () => {
      mocks.deleteListeners = mocks.deleteListeners.filter(entry => entry !== listener)
    }
  },
}))

function engineStub(): Record<string, unknown> {
  return {
    hasCommandTarget: () => true,
    getChannel: () => 'ipc',
    abort: (sessionId: string) => {
      mocks.aborted.push(sessionId)
      return true
    },
    steerMessage: () => {},
    retractSteerMessage: () => {},
  }
}

function createFake(id: string, name: string): FakeSession {
  const session: FakeSession = { id, name, messages: [] }
  mocks.sessions.set(id, session)
  return session
}

/* ── 被测模块(mock 之后再 import) ──────────────────────────────────────── */

const {
  drainCollabV3Runtime,
  hasActiveCollabV3Work,
  initializeCollabV3Runtime,
  peekCollabV3Agent,
  peekCollabV3Room,
  shutdownCollabV3Runtime,
  stopCollabV3TaskWork,
  warmCollabV3Agents,
} = await import('../runtime.js')
const {
  clearCollabRoomHistory,
  setCollabRoomBudgets,
  setCollabRoomConfig,
  setCollabRoomFrozen,
} = await import('../../room-config.js')
const { applyBoardAction, loadCollabBoard } = await import('../../board-store.js')
const { createCollabScriptedMindPort } = await import('@onething/runtime/collab/actors/mind-port')
const { createCollabScriptedWorkerPort } = await import('@onething/runtime/collab/actors/worker-child')
const { createCollabScriptedRefereeJudgePort } = await import('@onething/runtime/collab/actors/referee-actor')
const { collabAgentSessionId } = await import('@onething/runtime/collab')
const { collabRoomAccountPath } = await import('@onething/runtime/collab/actors/room-account')

const ROOM = 'room-1'
const CARD_TITLE = '把登录页的埋点补上'

function seedRoom(members: string[] = ['fe', 'pm']): FakeSession {
  const room: FakeSession = {
    id: ROOM,
    name: '产品群',
    kind: 'room',
    room: { memberAgentIds: members },
    messages: [],
  }
  mocks.sessions.set(ROOM, room)
  return room
}

/** 起一个只有心智端口的运行时(不需要手的用例走这条)。 */
async function bootRuntime(): Promise<void> {
  await initializeCollabV3Runtime({
    ports: {
      mind: createCollabScriptedMindPort([]),
      judge: createCollabScriptedRefereeJudgePort([{ roomId: ROOM, grants: [] }]),
    },
  })
  await warmCollabV3Agents()
}

/**
 * 等一个**异步副作用**落地。
 *
 * 两扇配置门(改名册、抬总闸)是**同步**的:它们答复调用方之后才 `void` 出去投
 * 一封信 / 派一只手。这是刻意的设计(一次广播不该把设置保存变成 async),代价
 * 是测试这边不能用"固定睡一拍"—— 机器一忙那一拍就不够,于是用例在并行跑的时候
 * 变成薛定谔的。这里改成**轮询到条件成立**,顺带每圈 drain 一次把环推到底。
 */
async function waitFor(predicate: () => boolean, rounds = 50): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
    await drainCollabV3Runtime()
  }
  expect(predicate()).toBe(true)
}

function roomEvents(type: string): Array<Record<string, unknown>> {
  return mocks.emitted.filter(entry => entry.event.type === type).map(entry => entry.event)
}

beforeEach(() => {
  mocks.storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-v3-roomcfg-'))
  mocks.sessions.clear()
  mocks.emitted.length = 0
  mocks.deleteListeners.length = 0
  mocks.aborted.length = 0
  mocks.cleared.length = 0
})

afterEach(async () => {
  await shutdownCollabV3Runtime()
  await new Promise(resolve => setTimeout(resolve, 0))
  fs.rmSync(mocks.storePath, { recursive: true, force: true })
})

/* ── ① 清空历史 ───────────────────────────────────────────────────────── */

describe('清空历史:六处一起归零', () => {
  it('房间转录、成员执行会话、看板、房账水位一起清,并各播一条 messages:replaced', async () => {
    seedRoom()
    await bootRuntime()

    // 房间里有历史,两位成员各有一条按房 scoped 的执行会话。
    const room = mocks.sessions.get(ROOM) as FakeSession
    room.messages.push({ id: 'm1', role: 'user', content: '先聊两句', timestamp: 1 })
    for (const agentId of ['fe', 'pm']) {
      const execId = collabAgentSessionId(agentId, ROOM)!
      const exec = createFake(execId, `${agentId} · 产品群`)
      exec.kind = 'agent'
      exec.agentId = agentId
      exec.messages.push({ id: `x-${agentId}`, role: 'assistant', content: '旧的', timestamp: 1 })
    }
    // 看板上挂着一张卡 —— 清空要连它一起带走,否则同事下一句就在谈一段谁都
    // 读不到的工作(`getCollabSelfTaskFacts` 把 doing/blocked 当既成事实注入)。
    await applyBoardAction(ROOM, { action: 'create', title: CARD_TITLE }, { type: 'user' })
    expect(loadCollabBoard(ROOM).tasks).toHaveLength(1)

    const result = await clearCollabRoomHistory(ROOM)

    expect(result.success).toBe(true)
    expect(result.clearedMessageCount).toBe(1)
    expect(result.clearedSessionCount).toBe(2)
    expect(result.clearedTaskCount).toBe(1)
    // ① 房间转录 ② 两条执行会话
    expect(room.messages).toHaveLength(0)
    expect(mocks.cleared).toEqual(expect.arrayContaining([
      ROOM,
      collabAgentSessionId('fe', ROOM)!,
      collabAgentSessionId('pm', ROOM)!,
    ]))
    // ③ 看板
    expect(loadCollabBoard(ROOM).tasks).toEqual([])
    // ④ 房账整个换新 —— 少这一步,清空后的第一个回合会带着旧水位跑:模型读到的
    //    「未读」是空的,而房间以为讨论已经进行到第 6 轮。
    const after = JSON.parse(fs.readFileSync(collabRoomAccountPath(ROOM), 'utf-8')) as {
      watermark: { messageId?: string }
      chainCount: number
      hands: unknown[]
      floor: { active: unknown[] }
    }
    expect(after.watermark.messageId).toBeUndefined()
    expect(after.chainCount).toBe(0)
    expect(after.hands).toEqual([])
    expect(after.floor.active).toEqual([])
    // ⑤ 渲染层:房间与每条执行会话各一条 messages:replaced(复用编辑重发那条路)。
    const replaced = mocks.emitted
      .filter(entry => entry.event.type === 'messages:replaced')
      .map(entry => entry.sessionId)
    expect(replaced).toEqual(expect.arrayContaining([
      ROOM,
      collabAgentSessionId('fe', ROOM)!,
      collabAgentSessionId('pm', ROOM)!,
    ]))
  })

  it('不是房间会话就拒掉,一个字都不删', async () => {
    createFake('chat-1', '直聊').messages.push({ id: 'k', role: 'user', content: '在', timestamp: 1 })
    await bootRuntime()

    const result = await clearCollabRoomHistory('chat-1')
    expect(result).toEqual({ success: false, error: 'Not a room session' })
    expect((mocks.sessions.get('chat-1') as FakeSession).messages).toHaveLength(1)
    expect(mocks.cleared).toEqual([])
  })

  /**
   * 「先停后删」是强制次序:不先停,一个在飞回合的收尾会往刚清空的会话里写。
   *
   * v2 那侧停的是 `activeTurns`;v3 停的是租约(换代 + 撤牌 + 掐流)。这里钉的
   * 是**结果**:清空跑完之后,这间房的租约代数已经往前走了 —— 也就是在外的每
   * 一张牌都作废了。
   */
  it('先停后删:清空跑完时租约已换代,而且代数**留着**没归零', async () => {
    seedRoom()
    await bootRuntime()
    const epochBefore = peekCollabV3Room(ROOM)?.account.floor.epoch ?? 0

    await clearCollabRoomHistory(ROOM)

    // 账整个换新之后循环也停了(`resetRoomAccount` 把 actor 摘掉),所以读的是
    // **磁盘上那份新账**,而不是一个已经不在表里的 actor。
    const saved = JSON.parse(fs.readFileSync(collabRoomAccountPath(ROOM), 'utf-8')) as {
      floor: { epoch: number; active: unknown[] }
      chainCount: number
      watermark: { messageId?: string }
    }
    // 代数 +1 而**不是归零**(v2 那条纪律逐字保留):归零的话,一条在飞回合收尾
    // 时盖上 0 号世代的动作会被判成"当前的",于是它开口说的第一句话落进一间
    // 刚被清空的房 —— 这正是清空前那次换代要阻止的事。
    expect(saved.floor.epoch).toBeGreaterThan(epochBefore)
    expect(saved.floor.active).toEqual([])
    expect(saved.chainCount).toBe(0)
    expect(saved.watermark.messageId).toBeUndefined()
  })
})

/* ── ② 卡级停止:读口与停口(缺口①) ─────────────────────────────────── */

describe('卡级停止:账在子清单里(D6-b 缺口①)', () => {
  /**
   * 起一只**挂住的**手,好让 `hasActiveCollabWork` 有东西可读。
   *
   * 派生走的是生产那条路(`resumeCollabV3RoomWork` → `agent:spawn-worker`),
   * 不是直接往账里塞一条记录:要验的正是「账真的被派手写进去了」。
   */
  async function startHeldWorker(): Promise<{ cardId: string; worker: ReturnType<typeof createCollabScriptedWorkerPort> }> {
    const worker = createCollabScriptedWorkerPort([])
    worker.hold()
    await initializeCollabV3Runtime({
      ports: {
        mind: createCollabScriptedMindPort([]),
        judge: createCollabScriptedRefereeJudgePort([{ roomId: ROOM, grants: [] }]),
        worker,
      },
    })
    await warmCollabV3Agents()

    const created = await applyBoardAction(
      ROOM,
      { action: 'create', title: CARD_TITLE, assigneeAgentId: 'fe', status: 'todo' },
      { type: 'user' },
    )
    const cardId = created.task!.id
    // 总闸抬起那条路 = 「把搁浅的卡重新派出去」,它与 `task-started` 走同一个
    // 派生口,所以用它起手最接近真机。
    const { resumeCollabV3RoomWork } = await import('../runtime.js')
    await resumeCollabV3RoomWork(ROOM)
    await new Promise(resolve => setTimeout(resolve, 0))
    return { cardId, worker }
  }

  it('读口:一只在飞的手数得着,收工之后就数不着了', async () => {
    seedRoom()
    const { cardId, worker } = await startHeldWorker()

    expect(hasActiveCollabV3Work(cardId)).toBe(true)
    // 账在**派这只手的那位同事**身上,不在某张进程内的全局表里 —— 这是 v3 相对
    // v2 的结构差别,也是它能活过重启的原因。
    expect(peekCollabV3Agent('fe')?.account.workers.some(
      record => record.cardId === cardId && record.status === 'running',
    )).toBe(true)

    // 不存在的卡永远是 false(按钮不该出现在那儿)。
    expect(hasActiveCollabV3Work('nope')).toBe(false)

    worker.release()
    await drainCollabV3Runtime()
    // 监护任务把子清单里那条记录改成收尾,要再让出一次执行权(它刻意不在心智
    // 循环里跑 —— 并行豁免的落点,见 `worker-child.ts` 文件头)。
    await new Promise(resolve => setTimeout(resolve, 0))
    await drainCollabV3Runtime()
    expect(hasActiveCollabV3Work(cardId)).toBe(false)
  })

  it('停口:掐工作会话的流 + 卡回 todo + 群里留一行说明', async () => {
    seedRoom()
    const { cardId } = await startHeldWorker()
    const room = mocks.sessions.get(ROOM) as FakeSession
    mocks.aborted.length = 0
    room.messages.length = 0

    const stopped = await stopCollabV3TaskWork(ROOM, cardId)
    expect(stopped).toBe(true)

    // 卡放回可续做的待办(不是 blocked —— 「停止执行」与「标受阻」是两件事)。
    expect(loadCollabBoard(ROOM).tasks[0]?.status).toBe('todo')
    // 掐的是**工作会话**那条流,不是房间流:停一张卡不该让同房的对话跟着断。
    expect(mocks.aborted).not.toContain(ROOM)
    // 群里有一行说明,而且是任务行档(它要进模型投影)。
    const line = room.messages.find(message => message.role === 'system')
    expect(String(line?.content ?? '')).toContain(CARD_TITLE)
  })

  it('这张卡没有在跑的执行时返回 false —— 按钮不该出现在那儿', async () => {
    seedRoom()
    await bootRuntime()
    const created = await applyBoardAction(
      ROOM,
      { action: 'create', title: CARD_TITLE, assigneeAgentId: 'fe' },
      { type: 'user' },
    )
    expect(await stopCollabV3TaskWork(ROOM, created.task!.id)).toBe(false)
    // 房不对也是 false(同一张卡 id 不会跨房,但「停这间房的这张卡」是调用方的原话)。
    expect(await stopCollabV3TaskWork('room-other', created.task!.id)).toBe(false)
  })
})

/* ── ③ 成员变更投递(缺口②) ─────────────────────────────────────────── */

describe('成员变更投 room:membership-changed(D6-b 缺口②)', () => {
  /**
   * 群公告是给**人**看的(转录里那一行),折叠信封是给**模型**看的。
   *
   * 少了后者的结果是:同事在名册已经变了之后还会 @ 一个上周就离开的人 —— 那件
   * 事从来没有出现在它的上下文里。协议动词与折叠都早就有了,D6-a 之前缺的一直
   * 是**生产者**。
   */
  it('加人/移人 → 在册成员的折叠素材里看得见「谁来了谁走了」', async () => {
    seedRoom(['fe', 'pm'])
    await bootRuntime()

    const result = setCollabRoomConfig(ROOM, { memberAgentIds: ['fe', 'pm', 'qa'] })
    expect(result.success).toBe(true)
    // 房间落了账并把动词播给在册成员;每位同事把它折进自己的下一轮信封。
    // 折的是**条数**而不是名字(`envelope-fold.ts`:信封是一句「谁来了谁走了」,
    // 不是一份名册 —— 名册在提示词的花名册那一段,现取,不必在这里抄一份)。
    const joinedFold = () => (peekCollabV3Agent('fe')?.account.fold ?? [])
      .some(entry => entry.kind === 'members' && entry.joined === 1 && entry.left === 0)
    await waitFor(joinedFold)

    // 群公告那一行照旧在转录里(两条路都要有,它们服务不同的读者)。
    const room = mocks.sessions.get(ROOM) as FakeSession
    expect(room.messages.some(message => String(message.content ?? '').includes('Iris'))).toBe(true)
  })

  it('只改房名/预算不投信 —— 空变更不该在每个人的信封里留一条噪声', async () => {
    seedRoom(['fe', 'pm'])
    await bootRuntime()
    const before = (peekCollabV3Agent('fe')?.account.fold ?? []).length

    expect(setCollabRoomConfig(ROOM, { name: '改个名字' }).success).toBe(true)
    // 名册**集合相等**:换个顺序不算改,同样不该投信。
    expect(setCollabRoomConfig(ROOM, { memberAgentIds: ['pm', 'fe'] }).success).toBe(true)
    // 负面断言给足时间:要证的是"投不出来",睡得太短就变成"还没投出来"。
    for (let round = 0; round < 5; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
      await drainCollabV3Runtime()
    }

    expect((peekCollabV3Agent('fe')?.account.fold ?? []).length).toBe(before)
  })

  it('私聊房的名册改不动 —— 防线画在这里,不在界面上', async () => {
    const dm: FakeSession = {
      id: 'agent-dm-room-fe--pm',
      name: '小李 ⇄ 阿明',
      kind: 'room',
      room: { memberAgentIds: ['fe', 'pm'], dm: true },
      messages: [],
    }
    mocks.sessions.set(dm.id, dm)
    await bootRuntime()

    const result = setCollabRoomConfig(dm.id, { memberAgentIds: ['fe', 'qa'] })
    expect(result.success).toBe(false)
    expect(result.error).toContain('私聊的成员不能改')
    expect(dm.room?.memberAgentIds).toEqual(['fe', 'pm'])
  })
})

/* ── ④ 冻结 / 恢复 / 预算 ─────────────────────────────────────────────── */

describe('总闸与预算', () => {
  it('冻结:落盘 frozen + 换代撤牌 + 群里说一次 + 播房间快照', async () => {
    seedRoom()
    await bootRuntime()
    const room = mocks.sessions.get(ROOM) as FakeSession
    const epochBefore = peekCollabV3Room(ROOM)?.account.floor.epoch ?? 0
    mocks.emitted.length = 0

    expect(setCollabRoomFrozen(ROOM, true)).toBe(true)

    expect(room.room?.frozen).toBe(true)
    expect(peekCollabV3Room(ROOM)?.account.floor.epoch).toBeGreaterThan(epochBefore)
    expect(room.messages.some(message => String(message.content ?? '').includes('房间已全部暂停'))).toBe(true)
    // `frozen` 是会话列表读的房间字段(看板面板的暂停开关),所以同时播一份快照。
    expect(roomEvents('session:collab-updated')).not.toHaveLength(0)
  })

  it('恢复:抬闸之后把冻结搁浅的卡重新派出去', async () => {
    seedRoom()
    const worker = createCollabScriptedWorkerPort([])
    worker.hold()
    await initializeCollabV3Runtime({
      ports: {
        mind: createCollabScriptedMindPort([]),
        judge: createCollabScriptedRefereeJudgePort([{ roomId: ROOM, grants: [] }]),
        worker,
      },
    })
    await warmCollabV3Agents()
    // 一张指派了人、还没有人在做的卡 —— 正是冻结会搁浅的那一种。
    const created = await applyBoardAction(
      ROOM,
      { action: 'create', title: CARD_TITLE, assigneeAgentId: 'fe', status: 'todo' },
      { type: 'user' },
    )
    const cardId = created.task!.id
    expect(hasActiveCollabV3Work(cardId)).toBe(false)

    setCollabRoomFrozen(ROOM, false)
    await waitFor(() => hasActiveCollabV3Work(cardId))
    worker.release()
    await drainCollabV3Runtime()
  })

  it('改预算:取值校验 + 落盘 + 播快照;非法值原样忽略', async () => {
    seedRoom()
    await bootRuntime()
    const room = mocks.sessions.get(ROOM) as FakeSession
    mocks.emitted.length = 0

    expect(setCollabRoomBudgets(ROOM, {
      dailyCostUSD: 12,
      maxChain: 40,
      maxConcurrentTurns: 0,
      // 负数不是一个有意义的上限:形状由类型保证,**取值**由这扇门保证。
      maxTurnToolCalls: -1,
    })).toBe(true)

    expect(room.room?.budgets).toMatchObject({
      dailyCostUSD: 12,
      maxChain: 40,
      maxConcurrentTurns: 0,
    })
    expect(room.room?.budgets?.maxTurnToolCalls).toBeUndefined()
    expect(roomEvents('session:collab-updated')).not.toHaveLength(0)
  })

  it('不是房间会话:三扇门一致地拒掉', async () => {
    createFake('chat-1', '直聊')
    await bootRuntime()
    expect(setCollabRoomFrozen('chat-1', true)).toBe(false)
    expect(setCollabRoomBudgets('chat-1', { dailyCostUSD: 1 })).toBe(false)
    expect(setCollabRoomConfig('chat-1', { name: 'x' })).toEqual({
      success: false,
      error: 'Not a room session',
    })
  })
})

/* ── ⑤ 响应模式 → 发言策略(D6 接线遗漏的补口) ───────────────────────── */

/**
 * `responseMode` 三件套在 D6 之后一度**没有消费者**:房账新建一律 `free`,换档的
 * 唯一动词零发出口,于是「接力」这个开关在 v3 是死的
 * (docs/audit/collab-v3-walkthrough-2026-08-03 §1.4)。这一组钉的是两个生效点在
 * **装配级**上真的接上了:改设置立刻换档,以及关着应用改的设置在开箱时补上。
 */
describe('响应模式 → 发言策略(D6 接线)', () => {
  it('改成 serial:房账当场换到接力档,speakOrder 进环序', async () => {
    seedRoom(['fe', 'pm', 'qa'])
    await bootRuntime()

    expect(peekCollabV3Room(ROOM)?.account.policy.name).toBe('free')

    expect(setCollabRoomConfig(ROOM, {
      responseMode: 'serial',
      speakOrder: ['qa', 'fe', 'pm'],
      relayLoops: 2,
    })).toEqual({ success: true })

    // 换档是 `void` 出去的(设置保存对调用方是同步的),所以轮询到它落地。
    await waitFor(() => peekCollabV3Room(ROOM)?.account.policy.name === 'ring')
    expect(peekCollabV3Room(ROOM)?.account.policy.params).toEqual({
      order: ['qa', 'fe', 'pm'],
      relayLoops: 2,
    })
  })

  it('改回 parallel:退回 free 档', async () => {
    const room = seedRoom(['fe', 'pm'])
    room.room!.responseMode = 'serial'
    await bootRuntime()
    await waitFor(() => peekCollabV3Room(ROOM)?.account.policy.name === 'ring')

    setCollabRoomConfig(ROOM, { responseMode: 'parallel' })
    await waitFor(() => peekCollabV3Room(ROOM)?.account.policy.name === 'free')
  })

  it('开箱时补:应用关着的时候改的设置,在房间开箱那一刻进账', async () => {
    const room = seedRoom(['fe', 'pm'])
    room.room!.responseMode = 'auto'
    await bootRuntime()
    // 没有任何一次 `setCollabRoomConfig` —— 这一档只可能来自开箱那一步。
    await waitFor(() => peekCollabV3Room(ROOM)?.account.policy.name === 'waves')
  })

  it('只改房名不动响应模式:一次换档都不发生(游标不该被无关的设置清掉)', async () => {
    const room = seedRoom(['fe', 'pm'])
    room.room!.responseMode = 'serial'
    await bootRuntime()
    await waitFor(() => peekCollabV3Room(ROOM)?.account.policy.name === 'ring')
    const seq = peekCollabV3Room(ROOM)!.account.seq

    setCollabRoomConfig(ROOM, { name: '新名字' })
    await drainCollabV3Runtime()
    await new Promise(resolve => setTimeout(resolve, 5))

    expect(peekCollabV3Room(ROOM)?.account.policy.name).toBe('ring')
    expect(peekCollabV3Room(ROOM)?.account.seq).toBe(seq)
  })
})

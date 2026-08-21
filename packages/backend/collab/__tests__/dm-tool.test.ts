/**
 * `send_message` **私聊档**的执行器(docs/design/agent-im-dm.md D5/§3.4;
 * collab-send-channel-and-wake.md §2.2 合并进统一发送面之后,`dm` 不再是工具)。
 *
 * 纯规则测不到、只有在 store 边界上才成立的四件事:
 *  1. 成功路径的两步都是**既有链路**:建房(ensureAgentDmRoom)→ 用 say 的执行器
 *     落库(显式指定房间,于是转义/白名单/幂等窗全继承)。第三步「激活对方」
 *     自 D6-b 起归房间:执行器只负责给注入盖 `chainReset` 标记;
 *  2. 每一种拒绝都说清是哪一种(退休 ≠ service ≠ 查无此人 ≠ 自己),因为模型
 *     要据此改做别的事;
 *  3. 拒绝时**不建房**、不落消息 —— 一次失败的 dm 不该在侧栏留下一间
 *     空房;
 *  4. say 侧的拒绝(冻结/超预算)原样透传,措辞一个字不改写。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COLLAB_SAY_REFUSED_EMPTY } from '@onething/runtime/collab'
import { createSendMessageTool, ZodValidator } from '@onething/runtime/toolkit'
import { Decision, ToolRunner } from '@onething/core/toolkit'

interface FakeSession {
  id: string
  name: string
  kind?: string
  agentId?: string
  room?: { memberAgentIds?: string[]; dm?: boolean }
  collab?: { roomSessionId?: string }
  messages: unknown[]
}

const AGENTS: Record<string, { id: string; name: string; kind?: string; status?: string }> = {
  fe: { id: 'fe', name: '小李' },
  pm: { id: 'pm', name: '阿明' },
  dj: { id: 'dj', name: '电台 DJ', kind: 'service' },
  gone: { id: 'gone', name: '老王', status: 'retired' },
}

const mocks = vi.hoisted(() => ({
  /** 「我的资料」。缺省为空 —— 也就是「用户」/`user` 那条兜底链。 */
  settings: { general: {} } as { general: { userProfile?: Record<string, string> } },
  sessions: new Map<string, unknown>(),
  created: [] as string[],
  currentSessionId: 'chat-user-was-here',
  said: [] as Array<{ sessionId: string; content: string; room?: string }>,
  sayResult: { ok: true, messageId: 'msg-1' } as { ok: boolean; messageId?: string; error?: string },
  /** 房间 runtime(链闸状态)—— 跨房 dm 注入要把它清零。 */
  /** 登记下来的跨房唤醒(设计 §3.2)。 */
  wakes: [] as Array<Record<string, string>>,
}))

vi.mock('../../store.js', () => ({
  getSettings: () => mocks.settings,
  getSession: (id: string) => mocks.sessions.get(id),
  createSession: (id: string, name: string) => {
    const session: FakeSession = { id, name, messages: [] }
    mocks.sessions.set(id, session)
    mocks.created.push(id)
    mocks.currentSessionId = id
    return session
  },
  // 幕后建会话走"不动 current 指针"的那个变体:真实 store 里它建完把指针原样
  // 还原,所以这里就是"会话建了、指针没动"。
  createSessionWithoutFocus: (id: string, name: string) => {
    const session: FakeSession = { id, name, messages: [] }
    mocks.sessions.set(id, session)
    mocks.created.push(id)
    return session
  },
  getCurrentSessionId: () => mocks.currentSessionId,
  setCurrentSessionId: (id: string) => { mocks.currentSessionId = id },
  updateSessionAgent: vi.fn(),
  updateSessionCollab: (
    id: string,
    fields: { kind?: string | null; room?: FakeSession['room'] | null },
  ) => {
    const session = mocks.sessions.get(id) as FakeSession | undefined
    if (!session) return false
    if (fields.kind !== undefined) session.kind = fields.kind ?? undefined
    if (fields.room !== undefined) session.room = fields.room ?? undefined
    return true
  },
  renameSession: (id: string, name: string) => {
    const session = mocks.sessions.get(id) as FakeSession | undefined
    if (session) session.name = name
  },
  updateSessionArchived: vi.fn(),
}))

vi.mock('../../wiring/agents/index.js', () => ({
  findAgent: (id: string) => AGENTS[id] ?? null,
  // 句柄解析(collab-agent-handle.md §2.4)按**全体同事**找人 —— dm 的对象是
  // 同事,不是某间房的室友。
  listAgents: () => Object.values(AGENTS),
}))

vi.mock('../say-tool.js', () => ({
  speakIntoCollabRoom: async (input: { sessionId: string; content: string; room?: string }) => {
    mocks.said.push(input)
    return mocks.sayResult
  },
}))

vi.mock('../wake-followup.js', () => ({
  registerCollabWakeFollowup: (input: Record<string, string>) => {
    mocks.wakes.push(input)
  },
}))

vi.mock('../room-runtime.js', () => ({
  // 私聊房的形状修复分支会播一条 `session:collab-updated`(架构收敛 C4 §3)。
  // 这一面钉的是"发不发得出去",不是那条推送 —— 收进空实现即可。
  emitCollabRoomUpdated: () => {},
}))

const { sendCollabDm } = await import('../dm-tool.js')

/**
 * 契约层的那一半:合并后的发送面(设计 §2.2)。私聊不再有自己的工具,它是
 * `send_message` 带 `to` 的那一支 —— 回执与拒绝透传只能从这里进。
 *
 * 适配器在这里自己接一次,而不是从 `app/toolkit/adapters.ts` 取现成那一份:
 * `../say-tool.js` 在本文件里被 mock 掉了(挡的是落库那一条)。形状与
 * `adapters.ts` 里那一份逐字相同。房间档在这个文件里不该被走到,所以它的适配器
 * 只负责让"走错了链路"变成一个显眼的失败。
 */
const sendMessageTool = createSendMessageTool({
  sessionKind: (sessionId: string) => (mocks.sessions.get(sessionId) as FakeSession | undefined)?.kind,
  sessionAgentId: (sessionId: string) => (mocks.sessions.get(sessionId) as FakeSession | undefined)?.agentId,
  speak: async () => ({ ok: false, error: '这个文件只测私聊档' }),
  sendDm: input => sendCollabDm({
    sessionId: input.sessionId,
    to: input.to,
    message: input.content,
    ...(input.wake ? { wake: true } : {}),
    ...(input.wakeRoom ? { wakeRoom: input.wakeRoom } : {}),
  }),
})

/**
 * R4b:旧 `SayTool.execute(args, ctx)` 随旧树删除。同一条链现在走 `ToolRunner`
 * (与真回合逐字同路),回执文本与 metadata 从 `Outcome` 取。
 */
async function send(sessionId: string, input: Record<string, unknown>) {
  // 标题在新树里走 `annotate` 事件(旧路是 `ToolResult.title`),所以从观察者取。
  const titles: string[] = []
  const runner = new ToolRunner({
    authorizer: { async decide() { return Decision.allow() } },
    observer: {
      on: (_invocation, event) => {
        if (event.type === 'annotate' && event.title !== undefined) titles.push(event.title)
      },
    },
    validator: new ZodValidator(),
  })
  const outcome = await runner.run(sendMessageTool, {
    callId: 'call-1',
    toolId: 'send_message',
    input,
    sessionId,
    messageId: 'm-1',
    principal: undefined as never,
  })
  if (outcome.kind !== 'ok') throw new Error(`unexpected outcome: ${outcome.kind}`)
  return {
    output: outcome.result.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n'),
    metadata: (outcome.result.details ?? {}) as Record<string, unknown>,
    title: titles.at(-1) ?? '',
  }
}

const EXEC = 'agent-exec-fe-room-1'
const PAIR_ROOM = 'agent-dm-room-fe--pm'
/** 托管私聊房的 id 从 agentId 派生(`userDmRoomId`),所以这里是常量。 */
const USER_ROOM = 'agent-dm-fe'

beforeEach(() => {
  mocks.sessions.clear()
  mocks.created.length = 0
  mocks.said.length = 0
  mocks.wakes.length = 0
  mocks.currentSessionId = 'chat-user-was-here'
  mocks.settings = { general: {} }
  mocks.sayResult = { ok: true, messageId: 'msg-1' }
  mocks.sessions.set(EXEC, {
    id: EXEC,
    name: '小李 · 官网改版组',
    kind: 'agent',
    agentId: 'fe',
    messages: [],
  } satisfies FakeSession)
})

describe('成功路径', () => {
  it('建房 → 用 say 的执行器落进那间房(带清零标记)', async () => {
    const result = await sendCollabDm({ sessionId: EXEC, to: 'pm', message: '接口这块想跟你对一下' })

    expect(result).toEqual({
      ok: true,
      // 回执分两版(agent-dm-user.md §3.2),所以结果得说清收件人是哪一种。
      targetKind: 'agent',
      roomSessionId: PAIR_ROOM,
      messageId: 'msg-1',
      peerName: '阿明',
    })
    expect(mocks.created).toEqual([PAIR_ROOM])
    // 房间是**显式**指定的:发言落在哪间房不靠会话指针猜。
    // `chainReset` 让这条注入**自己**带着清零标记落库 —— 房间认这个标记来清链
    // (D6-b 之前执行器还会再手工清一遍内存账,那本重复的账已经删了)。
    expect(mocks.said).toEqual([
      { sessionId: EXEC, content: '接口这块想跟你对一下', room: PAIR_ROOM, chainReset: true },
    ])
  })

  /**
   * 跨房 dm 注入 = 外部输入 → 这间 pair 房的链长清零
   * (collab-turn-protocol-and-identity.md C)。
   *
   * 链闸解冻此前只认一条**人类**消息,而 agent ⇄ agent 的房里没有人类:狼人杀
   * 夜间流程冻在上限上,谁都解不开。
   *
   * **D6-b 起这件事整个归房间**:执行器唯一的动作就是给这条注入盖上
   * `chainReset` 标记,RoomActor 收到带标记的 posted 之后自己清链、按 @ 发牌、
   * 给对端投信。此前执行器还手工改一遍内存里的 `chainCount` 并显式入队 ——
   * 两本账写同一间房的链数,那正是 v3 要终结的病,随 v2 调度链一起删了。
   * 这里因此只钉**标记**:它是执行器这一侧唯一还负责的那一半。
   */
  it('跨房注入盖清零标记,清链与激活都交给房间', async () => {
    await sendCollabDm({ sessionId: EXEC, to: 'pm', message: '换个话题' })

    expect(mocks.said).toEqual([
      { sessionId: EXEC, content: '换个话题', room: PAIR_ROOM, chainReset: true },
    ])
  })

  it('第二次 dm 同一个人复用同一间房(幂等由 id 构造保证)', async () => {
    await sendCollabDm({ sessionId: EXEC, to: 'pm', message: '第一句' })
    await sendCollabDm({ sessionId: EXEC, to: 'pm', message: '第二句' })
    expect(mocks.created).toEqual([PAIR_ROOM])
    expect(mocks.said).toHaveLength(2)
  })

  it('工具回执点名对方,并说明用户也看得见(D4 透明制)', async () => {
    const result = await send(EXEC, { to: 'pm', content: '在吗' })
    expect(result.output).toContain('阿明')
    expect(result.output).toContain('用户也看得见')
    expect(result.metadata).toMatchObject({ ok: true, roomSessionId: PAIR_ROOM, messageId: 'msg-1' })
  })
})

/**
 * 发给用户本人(docs/design/agent-dm-user.md §3.2)。
 *
 * 与 agent 分支共用每一道门与同一条落库路径。结构上的差别在**房间**那一侧
 * (对端是人,没有模型可拉,所以没有牌可发);执行器这一侧两条分支同形,
 * 这组测试钉的就是"同形" —— 收件人解析出用户之后照样建房、照样落库。
 */
describe('dm 给用户本人', () => {
  it('开托管私聊房 → 落库(对端是人,没有模型可拉)', async () => {
    const result = await sendCollabDm({ sessionId: EXEC, to: '用户', message: '登录页那个配色你定一下' })

    expect(result).toEqual({
      ok: true,
      targetKind: 'user',
      roomSessionId: USER_ROOM,
      messageId: 'msg-1',
      peerName: '用户',
    })
    expect(mocks.created).toEqual([USER_ROOM])
    expect(mocks.said).toEqual([
      { sessionId: EXEC, content: '登录页那个配色你定一下', room: USER_ROOM },
    ])  })

  it('没配资料时 user / 用户 都可达', async () => {
    await sendCollabDm({ sessionId: EXEC, to: 'user', message: '一' })
    await sendCollabDm({ sessionId: EXEC, to: 'USER', message: '二' })
    expect(mocks.said.map(said => said.room)).toEqual([USER_ROOM, USER_ROOM])  })

  it('配了资料后,名字与 名字#句柄 同样可达', async () => {
    mocks.settings = { general: { userProfile: { name: '一天', handle: 'yitian' } } }

    await sendCollabDm({ sessionId: EXEC, to: '一天', message: '一' })
    await sendCollabDm({ sessionId: EXEC, to: '一天#yitian', message: '二' })
    const result = await sendCollabDm({ sessionId: EXEC, to: '#yitian', message: '三' })

    expect(mocks.said).toHaveLength(3)
    expect(result.peerName).toBe('一天')  })

  it('回执告诉 agent 不用等回复(防止发完就停轮空等)', async () => {
    const result = await send(EXEC, { to: '用户', content: '在吗' })
    expect(result.output).toContain('不一定在线')
    expect(result.output).toContain('不用等')
    expect(result.metadata).toMatchObject({ ok: true, roomSessionId: USER_ROOM })
  })

  it('say 侧拒绝原样透传(冻结房)', async () => {
    mocks.sayResult = { ok: false, error: '房间已暂停,你的发言没有送达。' }
    const result = await sendCollabDm({ sessionId: EXEC, to: '用户', message: '在吗' })
    expect(result).toEqual({ ok: false, error: '房间已暂停,你的发言没有送达。' })
  })

  it('service agent 发不出去 —— 发起人门在 ensureUserDmRoom 里', async () => {
    mocks.sessions.set('dj-exec', {
      id: 'dj-exec',
      name: '电台',
      kind: 'agent',
      agentId: 'dj',
      messages: [],
    } satisfies FakeSession)
    const result = await sendCollabDm({ sessionId: 'dj-exec', to: '用户', message: '在吗' })
    expect(result.ok).toBe(false)
    expect(mocks.created).toEqual([])
    expect(mocks.said).toEqual([])
  })
})

describe('拒绝路径:说清是哪一种,而且什么都不留下', () => {
  const cases: Array<{ name: string; to: string; contains: string }> = [
    { name: '已退休', to: 'gone', contains: '已注销' },
    { name: 'service agent', to: 'dj', contains: '不是同事' },
    { name: '查无此人', to: 'ghost', contains: '花名册里没有「ghost」这个人' },
    { name: '自己', to: 'fe', contains: '不能给自己发私聊' },
    { name: '空 to', to: '   ', contains: '名字#句柄' },
  ]

  for (const testCase of cases) {
    it(`${testCase.name}:拒绝有话说,不建房、不落消息`, async () => {
      const result = await sendCollabDm({ sessionId: EXEC, to: testCase.to, message: '在吗' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain(testCase.contains)
      expect(mocks.created).toEqual([])
      expect(mocks.said).toEqual([])
    })
  }

  /**
   * 空正文**提前判**(设计 §5 R1 / §9.2 的执行器那一半)。
   *
   * `content: ""` 过得了 zod(`z.string()` 收空串),所以它是唯一能带着一个合法
   * 收件人走到执行器的空正文。落库那一步本来也会拒(`speakIntoCollabRoom` 第一件
   * 事就是归一化正文),但那时房已经建出来了 —— 一次发不出去的私聊不该在侧栏留下
   * 一间空房。
   *
   * 另一半(旧转录的 `dm({to, message})`,`content` 直接缺席)在**校验层**就被挡
   * 下,由 `say-tool.test.ts` 的降级路径那一组守。两处拒绝语逐字相同。
   */
  it('空正文:在建房之前就拒,拒绝语与群发送逐字相同', async () => {
    const result = await sendCollabDm({ sessionId: EXEC, to: 'pm', message: '   ' })

    expect(result).toEqual({ ok: false, error: COLLAB_SAY_REFUSED_EMPTY })
    expect(mocks.created).toEqual([])
    expect(mocks.said).toEqual([])  })

  it('普通 chat 会话不给 dm:直播式对话里没有"私下问问"这件事', async () => {
    mocks.sessions.set('chat-1', {
      id: 'chat-1',
      name: '普通会话',
      agentId: 'fe',
      messages: [],
    } satisfies FakeSession)
    const result = await sendCollabDm({ sessionId: 'chat-1', to: 'pm', message: '在吗' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('私聊只在群聊/私聊/工作台的回合里可用')
    expect(mocks.created).toEqual([])
    expect(mocks.said).toEqual([])
  })

  it('工作台会话可以 dm(干活时问同事一句是正当的)', async () => {
    mocks.sessions.set('work-1', {
      id: 'work-1',
      name: '工作台',
      kind: 'work',
      agentId: 'fe',
      messages: [],
    } satisfies FakeSession)
    const result = await sendCollabDm({ sessionId: 'work-1', to: 'pm', message: '这个字段你那边叫什么' })
    expect(result.ok).toBe(true)
    expect(mocks.said[0]?.room).toBe(PAIR_ROOM)
  })

  it('会话没有属主 agent(不是一个 agent 的回合):发不出去', async () => {
    mocks.sessions.set('chat-1', { id: 'chat-1', name: '普通会话', messages: [] } satisfies FakeSession)
    const result = await sendCollabDm({ sessionId: 'chat-1', to: 'pm', message: '在吗' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('没有可用的发言身份')
    expect(mocks.created).toEqual([])
  })

  /**
   * 场子门等价(架构收敛 C3-6)。
   *
   * 那道 kind 三连否定改走统一判定(`venue.ts`),真值表逐一不变。压轴的是网关
   * 那一行:`kind` 为空 + 有 agentId —— 归一化把它算作 `chat`,拒。它若被放行,
   * 一位陌生联系人就能借这条会话给同事发私聊。
   */
  it('场子门等价:room/agent/work 通,chat 与 kind 缺席拒', async () => {
    mocks.sessions.set('room-1', {
      id: 'room-1', name: '群', kind: 'room', agentId: 'fe',
      room: { memberAgentIds: ['fe', 'pm'] }, messages: [],
    } satisfies FakeSession)
    mocks.sessions.set('work-2', {
      id: 'work-2', name: '工作台', kind: 'work', agentId: 'fe', messages: [],
    } satisfies FakeSession)
    mocks.sessions.set('chat-2', {
      id: 'chat-2', name: '普通会话', kind: 'chat', agentId: 'fe', messages: [],
    } satisfies FakeSession)
    mocks.sessions.set('gateway-1', {
      id: 'gateway-1', name: '微信联系人', agentId: 'fe', messages: [],
    } satisfies FakeSession)

    const outcomes: Array<[string, boolean]> = []
    for (const sessionId of ['room-1', EXEC, 'work-2', 'chat-2', 'gateway-1']) {
      const result = await sendCollabDm({ sessionId, to: 'pm', message: `来自 ${sessionId}` })
      outcomes.push([sessionId, result.ok])
    }
    expect(outcomes).toEqual([
      ['room-1', true],
      [EXEC, true],
      ['work-2', true],
      ['chat-2', false],
      ['gateway-1', false],
    ])
  })

  it('工具层把拒绝原样交给模型,并标 ok:false', async () => {
    const result = await send(EXEC, { to: 'gone', content: '在吗' })
    expect(result.title).toContain('未送达')
    expect(result.output).toContain('已注销')
    expect(result.metadata).toEqual({ ok: false })
  })
})

describe('say 侧的拒绝原样透传', () => {
  it('冻结/超预算:错误话术不改写', async () => {
    mocks.sayResult = { ok: false, error: '房间已暂停,你的发言没有送达。' }
    const result = await sendCollabDm({ sessionId: EXEC, to: 'pm', message: '在吗' })
    expect(result).toEqual({ ok: false, error: '房间已暂停,你的发言没有送达。' })
    // 房已经建出来了(校验都过了),但消息没落库 —— 送不达就没有对话。
    // 「谁被拉起来」自 D6-b 起归房间,而房间根本没收到这条 posted。
  })
})

/**
 * wake —— 跨房唤醒的**调用时**那一半
 * (docs/design/collab-send-channel-and-wake.md §2.3 + §3.2)。
 *
 * 兑现在两分钟内的某个时刻发生,而这组用例守的是它之前的那一刻:七条校验全部
 * 在调用时给出答案。理由写在设计里 —— 兑现时失败只能记日志(发起回合早就结束
 * 了,没有人可以回执),所以凡是**发起时能预判**的失败,都必须在这里被拒绝。
 */
describe('wake:调用时 fail fast', () => {
  const GAME_ROOM = 'room-game'

  /** 上帝(fe)在游戏群里的执行会话 —— 主用例的形状。 */
  function seedGameRoom(memberAgentIds: string[] = ['fe', 'pm']): void {
    mocks.sessions.set(GAME_ROOM, {
      id: GAME_ROOM,
      name: '狼人杀',
      kind: 'room',
      room: { memberAgentIds },
      messages: [],
    } satisfies FakeSession)
    mocks.sessions.set(EXEC, {
      id: EXEC,
      name: '小李 · 狼人杀',
      kind: 'agent',
      agentId: 'fe',
      collab: { roomSessionId: GAME_ROOM },
      messages: [],
    } satisfies FakeSession)
  }

  it('缺省命中本回合关联的群:登记唤醒,回执说清地名', async () => {
    seedGameRoom()
    const result = await sendCollabDm({
      sessionId: EXEC,
      to: 'pm',
      message: '你是狼人。',
      wake: true,
    })

    expect(result).toMatchObject({ ok: true, wakeRoomName: '狼人杀' })
    expect(mocks.wakes).toEqual([{
      dmRoomSessionId: PAIR_ROOM,
      targetAgentId: 'pm',
      wakeRoomSessionId: GAME_ROOM,
      senderSessionId: EXEC,
      senderAgentId: 'fe',
      sinceMessageId: 'msg-1',
    }])
  })

  it('不带 wake 就不登记 —— 私聊本身一个字都没变', async () => {
    seedGameRoom()
    await sendCollabDm({ sessionId: EXEC, to: 'pm', message: '你是狼人。' })
    expect(mocks.wakes).toEqual([])
  })

  it('wakeRoom 显式指定时按它走', async () => {
    seedGameRoom()
    mocks.sessions.set('room-other', {
      id: 'room-other',
      name: '另一个群',
      kind: 'room',
      room: { memberAgentIds: ['fe', 'pm'] },
      messages: [],
    } satisfies FakeSession)

    const result = await sendCollabDm({
      sessionId: EXEC,
      to: 'pm',
      message: '一',
      wake: true,
      wakeRoom: 'room-other',
    })
    expect(result).toMatchObject({ ok: true, wakeRoomName: '另一个群' })
    expect(mocks.wakes[0]).toMatchObject({ wakeRoomSessionId: 'room-other' })
  })

  const refusals: Array<{
    name: string
    seed: () => void
    args: { to: string; wakeRoom?: string }
    contains: string
  }> = [
    {
      name: '收件人是用户本人 —— TA 没有可唤醒的执行会话',
      seed: () => seedGameRoom(),
      args: { to: '用户' },
      contains: '没有可唤醒的执行会话',
    },
    {
      name: '收件人不在那个群里',
      seed: () => seedGameRoom(['fe']),
      args: { to: 'pm' },
      contains: '不在那个群里,唤醒不了',
    },
    {
      name: '发起人不在那个群里(poke 由 TA 署名落群)',
      seed: () => seedGameRoom(['pm']),
      args: { to: 'pm' },
      contains: '唤醒的那一声是以你的名义说的',
    },
    {
      name: '本回合没有关联的群,也没给 wakeRoom',
      seed: () => {},
      args: { to: 'pm' },
      contains: '不知道该到哪个群唤醒',
    },
    {
      name: 'wakeRoom 指的不是一个群',
      seed: () => seedGameRoom(),
      args: { to: 'pm', wakeRoom: 'no-such-room' },
      contains: 'room 参数指向的不是一个群聊',
    },
  ]

  for (const testCase of refusals) {
    it(`拒绝:${testCase.name} —— 不建房、不落消息、不登记`, async () => {
      testCase.seed()
      const result = await sendCollabDm({
        sessionId: EXEC,
        to: testCase.args.to,
        message: '你是狼人。',
        wake: true,
        ...(testCase.args.wakeRoom ? { wakeRoom: testCase.args.wakeRoom } : {}),
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain(testCase.contains)
      // 一次注定唤不醒的私聊不该在侧栏留下一间新房。
      expect(mocks.created.filter(id => id.startsWith('agent-dm'))).toEqual([])
      expect(mocks.said).toEqual([])
      expect(mocks.wakes).toEqual([])
    })
  }
})

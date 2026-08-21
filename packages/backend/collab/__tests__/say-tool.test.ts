/**
 * The say executor (W14b 说话即行动) — the moment an utterance becomes a room
 * message, or fails to.
 *
 * What only an app-layer test can pin down: the two entry points resolve to the
 * same room (a room turn speaks into itself, a work session into its parent),
 * the gates now refuse the AGENT rather than silently eating an activation, and
 * identity is settled at the write (mentions whitelisted + re-labelled, replyTo
 * turned into a snapshot of a message that really exists).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSessionFacadeMock } from '../../session/testing/facade-mock.js'
import {
  COLLAB_DM_LEGACY_TOOL_NAME,
  COLLAB_SAY_REFUSED_EMPTY,
  COLLAB_SAY_SOURCE,
  COLLAB_SEND_MESSAGE_LEGACY_TOOL_NAME,
  COLLAB_SEND_MESSAGE_TOOL_NAME,
} from '@onething/runtime/collab'
import { clearRetiredAgentToolNames, resolveRetiredAgentToolName } from '@onething/core'
import { createSendMessageTool, ZodValidator } from '@onething/runtime/toolkit'

const noop = () => { throw new Error('adapter not used in this case') }

interface FakeMessage {
  id: string
  role: string
  content: string
  agentId?: string
  source?: string
  timestamp: number
  mentions?: Array<{ agentId: string; label: string }>
  replyTo?: { messageId: string; authorLabel: string; excerpt: string }
}

interface FakeSession {
  id: string
  kind?: string
  name?: string
  agentId?: string
  room?: { memberAgentIds: string[]; pmAgentId?: string; frozen?: boolean }
  collab?: { roomSessionId?: string; taskId?: string }
  messages: FakeMessage[]
}

const AGENTS: Record<string, { id: string; name: string; title?: string }> = {
  pm: { id: 'pm', name: '阿明', title: '产品' },
  fe: { id: 'fe', name: '小李', title: '前端' },
}

const mocks = vi.hoisted(() => ({
  /** 「我的资料」为空 = 全链路回退到「用户」,与今天的行为逐字一致。 */
  settings: { general: {} } as { general: { userProfile?: Record<string, string> } },
  sessions: new Map<string, unknown>(),
  emitted: [] as Array<{ sessionId: string; event: Record<string, unknown> }>,
  overBudget: false,
  /**
   * 建房那一步的哨兵。整个文件里都不该被调用 —— 群发送不建房,而 legacy `dm` 的
   * 降级必须在**建房之前**结束(设计 §5 R1:一次发不出去的私聊不该在侧栏留下一间
   * 空房)。
   */
  createSession: vi.fn(),
}))

// P0.2 ③:业务代码改走 `sessionCommands` / `sessionReads`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。这两扇门换成共用替身,
// 读写落在下面同一份假会话表上 —— 与迁移前 `store.js` 假表的语义逐条对齐。
vi.mock('../../session/reads.js', () => import('../../session/testing/facade-mock.js'))
vi.mock('../../session/commands.js', () => import('../../session/testing/facade-mock.js'))
bindSessionFacadeMock((id: string) => mocks.sessions.get(id))

vi.mock('../../store.js', () => ({
  updateSessionWorkingDirectory: vi.fn(),
  // 用户身份现取(agent-dm-user.md §2.2):引用快照的作者行读它。
  getSettings: () => mocks.settings,
  getSession: (id: string) => mocks.sessions.get(id),
  addMessage: (sessionId: string, message: FakeMessage) => {
    (mocks.sessions.get(sessionId) as FakeSession | undefined)?.messages.push(message)
  },
  createSession: mocks.createSession,
  createSessionWithoutFocus: mocks.createSession,
}))

vi.mock('../../events/index.js', () => ({
  getEventBus: () => ({
    emit: async (sessionId: string, event: Record<string, unknown>) => {
      mocks.emitted.push({ sessionId, event })
    },
  }),
}))

vi.mock('../../wiring/agents/index.js', () => ({
  findAgent: (id: string) => AGENTS[id] ?? null,
  // 身份目录的识别面走全体 agent(collab-handle-codec.md §2.1),不是房内成员。
  listAgents: () => Object.values(AGENTS),
}))

// 费用闸的读口(D6-b:协调器删除后 say 直接从 budget.ts 取,不再中转一次)。
vi.mock('../budget.js', () => ({
  isRoomOverBudget: async () => mocks.overBudget,
}))

const {
  clearCollabSayIdempotence,
  registerCollabSendMessageLegacyAlias,
  speakIntoCollabRoom,
} = await import('../say-tool.js')

const ROOM = 'room-1'
const ROOM_B = 'room-2'
const WORK = 'work-1'
/** W18: the agent's execution session — where a room turn actually runs. */
const AGENT_SESSION = 'agent-exec-fe'

function room(): FakeSession {
  return mocks.sessions.get(ROOM) as FakeSession
}

function says(): FakeMessage[] {
  return room().messages.filter(message => message.source === COLLAB_SAY_SOURCE)
}

beforeEach(() => {
  mocks.sessions.clear()
  mocks.emitted.length = 0
  mocks.overBudget = false
  mocks.createSession.mockClear()
  // The duplicate window is module state with a 5s life — two tests saying the
  // same words would otherwise share one delivery.
  clearCollabSayIdempotence()
  mocks.sessions.set(ROOM, {
    id: ROOM,
    kind: 'room',
    name: '官网改版组',
    agentId: 'fe',
    room: { memberAgentIds: ['pm', 'fe'], pmAgentId: 'pm' },
    messages: [],
  } satisfies FakeSession)
  mocks.sessions.set(WORK, {
    id: WORK,
    kind: 'work',
    name: '[任务] 加 status.txt',
    agentId: 'fe',
    collab: { roomSessionId: ROOM, taskId: 'task-1' },
    messages: [],
  } satisfies FakeSession)
  mocks.sessions.set(AGENT_SESSION, {
    id: AGENT_SESSION,
    kind: 'agent',
    name: '[执行] 小李',
    agentId: 'fe',
    collab: { roomSessionId: ROOM },
    messages: [],
  } satisfies FakeSession)
  mocks.sessions.set(ROOM_B, {
    id: ROOM_B,
    kind: 'room',
    name: '内部工具组',
    room: { memberAgentIds: ['fe'] },
    messages: [],
  } satisfies FakeSession)
})

describe('两个入口,一个房间', () => {
  it('writes a signed room message from a room turn', async () => {
    const result = await speakIntoCollabRoom({ sessionId: ROOM, content: '  明天下班前  ' })
    expect(result).toEqual({ ok: true, messageId: expect.any(String) })

    expect(says()).toHaveLength(1)
    expect(says()[0]).toMatchObject({
      role: 'assistant',
      agentId: 'fe',
      content: '明天下班前', // trimmed
      source: COLLAB_SAY_SOURCE,
    })
    // Broadcast on the channel the room already listens to — no new event type.
    expect(mocks.emitted.some(entry =>
      entry.sessionId === ROOM && entry.event.type === 'message:user-created')).toBe(true)
  })

  it('routes a WORK session into its parent room', async () => {
    await speakIntoCollabRoom({ sessionId: WORK, content: '依赖装完了,继续跑' })
    expect(says()).toHaveLength(1)
    expect((mocks.sessions.get(WORK) as FakeSession).messages).toHaveLength(0)
  })

  it('emits no typing at all — the light belongs to the argument stream (W19)', async () => {
    // W13.1 used to bracket a work-session utterance with typing(true/false)
    // here. Since W19 the indicator is driven by the `say` call's arguments
    // streaming, which is already over by the time the executor runs — a pulse
    // here would be a zero-width flicker after the light went out.
    await speakIntoCollabRoom({ sessionId: WORK, content: '说一句' })
    await speakIntoCollabRoom({ sessionId: ROOM, content: '再说一句' })
    expect(mocks.emitted.some(entry => entry.event.type === 'collab:typing')).toBe(false)
  })

  it('refuses a session with no room behind it', async () => {
    mocks.sessions.set('chat-1', { id: 'chat-1', kind: 'chat', messages: [] } satisfies FakeSession)
    const result = await speakIntoCollabRoom({ sessionId: 'chat-1', content: '你好' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('群聊')
  })

  it('lets one turn say several things', async () => {
    await speakIntoCollabRoom({ sessionId: ROOM, content: '一' })
    await speakIntoCollabRoom({ sessionId: ROOM, content: '二' })
    await speakIntoCollabRoom({ sessionId: ROOM, content: '三' })
    expect(says().map(message => message.content)).toEqual(['一', '二', '三'])
    expect(new Set(says().map(message => message.id)).size).toBe(3)
  })

  /**
   * 场子门等价(架构收敛 C3-6)。
   *
   * 「哪些 kind 挂着一间房」的手写 if 被换成了统一判定(`venue.ts`),这条测试
   * 把**改造前后必须逐一相同**的那张真值表钉下来:room 说进自己、work/agent 说进
   * 各自指着的那间房、chat 与 kind 缺席(网关会话!)一律拒。
   */
  it('场子门等价:room/agent/work 通,chat 与 kind 缺席拒', async () => {
    mocks.sessions.set('chat-1', {
      id: 'chat-1', kind: 'chat', agentId: 'fe', messages: [],
    } satisfies FakeSession)
    // 网关(微信/Telegram)按远端身份建出来的会话:kind 为空,agentId 却是有的。
    mocks.sessions.set('gateway-1', { id: 'gateway-1', agentId: 'fe', messages: [] } satisfies FakeSession)

    const outcomes: Array<[string, boolean]> = []
    for (const sessionId of [ROOM, AGENT_SESSION, WORK, 'chat-1', 'gateway-1']) {
      const result = await speakIntoCollabRoom({ sessionId, content: `来自 ${sessionId}` })
      outcomes.push([sessionId, result.ok])
    }
    expect(outcomes).toEqual([
      [ROOM, true],
      [AGENT_SESSION, true],
      [WORK, true],
      ['chat-1', false],
      ['gateway-1', false],
    ])
  })
})

/**
 * W18 §4.6「say(room)」— the turn runs in the agent's own session, so the
 * utterance has to be ROUTED rather than simply "written where it happened".
 */
describe('W18 — say 的房间路由', () => {
  function saysIn(roomSessionId: string): FakeMessage[] {
    return (mocks.sessions.get(roomSessionId) as FakeSession).messages
      .filter(message => message.source === COLLAB_SAY_SOURCE)
  }

  it('sends an execution session into the room its drive pointed at', async () => {
    const result = await speakIntoCollabRoom({ sessionId: AGENT_SESSION, content: '明天下班前' })
    expect(result.ok).toBe(true)
    expect(saysIn(ROOM)).toHaveLength(1)
    expect(saysIn(ROOM)[0]).toMatchObject({ agentId: 'fe', source: COLLAB_SAY_SOURCE })
    // The execution session keeps its own transcript free of the utterance —
    // the room is where it landed.
    expect((mocks.sessions.get(AGENT_SESSION) as FakeSession).messages).toHaveLength(0)
  })

  it('follows the pointer when the same session is driven for another room', async () => {
    ;(mocks.sessions.get(AGENT_SESSION) as FakeSession).collab = { roomSessionId: ROOM_B }
    await speakIntoCollabRoom({ sessionId: AGENT_SESSION, content: '工具那边下周' })
    expect(saysIn(ROOM)).toHaveLength(0)
    expect(saysIn(ROOM_B)).toHaveLength(1)
  })

  it('an explicit room wins over the drive target', async () => {
    await speakIntoCollabRoom({ sessionId: AGENT_SESSION, content: '顺便说一句', room: ROOM_B })
    expect(saysIn(ROOM_B)).toHaveLength(1)
    expect(saysIn(ROOM)).toHaveLength(0)
  })

  it('an explicit room buys no membership — the gates run against the TARGET', async () => {
    ;(mocks.sessions.get(ROOM_B) as FakeSession).room!.memberAgentIds = ['pm']
    const result = await speakIntoCollabRoom({
      sessionId: AGENT_SESSION,
      content: '我插一句',
      room: ROOM_B,
    })
    expect(result.ok).toBe(false)
    expect(saysIn(ROOM_B)).toHaveLength(0)
  })

  it('names the mistake when the room parameter points at nothing', async () => {
    const result = await speakIntoCollabRoom({
      sessionId: AGENT_SESSION,
      content: '在吗',
      room: 'nope',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('room 参数')
  })

  it('refuses an execution session that no drive has pointed anywhere yet', async () => {
    ;(mocks.sessions.get(AGENT_SESSION) as FakeSession).collab = undefined
    const result = await speakIntoCollabRoom({ sessionId: AGENT_SESSION, content: '在吗' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('群聊')
  })

  it('leaves the room turn indicator alone (the queue owns it)', async () => {
    await speakIntoCollabRoom({ sessionId: AGENT_SESSION, content: '明天下班前' })
    expect(mocks.emitted.some(entry => entry.event.type === 'collab:typing')).toBe(false)
  })
})

describe('闸门收拢到 say —— agent 亲身知道没发出去', () => {
  it('refuses when the room is frozen, and writes nothing', async () => {
    room().room!.frozen = true
    const result = await speakIntoCollabRoom({ sessionId: ROOM, content: '有人吗' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('未送达')
    expect(says()).toHaveLength(0)
  })

  it('refuses when the room is over budget', async () => {
    mocks.overBudget = true
    const result = await speakIntoCollabRoom({ sessionId: ROOM, content: '有人吗' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('预算')
    expect(says()).toHaveLength(0)
  })

  it('refuses a member that was just shown the door (roster read fresh)', async () => {
    room().room!.memberAgentIds = ['pm']
    const result = await speakIntoCollabRoom({ sessionId: ROOM, content: '我还在' })
    expect(result.ok).toBe(false)
    expect(says()).toHaveLength(0)
  })

  it('rejects an empty utterance BEFORE the gates (a mistake, not a failure)', async () => {
    room().room!.frozen = true
    const result = await speakIntoCollabRoom({ sessionId: ROOM, content: '   ' })
    expect(result.error).toContain('空')
  })
})

/**
 * todo2 P0-2 — 同一句话只进群一次.
 *
 * 真机形状:一个回合里两条一字不差的消息。doom-loop 护栏阈值是 4,重复两次完全
 * 落在它之下,所以幂等必须在写入处结构保证。
 */
describe('幂等:同一句话只落一条', () => {
  it('writes once and hands the same receipt back the second time', async () => {
    const first = await speakIntoCollabRoom({ sessionId: ROOM, content: '登录页明天下班前' })
    const second = await speakIntoCollabRoom({ sessionId: ROOM, content: '登录页明天下班前' })

    expect(says()).toHaveLength(1)
    // Success, not a refusal: those words ARE in the room — and under the id the
    // caller is told, so a follow-up replyTo quotes the real message.
    expect(second).toEqual({ ok: true, messageId: first.messageId })
    // Nothing broadcast for the duplicate either, or the room would render two.
    expect(mocks.emitted.filter(entry => entry.event.type === 'message:user-created'))
      .toHaveLength(1)
  })

  it('normalizes before comparing — 前后空白不是新消息', async () => {
    await speakIntoCollabRoom({ sessionId: ROOM, content: '明天下班前' })
    await speakIntoCollabRoom({ sessionId: ROOM, content: '  明天下班前\n' })
    expect(says()).toHaveLength(1)
  })

  it('keeps different content, different mentions and different quotes apart', async () => {
    room().messages.push({ id: 'u-1', role: 'user', content: '什么时候好?', timestamp: Date.now() })

    await speakIntoCollabRoom({ sessionId: ROOM, content: '一' })
    await speakIntoCollabRoom({ sessionId: ROOM, content: '二' })
    // Same words to a different person is a different utterance…
    await speakIntoCollabRoom({ sessionId: ROOM, content: '好', mentions: ['pm'] })
    await speakIntoCollabRoom({ sessionId: ROOM, content: '好' })
    // …and so is the same words quoting something.
    await speakIntoCollabRoom({ sessionId: ROOM, content: '好', replyTo: 'u-1' })

    expect(says().map(message => message.content)).toEqual(['一', '二', '好', '好', '好'])
    expect(new Set(says().map(message => message.id)).size).toBe(5)
  })

  it('scopes the window per room and per agent', async () => {
    // 同一个 agent 在另一个房间说同样的话:两个房间各自都该看到。
    ;(mocks.sessions.get(ROOM_B) as FakeSession).room!.memberAgentIds = ['fe']
    await speakIntoCollabRoom({ sessionId: ROOM, content: '同一句话' })
    await speakIntoCollabRoom({ sessionId: AGENT_SESSION, content: '同一句话', room: ROOM_B })

    expect(says()).toHaveLength(1)
    expect((mocks.sessions.get(ROOM_B) as FakeSession).messages).toHaveLength(1)
  })
})

describe('身份在写入时定稿', () => {
  it('stamps whitelisted, roster-labelled mentions', async () => {
    await speakIntoCollabRoom({
      sessionId: ROOM,
      content: '拍个板',
      // 'ghost' is not in the room; the label is never the caller's to choose.
      mentions: ['pm', 'ghost'],
    })
    expect(says()[0].mentions).toEqual([{ agentId: 'pm', label: '阿明' }])
  })

  it('picks up a bare @名字 written in prose', async () => {
    await speakIntoCollabRoom({ sessionId: ROOM, content: '@阿明 你看一下' })
    expect(says()[0].mentions).toEqual([{ agentId: 'pm', label: '阿明' }])
  })

  /**
   * 句柄出栈(collab-agent-handle.md §2.4):模型写 `@名字#句柄`,群里落的是
   * `@名字`。身份进 mentions[],正文不背着它 —— 出站投影会按 id 重新拼出来。
   */
  it('剥掉句柄再落库 —— 群里、UI 里看到的是干净的一句话', async () => {
    await speakIntoCollabRoom({ sessionId: ROOM, content: '@阿明#pm 你看一下' })
    expect(says()[0].content).toBe('@阿明 你看一下')
    expect(says()[0].mentions).toEqual([{ agentId: 'pm', label: '阿明' }])
  })

  it('认不出的句柄原样留着(模型下一轮能看见自己写错了)', async () => {
    await speakIntoCollabRoom({ sessionId: ROOM, content: '@阿明#deadbeef 你看一下' })
    expect(says()[0].content).toBe('@阿明#deadbeef 你看一下')
    // 名字兜底仍然点到人 —— 写错句柄不等于谁都没点到。
    expect(says()[0].mentions).toEqual([{ agentId: 'pm', label: '阿明' }])
  })

  /**
   * 幂等窗与剥离的先后(设计文档 §4 H2 的验证项):指纹拿 content 当组成部分,
   * 所以剥离必须在算指纹**之前** —— 否则同一句话的两种写法会各落一条。
   */
  it('同一句话的两种写法算作一条(剥离在指纹之前)', async () => {
    const first = await speakIntoCollabRoom({ sessionId: ROOM, content: '@阿明#pm 你看一下' })
    const second = await speakIntoCollabRoom({ sessionId: ROOM, content: '@阿明 你看一下' })
    expect(says()).toHaveLength(1)
    expect(second).toEqual({ ok: true, messageId: first.messageId })
  })

  it('omits the field entirely when nobody is addressed', async () => {
    await speakIntoCollabRoom({ sessionId: ROOM, content: '没点名' })
    expect(says()[0].mentions).toBeUndefined()
  })

  it('turns replyTo into a snapshot of a real message', async () => {
    room().messages.push({
      id: 'u-1',
      role: 'user',
      content: '登录页什么时候能好?',
      timestamp: Date.now(),
    })
    await speakIntoCollabRoom({ sessionId: ROOM, content: '明天', replyTo: 'u-1' })
    expect(says()[0].replyTo).toEqual({
      messageId: 'u-1',
      authorLabel: '用户',
      excerpt: '登录页什么时候能好?',
    })
  })

  it('labels an agent quote from the roster', async () => {
    room().messages.push({
      id: 'a-1',
      role: 'assistant',
      agentId: 'pm',
      content: '排期我留了位置',
      timestamp: Date.now(),
    })
    await speakIntoCollabRoom({ sessionId: ROOM, content: '收到', replyTo: 'a-1' })
    expect(says()[0].replyTo?.authorLabel).toBe('阿明')
  })

  it('ignores a replyTo that names nothing — the words still go out', async () => {
    const result = await speakIntoCollabRoom({ sessionId: ROOM, content: '明天', replyTo: 'nope' })
    expect(result.ok).toBe(true)
    expect(says()[0].replyTo).toBeUndefined()
  })
})

/**
 * legacy `dm` 的降级路径(docs/design/collab-send-channel-and-wake.md §5 R1 / §9.2)。
 *
 * 2026-08-02 起 `send_message` 是**唯一**的发送消息工具:`dm` 连隐藏的真工具都
 * 不是,它只剩退役名表里的一个名字。表只认名字不认参数,而两者参数不同形
 * (`message` vs `content`),所以这次转发注定不无缝 —— 这一组守的正是那次降级
 * 的三条承诺:
 *
 *  1. 名字确实被派发到现名(否则模仿旧转录的调用换来一句「Tool not available」);
 *  2. 拒绝语逐字是那句可操作的「content 是空的」(而不是一坨 zod issue ——
 *     模型手上还攥着原文,读懂了才会在下一轮换参数名重发);
 *  3. 这一路**什么都没留下**:没有消息落库,更没有一间空的私聊房被建出来。
 */
describe('legacy `dm`:退役名 + 降级', () => {
  beforeEach(() => {
    // 退役名表是 core 的进程内全局状态 —— 先清再注册,断言才说的是这一次注册。
    clearRetiredAgentToolNames()
    registerCollabSendMessageLegacyAlias()
  })

  it('`dm` 与 `say` 都派发到 send_message', () => {
    expect(resolveRetiredAgentToolName(COLLAB_DM_LEGACY_TOOL_NAME))
      .toBe(COLLAB_SEND_MESSAGE_TOOL_NAME)
    expect(resolveRetiredAgentToolName(COLLAB_SEND_MESSAGE_LEGACY_TOOL_NAME))
      .toBe(COLLAB_SEND_MESSAGE_TOOL_NAME)
    // 别名只在派发时生效:现名不该被映射到别处。
    expect(resolveRetiredAgentToolName(COLLAB_SEND_MESSAGE_TOOL_NAME))
      .toBe(COLLAB_SEND_MESSAGE_TOOL_NAME)
  })

  it('旧转录的 dm({to, message}):一句可操作的拒绝,不落消息、不建私聊房', () => {
    // 退役名表原样带着参数转发过去(它只换名字),于是落到 send_message 手里的
    // 就是旧那一套参数名。
    const legacyArgs = { to: '阿明#pm', message: '接口这块想跟你对一下' }
    // R4b:契约从旧 `SayTool.parameters` / `formatValidationError` 换成新树那一份
    // (`toolkit/builtin/send-message.ts` 的 `SendMessageContract`),同一条判据。
    const validated = new ZodValidator().parse(
      createSendMessageTool({ speak: noop as never, sendDm: noop as never }).spec.input,
      legacyArgs,
    )

    // `to` 是合并面的正式参数,活着;`message` 不是,被 zod strip 掉之后 content
    // 缺席 —— 校验就在这一层失败,执行器一步都没跑。
    expect(validated.ok).toBe(false)
    expect(!validated.ok && validated.message).toBe(COLLAB_SAY_REFUSED_EMPTY)

    expect(says()).toEqual([])
    expect(mocks.createSession).not.toHaveBeenCalled()
  })
})

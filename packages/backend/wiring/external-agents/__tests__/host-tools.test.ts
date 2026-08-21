/**
 * **E3 的验收**:外部 agent 的发言权真的回到了房间。
 *
 * 这个文件回答的是整期方案的那个核心问句(§0.1 原则 2「发言权归房间,永不外包」):
 * 当 Claude Code 经注入的 MCP 调 `send_message` 时,那句话是**经持牌路径**落进
 * 房间的 —— 与本地 agent 一字不差的同一条路 —— 而不是靠收养兜底把回合正文搬运
 * 进去(§0 诊断把那条路称作「降级冒充设计」)。
 *
 * 钉三件事:
 *  1. 走的是 `speakThroughCollabLease`(拿着这一轮的牌调 v3 发言口),不是 v2 落库;
 *  2. 幂等窗仍然生效(同一句话两次 = 房间里一条消息);
 *  3. 房间里因此**有**这一轮的发言 ⇒ 收养兜底的触发条件(零 say)不成立。
 *
 * 外加装配面的那几道门:场子门现算、工具从注册表取、解绑真的解。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { collectLogRecordsForTests } from '../../logging/index.js'
import { bindSessionFacadeMock } from '../../../session/testing/facade-mock.js'
import { COLLAB_SAY_SOURCE } from '@onething/runtime/collab'
import {
  clearHostToolContexts,
  resolveHostToolContext,
  toHostMcpToolDefinition,
} from '@onething/runtime/external-agents'

interface FakeMessage {
  id: string
  role: string
  content: string
  agentId?: string
  source?: string
  timestamp: number
}

interface FakeSession {
  id: string
  kind?: string
  agentId?: string
  room?: { memberAgentIds: string[]; frozen?: boolean }
  collab?: { roomSessionId?: string }
  messages: FakeMessage[]
}

const AGENTS: Record<string, { id: string; name: string }> = {
  fe: { id: 'fe', name: '小李' },
}

const mocks = vi.hoisted(() => ({
  settings: { general: {} },
  sessions: new Map<string, unknown>(),
  emitted: [] as Array<{ sessionId: string; event: Record<string, unknown> }>,
  /** profile 解析的答案 —— 装配层唯一那次 `resolveAgentToolSurface`。 */
  profileTools: null as string[] | null,
  /** 注册表里有哪些工具对象。 */
  registry: new Map<string, unknown>(),
}))

// P0.2 ③:业务代码改走 `sessionCommands` / `sessionReads`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。这两扇门换成共用替身,
// 读写落在下面同一份假会话表上 —— 与迁移前 `store.js` 假表的语义逐条对齐。
vi.mock('../../../session/reads.js', () => import('../../../session/testing/facade-mock.js'))
vi.mock('../../../session/commands.js', () => import('../../../session/testing/facade-mock.js'))
bindSessionFacadeMock((id: string) => mocks.sessions.get(id))

vi.mock('../../../store.js', () => ({
  getSettings: () => mocks.settings,
  getSession: (id: string) => mocks.sessions.get(id),
  addMessage: (sessionId: string, message: FakeMessage) => {
    (mocks.sessions.get(sessionId) as FakeSession | undefined)?.messages.push(message)
  },
  updateSessionWorkingDirectory: vi.fn(),
  createSession: vi.fn(),
  createSessionWithoutFocus: vi.fn(),
}))

vi.mock('../../../stores/sessions.js', () => ({
  getSession: (id: string) => mocks.sessions.get(id),
}))

vi.mock('../../../events/index.js', () => ({
  getEventBus: () => ({
    emit: async (sessionId: string, event: Record<string, unknown>) => {
      mocks.emitted.push({ sessionId, event })
    },
  }),
}))

vi.mock('../../agents/index.js', () => ({
  findAgent: (id: string) => AGENTS[id] ?? null,
  listAgents: () => Object.values(AGENTS),
}))

vi.mock('../../agents/profile.js', () => ({
  resolveAgentProfileForSession: () => ({
    agentId: 'fe',
    name: '小李',
    systemPrompt: '',
    tools: mocks.profileTools,
    permissionMode: 'normal',
    maxTurns: 100,
  }),
}))

vi.mock('../../../collab/budget.js', () => ({
  isRoomOverBudget: async () => false,
}))

const { resolveClaudeCodeHostToolSurface } = await import('../host-tools.js')
const { clearCollabSayIdempotence, speakIntoCollabRoom }
  = await import('../../../collab/say-tool.js')
const { Catalog, Decision, ToolRunner } = await import('@onething/core/toolkit')
const {
  configureToolkitCatalog,
  contractForSchema,
  createSendMessageTool,
  ZodValidator,
} = await import('@onething/runtime/toolkit')

/**
 * R4b:宿主工具面从旧注册表(`getTool`)换成**目录**。这里装一份只有
 * `send_message` 的目录 —— 与 `mocks.registry.set('send_message', SayTool)` 是
 * 同一件事,只是换了本册子。
 */
const sendMessageTool = createSendMessageTool({
  sessionKind: (sessionId: string) => (mocks.sessions.get(sessionId) as FakeSession | undefined)?.kind,
  sessionAgentId: (sessionId: string) => (mocks.sessions.get(sessionId) as FakeSession | undefined)?.agentId,
  speak: speakIntoCollabRoom,
  sendDm: async () => ({ ok: false, error: '这个文件不测私聊档' }),
})

/**
 * 与 `host-tools.ts` 的 `toolkitHostTool` 同形的一层薄包装(那个函数是私有的)。
 * 执行走 `ToolRunner`,与真回合逐字同路。
 */
const sendMessageHostTool = {
  id: 'send_message',
  description: sendMessageTool.spec.description,
  parameters: contractForSchema(sendMessageTool.spec.input)?.zod,
  async execute(args: Record<string, unknown>, ctx: { sessionId: string; messageId: string }) {
    const runner = new ToolRunner({
      authorizer: { async decide() { return Decision.allow() } },
      observer: { on: () => {} },
      validator: new ZodValidator(),
    })
    const outcome = await runner.run(sendMessageTool, {
      callId: 'host-mcp-call',
      toolId: 'send_message',
      input: args,
      sessionId: ctx.sessionId,
      messageId: ctx.messageId,
      principal: undefined as never,
    })
    if (outcome.kind !== 'ok') throw new Error(`unexpected outcome: ${outcome.kind}`)
    return {
      output: outcome.result.content
        .filter(part => part.type === 'text')
        .map(part => part.text ?? '')
        .join('\n'),
    }
  },
}
const {
  beginCollabV3Turn,
  clearCollabV3Turns,
  configureCollabV3SpeakPort,
} = await import('../../../collab/actors/turn-context.js')

const ROOM = 'room-1'
const EXEC = 'agent-exec-fe-room-1'
const LEASE = 'lease-7'

/** v3 的发言口替身 —— 真身是 RoomActor 的租约发言口。落库那一步照做,因为
 *  「房间里有没有这一轮的发言」正是收养兜底的触发判据。 */
const speakPort = vi.fn(async (input: {
  agentId: string
  roomSessionId: string
  leaseId: string
  content: string
}) => {
  if (input.leaseId !== LEASE) return { ok: false, error: '这张牌不是你的' }
  const message: FakeMessage = {
    id: `msg-${(mocks.sessions.get(ROOM) as FakeSession).messages.length + 1}`,
    role: 'assistant',
    agentId: input.agentId,
    content: input.content,
    source: COLLAB_SAY_SOURCE,
    timestamp: Date.now(),
  };
  (mocks.sessions.get(ROOM) as FakeSession).messages.push(message)
  return { ok: true, messageId: message.id }
})

function roomSays(): FakeMessage[] {
  return (mocks.sessions.get(ROOM) as FakeSession).messages
    .filter(message => message.source === COLLAB_SAY_SOURCE)
}

beforeEach(() => {
  mocks.sessions.clear()
  mocks.emitted.length = 0
  mocks.profileTools = null
  configureToolkitCatalog(new Catalog().register(sendMessageTool))
  speakPort.mockClear()
  clearCollabSayIdempotence()
  clearCollabV3Turns()
  clearHostToolContexts()
  configureCollabV3SpeakPort(speakPort)

  mocks.sessions.set(ROOM, {
    id: ROOM,
    kind: 'room',
    agentId: 'fe',
    room: { memberAgentIds: ['fe'] },
    messages: [],
  } satisfies FakeSession)
  mocks.sessions.set(EXEC, {
    id: EXEC,
    kind: 'agent',
    agentId: 'fe',
    collab: { roomSessionId: ROOM },
    messages: [],
  } satisfies FakeSession)
})

/** 一轮在飞的 v3 回合 —— 真机里由 `engine-mind-port` 在 emit drive 之前登记。 */
function startTurn(): void {
  beginCollabV3Turn({
    agentId: 'fe',
    roomSessionId: ROOM,
    execSessionId: EXEC,
    leaseId: LEASE,
    epoch: 1,
    startedAt: Date.now(),
  })
}

/** 模型经 MCP 调 `send_message` 的那一下。 */
async function callSendMessage(args: Record<string, unknown>) {
  const definition = toHostMcpToolDefinition(sendMessageHostTool, EXEC)
  return definition.handler(args, undefined)
}

describe('发言权真的收回来了', () => {
  it('经 MCP 的 send_message 走持牌路径落库,不是 v2 落库分支', async () => {
    startTurn()
    const injection = await resolveClaudeCodeHostToolSurface({
      localSessionId: EXEC,
      cwd: '/tmp',
    })
    expect(injection).toBeDefined()

    const result = await callSendMessage({ content: '我看完了,没问题' })

    // ① 持牌:发言经的是 v3 的租约口,拿的是这一轮那张牌。
    expect(speakPort).toHaveBeenCalledTimes(1)
    expect(speakPort).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'fe',
      roomSessionId: ROOM,
      leaseId: LEASE,
      content: '我看完了,没问题',
    }))

    // ② 回执是工具结果的正文 —— 与本地回合逐字同形(没有被翻译成 MCP 错误)。
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('msg-1')

    // ③ v2 落库分支一步都没走:房间里没有 `message:user-created` 广播,
    //    因为消息是房间自己写的(真机里由 RoomActor 播)。
    expect(mocks.emitted.some(entry => entry.event.type === 'message:user-created')).toBe(false)

    injection?.release?.()
  })

  it('收养兜底不该被触发 —— 房间里确实有这一轮的发言', async () => {
    startTurn()
    await resolveClaudeCodeHostToolSurface({ localSessionId: EXEC, cwd: '/tmp' })
    await callSendMessage({ content: '搞定了' })

    // 收养的触发条件是「本回合零 say」(`engine-mind-port` 的 harvested.length === 0,
    // 它数的就是房里这一轮之后带 collab-say source 的自己那几条)。有一条 ⇒ 不触发。
    expect(roomSays()).toHaveLength(1)
    expect(roomSays()[0]).toMatchObject({ agentId: 'fe', content: '搞定了' })
  })

  it('幂等窗生效:同一句话两次 = 房间里一条消息', async () => {
    startTurn()
    await resolveClaudeCodeHostToolSurface({ localSessionId: EXEC, cwd: '/tmp' })

    const first = await callSendMessage({ content: '好的' })
    const second = await callSendMessage({ content: '好的' })

    expect(speakPort).toHaveBeenCalledTimes(1)
    expect(roomSays()).toHaveLength(1)
    // 第二次是**成功**语义:那句话确实在群里,而且返回的是同一个 id ——
    // 后续 replyTo 因此能正确引用它。
    expect(second.content[0].text).toBe(first.content[0].text)
  })

  it('牌不对时拒绝语原样透传给模型', async () => {
    // 登记一轮,但换一张牌 —— 模拟「牌已作废」。
    beginCollabV3Turn({
      agentId: 'fe',
      roomSessionId: ROOM,
      execSessionId: EXEC,
      leaseId: 'stale-lease',
      epoch: 1,
      startedAt: Date.now(),
    })
    await resolveClaudeCodeHostToolSurface({ localSessionId: EXEC, cwd: '/tmp' })

    const result = await callSendMessage({ content: '还在吗' })
    expect(result.content[0].text).toContain('这张牌不是你的')
    expect(roomSays()).toHaveLength(0)
  })

  it('没有 v3 回合在飞时回落 v2 落库路径 —— 工作台/旧形状的房内流照旧', async () => {
    // 不登记回合:`resolveCollabV3SpeakRoute` 不命中。
    await resolveClaudeCodeHostToolSurface({ localSessionId: EXEC, cwd: '/tmp' })
    await callSendMessage({ content: '汇报一下' })

    expect(speakPort).not.toHaveBeenCalled()
    expect(roomSays()).toHaveLength(1)
    expect(mocks.emitted.some(entry => entry.event.type === 'message:user-created')).toBe(true)
  })

  it('本地回合与外部回合共用同一个幂等窗 —— 它是「同一次调用重复到达」的窗', async () => {
    startTurn()
    await resolveClaudeCodeHostToolSurface({ localSessionId: EXEC, cwd: '/tmp' })

    await callSendMessage({ content: '同一句' })
    // 本地路径直接调执行器(引擎的工具循环走的就是这条)。
    const local = await speakIntoCollabRoom({ sessionId: EXEC, content: '同一句' })

    expect(local.ok).toBe(true)
    expect(speakPort).toHaveBeenCalledTimes(1)
    expect(roomSays()).toHaveLength(1)
  })
})

describe('装配面:场子门、注册表、语境绑定', () => {
  it('绑定的语境带上这一轮的 agent / 房 / 牌', async () => {
    startTurn()
    const injection = await resolveClaudeCodeHostToolSurface({
      localSessionId: EXEC,
      messageId: 'assistant-1',
      cwd: '/work',
    })

    expect(resolveHostToolContext(EXEC)).toEqual({
      agentId: 'fe',
      roomSessionId: ROOM,
      execSessionId: EXEC,
      leaseId: LEASE,
      messageId: 'assistant-1',
      workingDirectory: '/work',
    })

    injection?.release?.()
    expect(resolveHostToolContext(EXEC)).toBeUndefined()
  })

  it('注入的工具全名带前缀,SDK 侧看到的就是它们', async () => {
    startTurn()
    const injection = await resolveClaudeCodeHostToolSurface({
      localSessionId: EXEC,
      cwd: '/tmp',
    })
    // 注册表里只放了 send_message,所以只有它 —— 其余三个取不到就不注(不假装)。
    expect(injection?.toolNames).toEqual(['mcp__onething__send_message'])
    expect(Object.keys(injection!.mcpServers)).toEqual(['onething'])
    injection?.release?.()
  })

  it('普通对话:场子门关着,一个都不注 —— 这是门第一次对外部 agent 生效', async () => {
    mocks.sessions.set('chat-1', {
      id: 'chat-1',
      agentId: 'fe', // 每条新会话都盖着 agentId,单它一个不足以放行
      messages: [],
    } satisfies FakeSession)

    const injection = await resolveClaudeCodeHostToolSurface({
      localSessionId: 'chat-1',
      cwd: '/tmp',
    })
    expect(injection).toBeUndefined()
    expect(resolveHostToolContext('chat-1')).toBeUndefined()
  })

  it('agent 白名单里没有协作工具时不注(白名单那一道也真的在)', async () => {
    startTurn()
    mocks.profileTools = ['read', 'write']
    const injection = await resolveClaudeCodeHostToolSurface({
      localSessionId: EXEC,
      cwd: '/tmp',
    })
    expect(injection).toBeUndefined()
  })

  it('目录里一个工具都取不到时不注,而且说出来', async () => {
    startTurn()
    configureToolkitCatalog(new Catalog())
    const logs = collectLogRecordsForTests()
    const injection = await resolveClaudeCodeHostToolSurface({
      localSessionId: EXEC,
      cwd: '/tmp',
    })
    expect(injection).toBeUndefined()
    expect(logs.messages()).toContain('no builtin tool object for the requested ids; host tools not injected')
    // 起不来就不该留一份绑定在表里。
    expect(resolveHostToolContext(EXEC)).toBeUndefined()
    logs.stop()
  })

  it('查无此会话 / 没有同事身份时不注', async () => {
    expect(await resolveClaudeCodeHostToolSurface({ localSessionId: 'nope', cwd: '/tmp' }))
      .toBeUndefined()

    mocks.sessions.set('exec-2', { id: 'exec-2', kind: 'agent', messages: [] } satisfies FakeSession)
    expect(await resolveClaudeCodeHostToolSurface({ localSessionId: 'exec-2', cwd: '/tmp' }))
      .toBeUndefined()
  })
})

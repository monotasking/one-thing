/**
 * Where a room turn's system prompt takes its material from (W18).
 *
 * Before W18 the answer was trivially "the session being driven" — the turn ran
 * inside the room. Now it runs in the agent's execution session, and the room
 * facts (persona, roster, room name) have to be fetched from the room that
 * session was pointed at. Getting this wrong is silent: the model would still
 * get a persona, just not the room's, and nothing would throw.
 *
 * 在飞的卡此前也从这里取(`taskFacts` → `<your_cards>`),现在改由 `my_cards`
 * 变量承载(agent-self-state-variables.md §4.4),取材守卫见
 * app/variables/__tests__/agent-self-gateway.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const AGENTS: Record<string, { id: string; name: string; systemPrompt?: string; title?: string }> = {
  fe: { id: 'fe', name: '小李', title: '前端', systemPrompt: '你是小李,说话直接。' },
  pm: { id: 'pm', name: '阿明', title: '产品', systemPrompt: '你是阿明。' },
}

const mocks = vi.hoisted(() => ({
  /** 「我的资料」为空 = 全链路回退到「用户」,与今天的行为逐字一致。 */
  settings: { general: {} } as { general: { userProfile?: Record<string, string> } },
  sessions: new Map<string, unknown>(),
}))

vi.mock('../../../wiring/agents/index.js', () => ({
  findAgent: (id?: string) => (id ? AGENTS[id] ?? null : null),
  defaultAgent: () => ({ id: 'default', name: 'Default Agent', systemPrompt: '' }),
  DEFAULT_AGENT_ID: 'default',
}))

vi.mock('../../../store.js', () => ({
  getSession: (id: string) => mocks.sessions.get(id),
  // 花名册/情况说明里的用户称呼从这里来(agent-dm-user.md §2.3)。
  getSettings: () => mocks.settings,
}))

const { buildSystemPrompt } = await import('../system-prompt.js')

const ROOM = 'room-1'
const AGENT_SESSION = 'agent-exec-fe'

function context(sessionId: string) {
  return {
    sessionId,
    hasTools: true,
    skills: [],
    activeProject: { hasActive: false },
    knownProjects: { hasAny: false, entries: [] },
    toolNames: ['say', 'board'],
    mcpToolNames: [],
  } as unknown as Parameters<typeof buildSystemPrompt>[0]
}

beforeEach(() => {
  mocks.sessions.clear()
  mocks.sessions.set(ROOM, {
    id: ROOM,
    name: '官网改版组',
    kind: 'room',
    room: { memberAgentIds: ['pm', 'fe'], pmAgentId: 'pm' },
    messages: [],
  })
  mocks.sessions.set(AGENT_SESSION, {
    id: AGENT_SESSION,
    name: '[执行] 小李',
    kind: 'agent',
    agentId: 'fe',
    collab: { roomSessionId: ROOM },
    messages: [],
  })
})

describe('collab room overrides — 取材链 (W18)', () => {
  it('builds an execution session’s prompt from the room it was pointed at', async () => {
    const { system } = await buildSystemPrompt(context(AGENT_SESSION))

    // The persona is the prompt (D3「模拟房间」), and the room facts come from
    // the TARGET room, not from the session being driven.
    expect(system).toContain('你是小李,说话直接。')
    expect(system).toContain('官网改版组')
    // 花名册**在这里**(collab-turn-protocol-and-identity.md B):它曾被搬进投影
    // 的 `<ChatRoom><Members>`,而 v3 V2 删掉了那块载荷 —— 名单从此指向一段不
    // 存在的文本,模型于是把用户与花名册上的名字数成两个人(幽灵成员)。
    // 用户行与同事行同一书写法,与转录署名同源。
    expect(system).toContain('- 阿明#pm(产品)')
    expect(system).toContain('(用户)')
    // 真回合的消息形状是 drive 信封,不是判定那一路的压缩窗口。
    expect(system).toContain('`<message from="名字#句柄">` lines')
    expect(system).not.toContain('`name: text`')
    // v3 V2 之后 drive 里没有 `<ChatRoom>` 载荷了 —— 指向它就是指向一段不存在的文本。
    expect(system).not.toContain('`<ChatRoom>` block')
    // The product prompt's own identity/tool sections stay disabled.
    expect(system).not.toContain('[执行] 小李')
  })

  it('follows the pointer to another room', async () => {
    mocks.sessions.set('room-2', {
      id: 'room-2',
      name: '内部工具组',
      kind: 'room',
      room: { memberAgentIds: ['fe'] },
      messages: [],
    })
    ;(mocks.sessions.get(AGENT_SESSION) as { collab: { roomSessionId: string } })
      .collab.roomSessionId = 'room-2'

    const { system } = await buildSystemPrompt(context(AGENT_SESSION))
    expect(system).toContain('内部工具组')
    expect(system).not.toContain('官网改版组')
  })

  it('leaves an unpointed execution session on the ordinary product prompt', async () => {
    ;(mocks.sessions.get(AGENT_SESSION) as { collab?: unknown }).collab = undefined
    const { system } = await buildSystemPrompt(context(AGENT_SESSION))
    expect(system).not.toContain('官网改版组')
  })

  it('still builds a pre-W18 in-room turn from the room session itself', async () => {
    ;(mocks.sessions.get(ROOM) as { agentId?: string }).agentId = 'fe'
    const { system } = await buildSystemPrompt(context(ROOM))
    expect(system).toContain('你是小李,说话直接。')
    expect(system).toContain('官网改版组')
  })
})

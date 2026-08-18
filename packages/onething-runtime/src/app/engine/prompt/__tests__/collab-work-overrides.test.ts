/**
 * 工作台会话的 system prompt 身份(架构收敛 C3-5,审计 A3 后半)。
 *
 * 这个文件钉住的是一个**曾经的空白**:`collabRoomOverrides` 只认 room/agent 两种
 * kind,kind='work' 落空 —— 一条工作会话拿到的是完整产品提示词(一个通用助理的
 * 身份),任务框架只寄在 worker.ts 那条 briefing user 消息里,而它会随历史一起
 * 被压缩摘要化。干到第三个小时的 agent 于是既不记得自己在做哪张卡,也不记得
 * 产出该往哪儿报。
 *
 * 现在身份进 system prompt(每轮整份重发,压不掉),取材全部来自会话 meta ——
 * `spawnWork` 钉进去的 roomSessionId / taskId / taskTitle 那份快照。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const AGENTS: Record<string, { id: string; name: string; systemPrompt?: string; title?: string }> = {
  fe: { id: 'fe', name: '小李', title: '前端', systemPrompt: '你是小李,说话直接。' },
}

const mocks = vi.hoisted(() => ({
  settings: { general: {} } as { general: { userProfile?: Record<string, string> } },
  sessions: new Map<string, unknown>(),
}))

vi.mock('../../../agents/index.js', () => ({
  findAgent: (id?: string) => (id ? AGENTS[id] ?? null : null),
  defaultAgent: () => ({ id: 'default', name: 'Default Agent', systemPrompt: '' }),
  DEFAULT_AGENT_ID: 'default',
}))

vi.mock('../../../store.js', () => ({
  getSession: (id: string) => mocks.sessions.get(id),
  getSettings: () => mocks.settings,
}))

const { buildSystemPrompt } = await import('../system-prompt.js')

const ROOM = 'room-1'
const WORK = 'work-1'

function context(sessionId: string) {
  return {
    sessionId,
    hasTools: true,
    skills: [],
    activeProject: { hasActive: false },
    knownProjects: { hasAny: false, entries: [] },
    // 工作会话的真实面:文件工具 + 协作工具。`# Todo` 只在有文件工具可操作它时
    // 出现(它的说明书写的就是 read/edit/write),所以这里必须像真回合一样带上。
    toolNames: ['read', 'edit', 'bash', 'send_message', 'board'],
    mcpToolNames: [],
  } as unknown as Parameters<typeof buildSystemPrompt>[0]
}

/** system + developer 段合起来才是模型收到的那一份(persona 段是 developer)。 */
async function whole(sessionId: string): Promise<string> {
  const { system, developer } = await buildSystemPrompt(context(sessionId))
  return [system, ...developer].join('\n\n')
}

/** Everything this session gets, both channels — for "is it there at all". */
async function everything(sessionId: string): Promise<string> {
  const { system, developer, turn } = await buildSystemPrompt(context(sessionId))
  return [system, ...developer, ...turn.map(block => block.content)].join('\n\n')
}

beforeEach(() => {
  mocks.sessions.clear()
  mocks.sessions.set(ROOM, {
    id: ROOM,
    name: '官网改版组',
    kind: 'room',
    room: { memberAgentIds: ['fe'] },
    messages: [],
  })
  mocks.sessions.set(WORK, {
    id: WORK,
    name: '[任务] 登录页重做',
    kind: 'work',
    agentId: 'fe',
    collab: { roomSessionId: ROOM, taskId: 'task-9f2c', taskTitle: '登录页重做' },
    messages: [],
  })
})

describe('collab work overrides —— 工作身份常驻 system prompt (C3-5)', () => {
  it('工作会话拿到 persona + 工作身份 + 卡框架', async () => {
    const prompt = await whole(WORK)

    // persona 仍在(工作会话的身份是「这位同事」,不是一个匿名 worker)。
    expect(prompt).toContain('你是小李,说话直接。')
    // 工作身份三件:在为一张卡干活、母房是谁、后台执行。
    expect(prompt).toContain('working on one card from the board of the room 「官网改版组」')
    expect(prompt).toContain('This session runs in the background')
    // 两条回报路都要出现 —— 少写哪一条,那一条在真机里就会变成"从来没人用过"。
    expect(prompt).toContain('`send_message` is the send button')
    expect(prompt).toContain('The `board` tool is how the card itself moves')
    // 卡框架:id 与标题都得在,`<card id="…"/>` 与 board 的 taskId 都照抄这一串。
    expect(prompt).toContain('id: task-9f2c')
    expect(prompt).toContain('标题: 登录页重做')
  })

  it('产品段一个都不禁 —— 工作会话真的在读文件、跑命令', async () => {
    // 房间回合会把这些整批禁掉(D3「模拟房间」);工作台恰恰需要它们。
    // 「不禁」与「在哪条通道」是两件事:todo 现在走回合尾块(它带会话路径),
    // 所以这条断言看两条通道的并集。
    const prompt = await whole(WORK)
    expect(prompt).toContain('# Agent:')
    expect(prompt).toContain('You are running on')
    expect(await everything(WORK)).toContain('# Todo')
  })

  it('卡框架缺席时只给身份,不编一张不存在的卡', async () => {
    ;(mocks.sessions.get(WORK) as { collab: Record<string, unknown> }).collab = {
      roomSessionId: ROOM,
    }
    const prompt = await whole(WORK)
    expect(prompt).toContain('working on one card from the board of the room 「官网改版组」')
    expect(prompt).not.toContain('<card>')
  })

  it('母房被删掉也照给身份,房名退回中性词', async () => {
    mocks.sessions.delete(ROOM)
    const prompt = await whole(WORK)
    expect(prompt).toContain('the board of the room 「群聊」')
    expect(prompt).toContain('id: task-9f2c')
  })

  it('没有 roomSessionId 的工作会话退回普通产品提示词', async () => {
    ;(mocks.sessions.get(WORK) as { collab?: unknown }).collab = undefined
    const prompt = await whole(WORK)
    expect(prompt).not.toContain('working on one card from the board')
  })

  it('普通 chat 会话一个字都不沾', async () => {
    mocks.sessions.set('chat-1', { id: 'chat-1', name: '随便聊聊', agentId: 'fe', messages: [] })
    const prompt = await whole('chat-1')
    expect(prompt).not.toContain('working on one card from the board')
    expect(prompt).not.toContain('<card>')
  })
})

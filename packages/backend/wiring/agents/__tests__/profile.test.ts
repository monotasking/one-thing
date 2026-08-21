import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentToolSurface } from '@onething/runtime/agents'
import type { AgentDefinition, ChatSession } from '@shared/ipc.js'

/* Mock paths are resolved from THIS file, not from the module under test. */
const state = vi.hoisted(() => ({
  agent: null as AgentDefinition | null,
  session: undefined as ChatSession | undefined,
  settings: {} as Record<string, unknown>,
}))

vi.mock('@onething/runtime/agents/store-bound.wiring', () => ({
  // 生产代码走 findAgent ?? defaultAgent();夹具用同一个 state.agent 顶两个口,
  // 与旧 getAgent mock(忽略入参直接回 state.agent)行为一致。
  findAgent: () => state.agent,
  defaultAgent: () => state.agent,
}))

vi.mock('../../../stores/sessions.js', () => ({
  getSession: () => state.session,
}))

vi.mock('../../../stores/settings.js', () => ({
  getSettings: () => state.settings,
}))

const { resolveAgentProfileForSession } = await import('../profile.js')

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'agent-a',
    name: 'A',
    systemPrompt: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1',
    name: 'S',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    agentId: 'agent-a',
    ...overrides,
  } as ChatSession
}

beforeEach(() => {
  state.agent = agent()
  state.session = session()
  state.settings = {}
})

describe('resolveAgentProfileForSession', () => {
  it('feeds the live stores into the pure rule', () => {
    state.agent = agent({ tools: ['bash'], maxTurns: 250, permissionMode: 'normal' })
    state.settings = { chat: { maxTurns: 40 }, tools: { permissionMode: 'dangerously-allow-all' } }

    expect(resolveAgentProfileForSession('session-1')).toMatchObject({
      agentId: 'agent-a',
      tools: ['bash'],
      maxTurns: 250,
      permissionMode: 'normal',
    })
  })

  /**
   * 这一层负责的**不是**工具面规则(规则只有一处:`resolveAgentToolSurface`),
   * 而是「喂给规则的输入对不对」—— kind 从哪读、dm 那一格怎么推。所以断言不硬编
   * 清单,而是对着规则本身:规则将来怎么改,这里跟着走;红的只会是"输入喂错了"。
   *
   * (这条断言此前硬编过 `['send_message', 'board']` —— 那是 2026-07-30 收紧成
   * replace 的形态,而那次收紧同日就撤销了,于是 P3 给房面加 `room_history` 时
   * 它才红。C2 之后连"两份实现"本身都没了,这里守的是输入那一段。)
   */
  it('房回合:kind 喂到了规则里,工具面 = agent 自己的 ∪ 房面', () => {
    state.agent = agent({ tools: ['bash'] })
    state.session = session({ kind: 'agent' })

    expect(resolveAgentProfileForSession('session-1').tools).toEqual(
      resolveAgentToolSurface({ sessionKind: 'agent', ownTools: ['bash'] }),
    )
    // 自己的工具没被顶掉,房面也确实加上了(否则上面那条断言会跟着规则一起错)
    expect(resolveAgentProfileForSession('session-1').tools).toContain('bash')
    expect(resolveAgentProfileForSession('session-1').tools).toContain('send_message')
  })

  /**
   * dm 那一格的输入是**算出来的**(isUserDmRoom:人数即形态),不是会话上现成的
   * 字段 —— 少推一次就等于把 D7 那一格悄悄换成群房那一格。单成员房这里钉死。
   */
  it('单成员私聊:dm 被推导出来并喂进规则(collab-dm 那一格)', () => {
    state.agent = agent({ tools: ['bash'] })
    state.session = session({
      kind: 'room',
      room: { memberAgentIds: ['agent-a'], dm: true },
    } as Partial<ChatSession>)

    expect(resolveAgentProfileForSession('session-1').tools).toEqual(
      resolveAgentToolSurface({ sessionKind: 'room', sessionDm: true, ownTools: ['bash'] }),
    )
  })

  /** 工作台会话:另一格地板(board + send_message),同样由 kind 推出。 */
  it('工作台会话:kind=work 拿工作台那一格', () => {
    state.agent = agent({ tools: ['bash'] })
    state.session = session({ kind: 'work' } as Partial<ChatSession>)

    expect(resolveAgentProfileForSession('session-1').tools).toEqual(
      resolveAgentToolSurface({ sessionKind: 'work', ownTools: ['bash'] }),
    )
    expect(resolveAgentProfileForSession('session-1').tools).toContain('board')
  })

  /**
   * D7 的边界(IM P3):`collab-dm` 那一格是**单成员**私聊的特权,双成员 dm 房
   * 不能顺着 `room.dm` 标记溜进去 —— 分流点是 `isUserDmRoom`(人数即形态),
   * 这里钉的就是"人数真的被数了"。
   *
   * 今天两格的工具清单相同,所以断言写成"与普通群房同解"而不是硬编一个清单:
   * 群房那一格若再次收紧成 replace,双人房必须跟着收紧(它是沟通场),而单成员
   * 私聊必须不动(它是干活现场)—— 这条断言那时会自己说话。
   */
  it('双成员 dm 房与普通群房同解:collab-dm 那一格只归单成员私聊', () => {
    state.agent = agent({ tools: ['bash'] })

    state.session = session({
      kind: 'room',
      room: { memberAgentIds: ['agent-a', 'agent-b'] },
    } as Partial<ChatSession>)
    const group = resolveAgentProfileForSession('session-1').tools

    state.session = session({
      kind: 'room',
      room: { memberAgentIds: ['agent-a', 'agent-b'], dm: true },
    } as Partial<ChatSession>)
    expect(resolveAgentProfileForSession('session-1').tools).toEqual(group)

    // 单成员房才是 dm 那一格(今天同解,分开登记是为了将来能分开动)。
    state.session = session({
      kind: 'room',
      room: { memberAgentIds: ['agent-a'], dm: true },
    } as Partial<ChatSession>)
    expect(resolveAgentProfileForSession('session-1').tools).toEqual(group)
  })

  it('drops the model binding once the user pinned a model', () => {
    state.agent = agent({ model: { providerId: 'claude', modelId: 'sonnet' } })

    expect(resolveAgentProfileForSession('session-1').model)
      .toEqual({ providerId: 'claude', modelId: 'sonnet' })

    state.session = session({ modelPinned: true })
    expect(resolveAgentProfileForSession('session-1').model).toBeUndefined()
  })

  it('survives a session that no longer exists', () => {
    state.session = undefined
    expect(resolveAgentProfileForSession('gone').agentId).toBe('agent-a')
  })
})

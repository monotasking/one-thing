import { beforeEach, describe, expect, it } from 'vitest'
import { captureRuntimeLogs } from '../../logging/index.js'
import {
  DEFAULT_AGENT_MAX_TURNS,
  composeAgentPermissionMode,
  resetUnknownPermissionModeWarnings,
  resolveAgentProfile,
  resolveAgentToolSurface,
} from '../profile.js'
import type { OnethingAgentDefinition } from '../store.js'

function agent(overrides: Partial<OnethingAgentDefinition> = {}): OnethingAgentDefinition {
  return {
    id: 'agent-a',
    name: 'A',
    systemPrompt: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('resolveAgentToolSurface', () => {
  /* 「这一回合能用哪些工具」的唯一实现,这张表就是它的全部场景(C2 之前 collab
     那份同义实现的用例已并进来,连带它的 dm 分支)。注意 'agent' 这一格:W18
     之后房回合跑在 agent 自己的执行会话里,所以它必须与 'room' 同解 —— 工具面
     跟着**回合**走,不跟着存消息的那个会话走。 */
  const cases: Array<{
    name: string
    kind?: string
    dm?: boolean
    ownTools: string[] | null
    expected: string[] | null
  }> = [
    { name: 'chat, no allowlist', kind: undefined, ownTools: null, expected: null },
    { name: 'chat, allowlist', kind: undefined, ownTools: ['bash'], expected: ['bash'] },
    // Union(collab-team-v2 §2.1;2026-07-30 曾收紧为 replace,同日撤销):
    // 配了白名单 → own ∪ {say, board};没配 → 不限制。
    { name: 'room unions', kind: 'room', ownTools: ['bash'], expected: ['bash', 'send_message', 'board', 'history'] },
    { name: 'room without allowlist stays unrestricted', kind: 'room', ownTools: null, expected: null },
    // D6-a 接线:v3 的心智回合跑在 kind='agent' 上,笔记从此进这一格的地板
    // (`NOTEBOOK_SESSION_KINDS`)。kind='room' 没有 —— 那里没有 v3 心智循环。
    { name: 'agent kind unions', kind: 'agent', ownTools: ['bash'], expected: ['bash', 'send_message', 'board', 'history', 'notebook'] },
    { name: 'agent kind without allowlist stays unrestricted', kind: 'agent', ownTools: null, expected: null },
    // D7:单成员 dm 房走 `collab-dm` 那一格。今天与群房同解,分开登记是为了将来
    // 能分开动(群房若再次收紧成 replace,托管私聊不能跟着被收窄)。
    { name: 'dm room unions', kind: 'room', dm: true, ownTools: ['bash'], expected: ['bash', 'send_message', 'board', 'history'] },
    { name: 'dm room without allowlist stays unrestricted', kind: 'room', dm: true, ownTools: null, expected: null },
    { name: 'dm agent kind unions', kind: 'agent', dm: true, ownTools: ['bash'], expected: ['bash', 'send_message', 'board', 'history', 'notebook'] },
    // dm 只对房回合有意义:work / chat 不因为这个标记改答案。
    { name: 'dm flag does not reach work', kind: 'work', dm: true, ownTools: ['bash'], expected: ['bash', 'board', 'send_message', 'notebook'] },
    { name: 'dm flag does not reach chat', kind: undefined, dm: true, ownTools: ['bash'], expected: ['bash'] },
    { name: 'work unions', kind: 'work', ownTools: ['bash'], expected: ['bash', 'board', 'send_message', 'notebook'] },
    { name: 'work without allowlist stays unrestricted', kind: 'work', ownTools: null, expected: null },
    { name: 'work does not duplicate', kind: 'work', ownTools: ['board'], expected: ['board', 'send_message', 'notebook'] },
    { name: 'room does not duplicate', kind: 'room', ownTools: ['send_message'], expected: ['send_message', 'board', 'history'] },
    { name: 'unknown kind passes through', kind: 'archive', ownTools: ['bash'], expected: ['bash'] },
  ]

  for (const testCase of cases) {
    it(`${testCase.name}`, () => {
      expect(resolveAgentToolSurface({
        ownTools: testCase.ownTools,
        sessionKind: testCase.kind,
        sessionDm: testCase.dm,
      })).toEqual(testCase.expected)
    })
  }

  /**
   * W22 退役清单:任何会话的工具面里都不该再出现 `stay_silent`。事故形状是
   * 一个惰性工具 + 一个「必须调工具」的开局 = 永不终止的落点(77 次/四回合,
   * 真机 2026-07-28)。断路器是兜底,这条是根除。
   */
  it('offers stay_silent to NOBODY — the tool is retired', () => {
    for (const kind of ['room', 'agent', 'work', 'chat']) {
      for (const dm of [false, true]) {
        expect(
          resolveAgentToolSurface({ ownTools: ['read'], sessionKind: kind, sessionDm: dm }) ?? [],
        ).not.toContain('stay_silent')
      }
    }
  })

  it('applies an explicit grant outside collab sessions', () => {
    // union grants: layered onto the agent's own tools.
    expect(resolveAgentToolSurface({ ownTools: ['bash'], grants: ['collab-work'] }))
      .toEqual(['bash', 'board', 'send_message'])
    expect(resolveAgentToolSurface({ ownTools: ['bash'], grants: ['collab-room'] }))
      .toEqual(['bash', 'send_message', 'board', 'history'])
    expect(resolveAgentToolSurface({ ownTools: ['bash'], grants: ['collab-dm'] }))
      .toEqual(['bash', 'send_message', 'board', 'history'])
  })

  it('ignores unknown grants', () => {
    expect(resolveAgentToolSurface({ ownTools: ['bash'], grants: ['nope'] })).toEqual(['bash'])
  })
})

describe('composeAgentPermissionMode', () => {
  const cases: Array<[string | undefined, string | undefined, string]> = [
    // agent, session/settings, expected
    [undefined, undefined, 'normal'],
    [undefined, 'dangerously-allow-all', 'dangerously-allow-all'],
    [undefined, 'auto-accept-edits', 'auto-accept-edits'],
    ['normal', 'dangerously-allow-all', 'normal'],
    ['normal', 'auto-accept-edits', 'normal'],
    ['auto-accept-edits', 'dangerously-allow-all', 'auto-accept-edits'],
    ['dangerously-allow-all', 'normal', 'normal'],
    ['auto-accept-edits', 'normal', 'normal'],
    ['dangerously-allow-all', undefined, 'normal'],
    // P1-4: an unorderable mode does not participate — the configured chain
    // stands (it used to rank as strictest and silently pin the turn).
    ['mystery-mode', 'dangerously-allow-all', 'dangerously-allow-all'],
    ['mystery-mode', undefined, 'normal'],
    // 忽略掉不认识的会话/设置值 → 落到默认 normal,再按严格者胜。
    ['auto-accept-edits', 'mystery-mode', 'normal'],
    [undefined, 'mystery-mode', 'normal'],
  ]

  for (const [agentMode, baseMode, expected] of cases) {
    it(`agent=${agentMode ?? '—'} base=${baseMode ?? '—'} → ${expected}`, () => {
      expect(composeAgentPermissionMode(agentMode, baseMode)).toBe(expected)
    })
  }

  /**
   * P1-4 的另一半:忽略一个拼错的值不能是**静默**忽略。旧行为把不认识的模式
   * 当最严处理,agents.json 里拼错一个字就能压死房间/全局设置且无迹可寻。
   */
  describe('unknown modes are loud', () => {
    beforeEach(() => {
      resetUnknownPermissionModeWarnings()
    })

    it('warns once per (origin, agent, mode) and names both', () => {
      const logs = captureRuntimeLogs()
      try {
        expect(composeAgentPermissionMode('mystery-mode', 'normal', undefined, { agentId: 'agent-a' }))
          .toBe('normal')
        composeAgentPermissionMode('mystery-mode', 'normal', undefined, { agentId: 'agent-a' })

        const warns = logs.ofLevel('warn')
        expect(warns).toHaveLength(1)
        expect(warns[0].fields?.mode).toBe('mystery-mode')
        expect(warns[0].fields?.agentId).toBe('agent-a')
      } finally {
        logs.restore()
      }
    })

    it('warns for a broken session/settings value too, and falls back', () => {
      const logs = captureRuntimeLogs()
      try {
        expect(composeAgentPermissionMode(undefined, 'auto-acept-edits')).toBe('normal')
        const warns = logs.ofLevel('warn')
        expect(warns).toHaveLength(1)
        expect(warns[0].fields?.origin).toBe('session/settings')
      } finally {
        logs.restore()
      }
    })

    it('says nothing for the modes it knows', () => {
      const logs = captureRuntimeLogs()
      try {
        composeAgentPermissionMode('normal', 'dangerously-allow-all')
        composeAgentPermissionMode(undefined, undefined)
        expect(logs.ofLevel('warn')).toHaveLength(0)
      } finally {
        logs.restore()
      }
    })

    it('surfaces the agent id when the profile resolves a typo', () => {
      const logs = captureRuntimeLogs()
      try {
        const profile = resolveAgentProfile({
          agent: agent({ id: 'ops', permissionMode: 'dangerously-alow-all' }),
          settings: { tools: { permissionMode: 'auto-accept-edits' } },
        })
        expect(profile.permissionMode).toBe('auto-accept-edits')
        expect(logs.ofLevel('warn')[0]?.fields?.agentId).toBe('ops')
      } finally {
        logs.restore()
      }
    })
  })
})

describe('resolveAgentProfile', () => {
  it('is a pure passthrough when the agent declares no boundaries', () => {
    expect(resolveAgentProfile({ agent: agent({ tools: ['bash'] }) })).toEqual({
      agentId: 'agent-a',
      name: 'A',
      systemPrompt: '',
      tools: ['bash'],
      permissionMode: 'normal',
      maxTurns: DEFAULT_AGENT_MAX_TURNS,
      model: undefined,
    })
  })

  it('lets the agent raise the turn budget over settings', () => {
    expect(resolveAgentProfile({
      agent: agent({ maxTurns: 300 }),
      settings: { chat: { maxTurns: 40 } },
    }).maxTurns).toBe(300)

    expect(resolveAgentProfile({
      agent: agent(),
      settings: { chat: { maxTurns: 40 } },
    }).maxTurns).toBe(40)
  })

  it('takes the stricter permission mode, session included', () => {
    expect(resolveAgentProfile({
      agent: agent({ permissionMode: 'normal' }),
      session: { permissionMode: 'dangerously-allow-all' },
    }).permissionMode).toBe('normal')

    // An unmarked agent stays out of the composition entirely — the collab
    // worker's inherited auto-approve keeps working.
    expect(resolveAgentProfile({
      agent: agent(),
      session: { permissionMode: 'dangerously-allow-all' },
    }).permissionMode).toBe('dangerously-allow-all')

    expect(resolveAgentProfile({
      agent: agent(),
      settings: { tools: { permissionMode: 'auto-accept-edits' } },
    }).permissionMode).toBe('auto-accept-edits')
  })

  it('yields the model binding only when the user has not pinned one', () => {
    const bound = agent({ model: { providerId: 'claude', modelId: 'sonnet' } })

    expect(resolveAgentProfile({ agent: bound }).model)
      .toEqual({ providerId: 'claude', modelId: 'sonnet' })
    expect(resolveAgentProfile({ agent: bound, session: { modelPinned: true } }).model)
      .toBeUndefined()
    expect(resolveAgentProfile({ agent: agent(), session: {} }).model).toBeUndefined()
  })

  it('unions send_message + board + history onto the agent tools by session kind', () => {
    expect(resolveAgentProfile({
      agent: agent({ tools: ['bash'] }),
      session: { kind: 'room' },
    }).tools).toEqual(['bash', 'send_message', 'board', 'history'])
    expect(resolveAgentProfile({
      agent: agent(),
      session: { kind: 'room' },
    }).tools).toBeNull()
  })
})

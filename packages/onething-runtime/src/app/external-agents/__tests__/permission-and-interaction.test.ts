/**
 * **E4 的验收(装配层)**:外部通路终于接在了两条既有的等待链上。
 *
 * 三条:
 *
 *  1. **G1 — callId 必须过桥**。core 只在 `callId` 存在时才把这次审批与那个
 *     toolCall 关联起来(`core/permission/index.ts:393-400`),renderer 匹配不到
 *     toolCall 就把事件永久缓存、一个字都不画。E4 之前这里写死 `callId: undefined`
 *     —— 审批卡从未上屏,这就是 F3 那 2 分 11 秒的直接成因。
 *  2. **G2 — 必须走策略门**。直调 `Permission.ask` 绕开了 `enforcePermissionPolicy`,
 *     而 120s 无人值守自动拒绝桥长在那扇门上。注意这两条是**咬合的**:超时桥按
 *     `callId + messageId` 找 pending 去结算,所以丢了 callId 连兜底都找不到东西
 *     可拒 —— 修一条不修另一条等于没修。
 *  3. **提问在没有人的房间里当场拒绝**(§4 末段):pair 房两个 agent 私聊,发起
 *     一次提问就是发起一次空等。
 *
 * 用**真的** core Permission / Interaction / 策略门,只把 store、路径、宿主工具面
 * 这些「认识磁盘的东西」换掉 —— 桥接的正确性正是在这几层之间,mock 掉就什么都没验。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSessionFacadeMock } from '../../session/testing/facade-mock.js'
import { Interaction } from '@onething/core/interaction'
import { Permission } from '@onething/core/permission'

interface FakeMessage {
  id: string
  role: string
  origin?: { transport: string; source: string; receivedAt: number }
}

interface FakeSession {
  id: string
  kind?: string
  room?: { dm?: boolean; memberAgentIds?: string[] }
  collab?: { roomSessionId?: string }
  messages: FakeMessage[]
}

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  /** E0 能力表的答案。翻它就能验「能力位真的有读者」。 */
  interruptCapable: true,
  /** 已发出的授权(type + pattern)。P0-4 的粒度断言全靠它。 */
  grants: [] as { type: string; pattern: string }[],
}))

// P0.2 ③:业务代码改走 `sessionCommands` / `sessionReads`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。这两扇门换成共用替身,
// 读写落在下面同一份假会话表上 —— 与迁移前 `store.js` 假表的语义逐条对齐。
vi.mock('../../session/reads.js', () => import('../../session/testing/facade-mock.js'))
vi.mock('../../session/commands.js', () => import('../../session/testing/facade-mock.js'))
bindSessionFacadeMock((id: string) => mocks.sessions.get(id))

vi.mock('../../store.js', () => ({
  getSession: (id: string) => mocks.sessions.get(id),
  getSettings: () => ({ network: {} }),
}))

vi.mock('../../stores/paths.js', () => ({
  getStorePath: () => '/tmp/onething-e4-test',
  // R4b:授权入口换成 `Authorizer.decide` 之后,设置仓库进了这条路的静态图。
  getSettingsPath: () => '/tmp/onething-e4-test/settings.json',
}))

vi.mock('../../stores/settings.js', () => ({
  getSettings: () => ({ tools: { tools: {} } }),
}))

vi.mock('../../logging/index.js', () => ({
  writeAppLog: vi.fn(),
}))

/**
 * 授权留存的**最小真身**:按 (type, pattern) 逐条比。默认一条都没有(每一次都必须
 * 真的问),往 `mocks.grants` 里放一条就能验「记住的到底是哪一档」—— 而那正是 P0-4
 * 的全部内容。
 */
vi.mock('../../permission/permission-grants.js', () => ({
  matchGrant: (input: { type: string; pattern: string | string[] }) => {
    const patterns = Array.isArray(input.pattern) ? input.pattern : [input.pattern]
    const hit = mocks.grants.find(
      grant => grant.type === input.type && patterns.every(pattern => pattern === grant.pattern),
    )
    return hit ? { id: `${hit.type}:${hit.pattern}` } : undefined
  },
}))

// 宿主工具面认识注册表与 v3 登记簿 —— 与本文件无关,别把它拖进来。
vi.mock('../host-tools.js', () => ({
  resolveClaudeCodeHostToolSurface: vi.fn(),
}))

vi.mock('@onething/runtime/agents', () => ({
  findAgentExecutorDescriptor: (id: string) =>
    id === 'claude-code-agent'
      ? { id, kind: 'external', capabilities: { interrupt: mocks.interruptCapable } }
      : undefined,
}))

const GOAL_ORIGIN = { transport: 'system', source: 'goal', receivedAt: 0 }

function seedSessions(): void {
  mocks.sessions.clear()
  // 系统驱动的普通会话 → 走 timeoutAskBridge(120s 自动拒绝)。
  mocks.sessions.set('chat-1', {
    id: 'chat-1',
    kind: 'chat',
    messages: [
      { id: 'u-1', role: 'user', origin: GOAL_ORIGIN },
      { id: 'msg-9', role: 'assistant' },
    ],
  } satisfies FakeSession)
  // pair 房(两个 agent 私聊,没有人类)与它的执行会话。
  mocks.sessions.set('pair-room', {
    id: 'pair-room',
    kind: 'room',
    room: { dm: true, memberAgentIds: ['iris', 'kai'] },
    messages: [],
  } satisfies FakeSession)
  mocks.sessions.set('pair-exec', {
    id: 'pair-exec',
    kind: 'agent',
    collab: { roomSessionId: 'pair-room' },
    messages: [],
  } satisfies FakeSession)
  // 有人类在场的多人房。
  mocks.sessions.set('team-room', {
    id: 'team-room',
    kind: 'room',
    room: { dm: false, memberAgentIds: ['iris', 'kai', 'lin'] },
    messages: [],
  } satisfies FakeSession)
  mocks.sessions.set('team-exec', {
    id: 'team-exec',
    kind: 'agent',
    collab: { roomSessionId: 'team-room' },
    messages: [],
  } satisfies FakeSession)
}

beforeEach(() => {
  seedSessions()
  mocks.interruptCapable = true
  mocks.grants = []
  Permission.clearSession('chat-1')
  Interaction.clearSession('pair-exec')
  Interaction.clearSession('team-exec')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('外部审批走策略门(G1 + G2)', () => {
  it('SDK 的 toolUseID 一路带到 core 的 callId —— 卡片靠它才画得出来', async () => {
    const { askExternalAgentPermission } = await import('../index.js')
    const decision = askExternalAgentPermission({
      connectorId: 'claude-code-agent',
      localSessionId: 'chat-1',
      messageId: 'msg-9',
      cwd: '/tmp/p',
      toolName: 'Glob',
      input: { pattern: '**/*.ts' },
      toolCallId: 'toolu_01ABC',
    })

    await vi.waitFor(() => {
      expect(Permission.getPendingPrompts('chat-1')).toHaveLength(1)
    })
    const prompt = Permission.getPendingPrompts('chat-1')[0]
    expect(prompt.callId).toBe('toolu_01ABC')
    expect(prompt.messageId).toBe('msg-9')
    // 认不出的工具名维持 E4 的形状:卡片类型、标题、渲染层一个字都不用改。
    expect(prompt.type).toBe('external-agent')
    expect(prompt.title).toBe('Claude Code: Glob')
    expect(prompt.metadata).toMatchObject({ connectorId: 'claude-code-agent', toolName: 'Glob' })

    Permission.respond({ sessionId: 'chat-1', permissionId: prompt.id, response: 'once' })
    await expect(decision).resolves.toEqual({ behavior: 'allow' })
  })

  /**
   * **G1 的另一半:messageId 那一截**(2026-08-11,SDK 线冻结前收口)。
   *
   * 渲染侧落卡要过两道闸,`callId` 那道已经有领养兜底
   * (`renderer/stores/chat.ts:adoptToolCallForPermission`),而 `messageId` 这道
   * **没有兜底也不自愈**:缓存只在"那条消息被创建"时唤醒,一个永远不会被创建的
   * messageId(从前的 `?? ''`)就是永久静默 —— 后端挂着等审批,前端一张卡都不出。
   *
   * 而这一格是真会踩到的:`agent-loop/providers/factory.ts:497` **根本不传**
   * `messageId`,所以每一次外部审批都落在会话自查上;首轮工具审批完全可能早于
   * assistant 消息落库。
   *
   * 这条与
   * `renderer/components/chat/__tests__/ChatPanel.external-permission.test.ts`
   * 共用同一个接缝不变式(嵌套 callId + 会话里真的有的 messageId),那一条接着
   * 往下验:同样的快照进 store,账页真的画进 DOM。
   */
  it('会话里还没有 assistant 消息 —— 锚落到真的有的那条消息上,而不是空串', async () => {
    mocks.sessions.set('fresh-1', {
      id: 'fresh-1',
      kind: 'chat',
      // 首轮:用户那条已经落库,assistant 消息还没有。
      messages: [{ id: 'u-1', role: 'user', origin: GOAL_ORIGIN }],
    } satisfies FakeSession)
    Permission.clearSession('fresh-1')

    const { askExternalAgentPermission } = await import('../index.js')
    const decision = askExternalAgentPermission({
      connectorId: 'claude-code-agent',
      localSessionId: 'fresh-1',
      // factory.ts:497 不传 messageId —— 这里逐字复现那个缺省。
      cwd: '/tmp/p',
      toolName: 'Bash',
      input: { command: 'rm -rf ./build' },
      // 后台子代理的嵌套 tool_use id:消息上没有这张工具卡。
      toolCallId: 'toolu_nested_bg_01',
    })

    await vi.waitFor(() => {
      expect(Permission.getPendingPrompts('fresh-1')).toHaveLength(1)
    })
    const prompt = Permission.getPendingPrompts('fresh-1')[0]

    expect(prompt.callId).toBe('toolu_nested_bg_01')
    expect(prompt.messageId).not.toBe('')
    // 锚必须是渲染侧真的找得到的那条消息。
    const messages = (mocks.sessions.get('fresh-1') as FakeSession).messages
    expect(messages.some(message => message.id === prompt.messageId)).toBe(true)

    Permission.respond({ sessionId: 'fresh-1', permissionId: prompt.id, response: 'once' })
    await expect(decision).resolves.toEqual({ behavior: 'allow' })
  })

  it('无人应答 120s 后自动拒绝,理由可读地回到 SDK', async () => {
    vi.useFakeTimers()
    const { askExternalAgentPermission } = await import('../index.js')
    const decision = askExternalAgentPermission({
      connectorId: 'claude-code-agent',
      localSessionId: 'chat-1',
      messageId: 'msg-9',
      toolName: 'Bash',
      // 注意不能用 `rm -rf /`:那是分类器的 hardDeny,策略门当场拒,根本等不到 120s。
      input: { command: 'rm -rf ./dist' },
      cwd: '/tmp/p',
      toolCallId: 'toolu_timeout',
    })

    // 还没到点:仍然挂着一张真卡(用户随时可以点)。
    await vi.advanceTimersByTimeAsync(119_000)
    expect(Permission.getPendingPrompts('chat-1')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(2_000)
    const settled = await decision
    expect(settled.behavior).toBe('deny')
    expect(settled).toMatchObject({
      message: expect.stringContaining('自动拒绝'),
    })
    // 从正常的 respond 路径拒的 —— pending 被结算掉,不是留在界面上变成孤儿。
    expect(Permission.getPendingPrompts('chat-1')).toHaveLength(0)
  })

  it('用户拒绝时的理由同样原样回到 SDK', async () => {
    const { askExternalAgentPermission } = await import('../index.js')
    const decision = askExternalAgentPermission({
      connectorId: 'claude-code-agent',
      localSessionId: 'chat-1',
      messageId: 'msg-9',
      toolName: 'Write',
      input: {},
      toolCallId: 'toolu_reject',
    })
    await vi.waitFor(() => {
      expect(Permission.getPendingPrompts('chat-1')).toHaveLength(1)
    })
    Permission.respond({
      sessionId: 'chat-1',
      permissionId: Permission.getPendingPrompts('chat-1')[0].id,
      response: 'reject',
      rejectReason: '这个目录不能动',
    })
    await expect(decision).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('这个目录不能动'),
    })
  })
})

/**
 * **P0-4:外部审批的粒度**(`docs/audit/claude-code-sdk-audit-2026-08-11.md`)。
 *
 * 判据只有一条:同一个动作,外部会话与本地会话在卡上、在 grant 上长一个样。所以
 * 这里断言的不是「弹了一张卡」,而是**卡上写的是什么、记住的是哪一档**。
 */
describe('外部工具的审批粒度(P0-4)', () => {
  it('Bash 走命令级:卡片标题是命令原文,grant 记的是命令模式而不是工具名', async () => {
    const { askExternalAgentPermission } = await import('../index.js')
    const decision = askExternalAgentPermission({
      connectorId: 'claude-code-agent',
      localSessionId: 'chat-1',
      messageId: 'msg-9',
      cwd: '/tmp/p',
      toolName: 'Bash',
      input: { command: 'rm -rf ./build' },
      toolCallId: 'toolu_rm',
    })
    await vi.waitFor(() => {
      expect(Permission.getPendingPrompts('chat-1')).toHaveLength(1)
    })
    const prompt = Permission.getPendingPrompts('chat-1')[0]
    // 与本地 bash 工具逐字同款:type 是 bash,标题是命令,pattern 是命令模式。
    expect(prompt.type).toBe('bash')
    expect(prompt.title).toBe('rm -rf ./build')
    expect(prompt.pattern).toEqual(['rm *'])
    expect(prompt.metadata).toMatchObject({
      command: 'rm -rf ./build',
      effectKind: 'bash',
      // 出处仍然写在卡上 —— 卡长得和本地一样之后,这是唯一的标记。
      connectorId: 'claude-code-agent',
      externalAgentTool: 'Bash',
    })

    Permission.respond({ sessionId: 'chat-1', permissionId: prompt.id, response: 'once' })
    await expect(decision).resolves.toEqual({ behavior: 'allow' })
  })

  it('同一档命令二次来命中 grant;换一条命令仍然要问', async () => {
    const { askExternalAgentPermission } = await import('../index.js')
    // 用户上一次点了「总是允许」,记下的是 `rm *` 这一档。
    mocks.grants = [{ type: 'bash', pattern: 'rm *' }]

    await expect(askExternalAgentPermission({
      connectorId: 'claude-code-agent',
      localSessionId: 'chat-1',
      messageId: 'msg-9',
      cwd: '/tmp/p',
      toolName: 'Bash',
      input: { command: 'rm -rf ./build' },
      toolCallId: 'toolu_rm_again',
    })).resolves.toEqual({ behavior: 'allow' })
    expect(Permission.getPendingPrompts('chat-1')).toHaveLength(0)

    // 「总是允许 Bash」不再存在:另一条命令是另一档,照问不误。
    void askExternalAgentPermission({
      connectorId: 'claude-code-agent',
      localSessionId: 'chat-1',
      messageId: 'msg-9',
      cwd: '/tmp/p',
      toolName: 'Bash',
      input: { command: 'curl https://example.com' },
      toolCallId: 'toolu_curl',
    })
    await vi.waitFor(() => {
      expect(Permission.getPendingPrompts('chat-1')).toHaveLength(1)
    })
    expect(Permission.getPendingPrompts('chat-1')[0].pattern).toEqual(['curl *'])
  })

  it('白名单命令与本地一样直接放行,不再逼用户去点「总是允许 Bash」', async () => {
    const { askExternalAgentPermission } = await import('../index.js')
    await expect(askExternalAgentPermission({
      connectorId: 'claude-code-agent',
      localSessionId: 'chat-1',
      messageId: 'msg-9',
      cwd: '/tmp/p',
      toolName: 'Bash',
      input: { command: 'ls -la' },
      toolCallId: 'toolu_ls',
    })).resolves.toEqual({ behavior: 'allow' })
    expect(Permission.getPendingPrompts('chat-1')).toHaveLength(0)
  })

  it('文件工具按路径,越界写把 external 位立起来', async () => {
    const { askExternalAgentPermission } = await import('../index.js')
    void askExternalAgentPermission({
      connectorId: 'claude-code-agent',
      localSessionId: 'chat-1',
      messageId: 'msg-9',
      cwd: '/tmp/p',
      toolName: 'Write',
      input: { file_path: '/tmp/elsewhere/notes.md', content: 'x' },
      toolCallId: 'toolu_write',
    })
    await vi.waitFor(() => {
      expect(Permission.getPendingPrompts('chat-1')).toHaveLength(1)
    })
    const prompt = Permission.getPendingPrompts('chat-1')[0]
    expect(prompt.type).toBe('file_write')
    expect(prompt.pattern).toEqual(['/tmp/elsewhere/*'])
    // 批 1 的 auto-accept 判据只看这一位;立不起来,越界写在 auto-accept-edits 下无声通过。
    expect(prompt.metadata).toMatchObject({ external: true, path: '/tmp/elsewhere/notes.md' })
  })

  it('界内的写按目录记档,external 位不立', async () => {
    const { askExternalAgentPermission } = await import('../index.js')
    void askExternalAgentPermission({
      connectorId: 'claude-code-agent',
      localSessionId: 'chat-1',
      messageId: 'msg-9',
      cwd: '/tmp/p',
      toolName: 'Edit',
      input: { file_path: '/tmp/p/src/app.ts', old_string: 'a', new_string: 'b' },
      toolCallId: 'toolu_edit',
    })
    await vi.waitFor(() => {
      expect(Permission.getPendingPrompts('chat-1')).toHaveLength(1)
    })
    const prompt = Permission.getPendingPrompts('chat-1')[0]
    expect(prompt.type).toBe('file_edit')
    expect(prompt.pattern).toEqual(['/tmp/p/src/*'])
    expect(prompt.metadata).toMatchObject({ external: false })
  })
})

describe('提问的落点(§4)', () => {
  it('pair 房没有人类 → 当场 declined,不发起一次空等', async () => {
    const { askExternalAgentInteraction } = await import('../index.js')
    const answer = await askExternalAgentInteraction({
      connectorId: 'claude-code-agent',
      localSessionId: 'pair-exec',
      toolCallId: 'toolu_ask',
      questions: [{ id: 'q0', question: 'A 还是 B?', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    expect(answer.outcome).toBe('declined')
    expect(answer.reason).toContain('没有人类在场')
    // 一条 pending 都不该留下 —— 空等正是我们要消掉的东西。
    expect(Interaction.getPending('pair-exec')).toHaveLength(0)
  })

  it('有人在的房间照旧起一张真卡,并按 toolCallId 归位', async () => {
    const { askExternalAgentInteraction } = await import('../index.js')
    const answer = askExternalAgentInteraction({
      connectorId: 'claude-code-agent',
      localSessionId: 'team-exec',
      toolCallId: 'toolu_ask',
      questions: [{ id: 'q0', question: 'A 还是 B?', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    await vi.waitFor(() => {
      expect(Interaction.getPending('team-exec')).toHaveLength(1)
    })
    expect(Interaction.getPending('team-exec')[0].toolCallId).toBe('toolu_ask')

    Interaction.respond({
      sessionId: 'team-exec',
      toolCallId: 'toolu_ask',
      answers: { q0: { selected: ['B'] } },
    })
    await expect(answer).resolves.toMatchObject({
      outcome: 'answered',
      answers: { q0: { selected: ['B'] } },
    })
  })

  /**
   * 归位的**第二档**,外部这一侧。审批那一格 2026-08-11 已经收口(`message-anchor.ts`),
   * 提问那一格当时漏了:`ExternalAgentInteractionAsk` 一直带着 `messageId`,而
   * `Interaction.ask` 那一行没接 —— 于是提问卡在渲染侧只剩 `toolCallId` 一档。
   * 后台子代理的嵌套 callId 在消息上不存在,那一档必然落空,卡片于是尾泊到会话末尾
   * (= 新消息出现的位置),被读成「我答完之后冒出一条消息」。
   *
   * 判据与审批共用同一个所有者:锚必须是**会话里真的有的那条消息**。
   */
  it('连接器没给 messageId 时,提问的消息锚落到真的有的那条消息上', async () => {
    mocks.sessions.set('team-exec', {
      id: 'team-exec',
      kind: 'agent',
      collab: { roomSessionId: 'team-room' },
      messages: [
        { id: 'u-1', role: 'user', origin: GOAL_ORIGIN },
        { id: 'a-1', role: 'assistant', origin: GOAL_ORIGIN },
      ],
    } as never)

    const { askExternalAgentInteraction } = await import('../index.js')
    const answer = askExternalAgentInteraction({
      connectorId: 'claude-code-agent',
      localSessionId: 'team-exec',
      // 后台子代理的嵌套 tool_use id:消息上没有这张工具卡,第 1 档必然落空。
      toolCallId: 'toolu_nested_ask',
      questions: [{ id: 'q0', question: 'A 还是 B?', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    await vi.waitFor(() => {
      expect(Interaction.getPending('team-exec')).toHaveLength(1)
    })

    const request = Interaction.getPending('team-exec')[0]
    expect(request.toolCallId).toBe('toolu_nested_ask')
    expect(request.messageId).toBeTruthy()
    const messages = (mocks.sessions.get('team-exec') as FakeSession).messages
    expect(messages.some(message => message.id === request.messageId)).toBe(true)

    Interaction.respond({
      sessionId: 'team-exec',
      toolCallId: 'toolu_nested_ask',
      answers: { q0: { selected: ['A'] } },
    })
    await expect(answer).resolves.toMatchObject({ outcome: 'answered' })
  })
})

describe('停止链上的外部中断(G10)', () => {
  it('能力表说有 interrupt 才调它', async () => {
    const module = await import('../index.js')
    const connector = module.getExternalAgentConnectors()['claude-code-agent']!
    const spy = vi.spyOn(connector, 'interrupt').mockResolvedValue(undefined)

    await module.interruptExternalAgentSessions('exec-1')
    expect(spy).toHaveBeenCalledWith('exec-1')

    // 表里翻一行,行为就跟着变 —— 声明与真实能力不分家(原则 5)。
    spy.mockClear()
    mocks.interruptCapable = false
    await module.interruptExternalAgentSessions('exec-1')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

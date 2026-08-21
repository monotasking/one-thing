/**
 * N1 —— 跨会话信使与感知快照的**装配层**验收
 * (docs/design/pi-benchmark-adoption-2026-08.md)。
 *
 * 这一份打的是"只有产品层知道的事实"那一半:三态投递矩阵真的走了哪条既有链路、
 * 循环闸的两道门、注入消息的身份戳、以及快照的状态判定优先序。声明门与协议形状
 * 在 core 那一份(`packages/core/plugins/__tests__/sessions.test.ts`)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSessionFacadeMock } from '../../../session/testing/facade-mock.js'

const pendingPrompts = new Map<string, unknown[]>()
const sessions = new Map<string, {
  name: string
  updatedAt: number
  lastModel?: string
  lastProvider?: string
  messages: Array<{ role: string; content: string; timestamp: number; toolCalls?: Array<{ status: string; toolName: string }> }>
}>()
const tokenUsage = new Map<string, { contextSize: number; lastInputTokens: number }>()
let coordinatorDriven = new Set<string>()

// P0.2 ③:业务代码改走 `sessionCommands` / `sessionReads`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。这两扇门换成共用替身,
// 读写落在下面同一份假会话表上 —— 与迁移前 `store.js` 假表的语义逐条对齐。
vi.mock('../../../session/reads.js', () => import('../../../session/testing/facade-mock.js'))
vi.mock('../../../session/commands.js', () => import('../../../session/testing/facade-mock.js'))
bindSessionFacadeMock((id: string) => sessions.get(id))

vi.mock('@onething/core/permission', () => ({
  Permission: {
    getPendingPrompts: (sessionId: string) => pendingPrompts.get(sessionId) ?? [],
  },
}))

vi.mock('../../../store.js', () => ({
  getSessionDetails: (sessionId: string) => {
    const session = sessions.get(sessionId)
    return session
      ? {
        id: sessionId,
        name: session.name,
        updatedAt: session.updatedAt,
        lastModel: session.lastModel,
        lastProvider: session.lastProvider,
      }
      : undefined
  },
  getSession: (sessionId: string) => sessions.get(sessionId),
  getSessionsList: () => [...sessions].map(([id, session]) => ({
    id,
    name: session.name,
    updatedAt: session.updatedAt,
  })),
  getSessionTokenUsage: (sessionId: string) => tokenUsage.get(sessionId) ?? null,
  getSessionMessagesPage: ({ sessionId }: { sessionId: string }) => {
    const messages = sessions.get(sessionId)?.messages ?? []
    return { success: true, messages: messages.slice(-1) }
  },
}))

vi.mock('../../collab/ingress.js', () => ({
  isCollabCoordinatorDrivenSession: (sessionId: string) => coordinatorDriven.has(sessionId),
}))

vi.mock('../../providers/model-registry.js', () => ({
  getModelContextLength: async (model: string) => (model === 'known-model' ? 200_000 : 0),
}))

async function load() {
  return import('../sessions.js')
}

interface EmittedCommand {
  sessionId: string
  event: Record<string, unknown>
}

function harness(options: { busy?: string[] } = {}) {
  const emitted: EmittedCommand[] = []
  const steered: Array<{ sessionId: string; content: string; source: string; origin: unknown }> = []
  const followedUp: Array<{ sessionId: string; content: string; source: string; origin: unknown }> = []
  const busy = new Set(options.busy ?? [])
  const eventBus = {
    async emit(sessionId: string, event: Record<string, unknown>) {
      emitted.push({ sessionId, event })
    },
  }
  const streamEngine = {
    getActiveSessionIds: () => [...busy],
    steerMessage(sessionId: string, content: string, source: string, origin: unknown) {
      steered.push({ sessionId, content, source, origin })
    },
    followUpMessage(sessionId: string, content: string, source: string, origin: unknown) {
      followedUp.push({ sessionId, content, source, origin })
    },
  }
  return { emitted, steered, followedUp, busy, deps: { eventBus, streamEngine } as never }
}

function seedSession(id: string, overrides: Partial<{
  name: string
  updatedAt: number
  lastModel: string
  lastProvider: string
  messages: Array<{ role: string; content: string; timestamp: number; toolCalls?: Array<{ status: string; toolName: string }> }>
}> = {}): void {
  sessions.set(id, {
    name: overrides.name ?? `Session ${id}`,
    updatedAt: overrides.updatedAt ?? 1000,
    lastModel: overrides.lastModel,
    lastProvider: overrides.lastProvider,
    messages: overrides.messages ?? [],
  })
}

beforeEach(async () => {
  const { resetPluginSessionLedgers } = await load()
  resetPluginSessionLedgers()
  sessions.clear()
  pendingPrompts.clear()
  tokenUsage.clear()
  coordinatorDriven = new Set()
})

describe('N1-a 三态投递矩阵', () => {
  it('triggerTurn:true × 空闲 → 起一轮(既有 command:send-message 链路)', async () => {
    const { pluginSendMessage } = await load()
    const h = harness()
    seedSession('a')

    const result = await pluginSendMessage(h.deps, 'session-link', 'a', 'hello', { triggerTurn: true })

    expect(result).toMatchObject({ ok: true, delivered: 'triggered', targetWasBusy: false, hop: 1 })
    expect(h.emitted).toHaveLength(1)
    expect(h.emitted[0].sessionId).toBe('a')
    expect(h.emitted[0].event.type).toBe('command:send-message')
    expect(h.emitted[0].event.content).toBe('hello')
    // channel 刻意不设 —— 引擎按 'ipc' 记,桌面 UI 才答得了权限卡。
    expect(h.emitted[0].event.channel).toBeUndefined()
    expect(h.steered).toHaveLength(0)
  })

  it('triggerTurn:true × 忙 → 降级为 steer,并如实说明(不抛错)', async () => {
    const { pluginSendMessage } = await load()
    const h = harness({ busy: ['a'] })
    seedSession('a')

    const result = await pluginSendMessage(h.deps, 'session-link', 'a', 'hello', { triggerTurn: true })

    expect(result).toMatchObject({ ok: true, delivered: 'steered', targetWasBusy: true })
    expect(h.emitted).toHaveLength(0)
    expect(h.steered).toHaveLength(1)
  })

  it('triggerTurn:false(以及缺省)→ posted:持久化 + 显示,不起轮', async () => {
    const { pluginSendMessage } = await load()
    const h = harness()
    seedSession('a')

    const explicit = await pluginSendMessage(h.deps, 'p', 'a', 'x', { triggerTurn: false })
    const implicit = await pluginSendMessage(h.deps, 'p', 'a', 'y', {})

    expect(explicit.delivered).toBe('posted')
    expect(implicit.delivered).toBe('posted')
    expect(h.emitted).toHaveLength(0)
    expect(h.steered).toHaveLength(2)
  })

  it('deliverAs 映射既有队列;nextTurn 诚实落到 follow-up(没有第三条队列)', async () => {
    const { pluginSendMessage } = await load()
    const h = harness()
    seedSession('a')

    expect((await pluginSendMessage(h.deps, 'p', 'a', '1', { deliverAs: 'steer' })).delivered).toBe('steered')
    expect((await pluginSendMessage(h.deps, 'p', 'a', '2', { deliverAs: 'followUp' })).delivered).toBe('followed-up')
    expect((await pluginSendMessage(h.deps, 'p', 'a', '3', { deliverAs: 'nextTurn' })).delivered).toBe('followed-up')

    expect(h.steered).toHaveLength(1)
    expect(h.followedUp).toHaveLength(2)
    expect(h.emitted).toHaveLength(0)
  })

  it('deliverAs 压过 triggerTurn —— 显式选队列就不再起轮', async () => {
    const { pluginSendMessage } = await load()
    const h = harness()
    seedSession('a')

    const result = await pluginSendMessage(h.deps, 'p', 'a', 'x', { triggerTurn: true, deliverAs: 'steer' })
    expect(result.delivered).toBe('steered')
    expect(h.emitted).toHaveLength(0)
  })

  it('会话不存在 / 协作房 → 结构化拒绝,而不是静默失败', async () => {
    const { pluginSendMessage } = await load()
    const h = harness()
    seedSession('room')
    coordinatorDriven.add('room')

    expect(await pluginSendMessage(h.deps, 'p', 'ghost', 'x', { triggerTurn: true }))
      .toMatchObject({ ok: false, reason: 'unknown-session' })
    expect(await pluginSendMessage(h.deps, 'p', 'room', 'x', { triggerTurn: true }))
      .toMatchObject({ ok: false, reason: 'unsupported' })
    expect(h.emitted).toHaveLength(0)
  })
})

describe('N1-a 消息身份戳(origin)', () => {
  it('每条注入都带 plugin:<id> 的 source 与结构化 plugin 戳', async () => {
    const { pluginSendMessage } = await load()
    const h = harness({ busy: ['a'] })
    seedSession('a')

    await pluginSendMessage(h.deps, 'session-link', 'a', 'x', { triggerTurn: true })

    const origin = h.steered[0].origin as { source: string; plugin: { id: string; hop: number }; transport: string }
    expect(h.steered[0].source).toBe('plugin:session-link')
    expect(origin.source).toBe('plugin:session-link')
    expect(origin.transport).toBe('api')
    expect(origin.plugin).toEqual({ id: 'session-link', hop: 1 })
  })

  it('起轮那条命令同样带戳 —— 两条路的归因是同一份', async () => {
    const { pluginSendMessage } = await load()
    const h = harness()
    seedSession('a')

    await pluginSendMessage(h.deps, 'session-link', 'a', 'x', { triggerTurn: true })

    const event = h.emitted[0].event as { source: string; origin: { plugin: { id: string; hop: number } } }
    expect(event.source).toBe('plugin:session-link')
    expect(event.origin.plugin).toEqual({ id: 'session-link', hop: 1 })
  })
})

describe('N1-a 循环闸', () => {
  it('跳数逐轮 +1,越过上限即拒绝(结构化 reason)', async () => {
    const { pluginSendMessage, resetPluginSessionLedgers } = await load()
    resetPluginSessionLedgers()
    const h = harness()
    seedSession('a')
    seedSession('b')

    // 每一跳都投给"另一个"会话,并让上一跳的会话保持在飞 —— 这就是两个会话
    // 互相回话的形状。第 8 跳还在,第 9 跳被拒。
    const hops: number[] = []
    for (let index = 0; index < 8; index += 1) {
      const target = index % 2 === 0 ? 'a' : 'b'
      const result = await pluginSendMessage(h.deps, 'p', target, `m${index}`, { triggerTurn: true })
      h.busy.add(target)
      expect(result.ok).toBe(true)
      hops.push(result.hop as number)
    }
    expect(hops).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    const refused = await pluginSendMessage(h.deps, 'p', 'a', 'one more', { triggerTurn: true })
    expect(refused).toMatchObject({ ok: false, reason: 'hop-limit', hop: 9 })
  })

  it('没有在飞的插件链时跳数回到 1 —— 闸不会永久卡死正常使用', async () => {
    const { pluginSendMessage } = await load()
    const h = harness()
    seedSession('a')

    const first = await pluginSendMessage(h.deps, 'p', 'a', 'x', { triggerTurn: true })
    expect(first.hop).toBe(1)
    // 时间往前走过宽限期、且会话没有活跃流 → 上一条作废。
    const second = await pluginSendMessage(
      { ...(h.deps as unknown as Record<string, unknown>), now: () => Date.now() + 60_000 } as never,
      'p',
      'a',
      'y',
      { triggerTurn: true },
    )
    expect(second.hop).toBe(1)
  })

  it('每 (插件, 会话) 对的频率闸:超限拒绝,换一个会话不受影响', async () => {
    const { pluginSendMessage } = await load()
    const h = harness()
    seedSession('a')
    seedSession('b')

    for (let index = 0; index < 10; index += 1) {
      expect((await pluginSendMessage(h.deps, 'p', 'a', `m${index}`, {})).ok).toBe(true)
    }
    const refused = await pluginSendMessage(h.deps, 'p', 'a', 'over', {})
    expect(refused).toMatchObject({ ok: false, reason: 'rate-limited' })

    // 另一个会话是另一条车道。
    expect((await pluginSendMessage(h.deps, 'p', 'b', 'ok', {})).ok).toBe(true)
    // 另一个插件也是。
    expect((await pluginSendMessage(h.deps, 'other', 'a', 'ok', {})).ok).toBe(true)
  })
})

describe('N1-b 感知快照', () => {
  it('状态判定优先序:awaiting-permission > tool-running > generating > idle', async () => {
    const { pluginPeekSession } = await load()
    seedSession('a', {
      messages: [{
        role: 'assistant',
        content: 'working',
        timestamp: 5,
        toolCalls: [{ status: 'executing', toolName: 'bash' }],
      }],
    })

    const idle = harness()
    expect((await pluginPeekSession(idle.deps, 'a'))?.state).toBe('idle')

    const running = harness({ busy: ['a'] })
    const toolRunning = await pluginPeekSession(running.deps, 'a')
    expect(toolRunning?.state).toBe('tool-running')
    expect(toolRunning?.currentTool).toBe('bash')

    // 挂着审批卡时,活跃流仍在、工具仍是 executing —— 但这轮一步也不会动。
    pendingPrompts.set('a', [{ id: 'p1' }])
    expect((await pluginPeekSession(running.deps, 'a'))?.state).toBe('awaiting-permission')
    pendingPrompts.clear()

    // 没有 executing 的工具 = 纯生成。
    seedSession('b', { messages: [{ role: 'assistant', content: 'thinking', timestamp: 6 }] })
    const generating = harness({ busy: ['b'] })
    expect((await pluginPeekSession(generating.deps, 'b'))?.state).toBe('generating')
  })

  it('lastMessage 只读尾一条,preview 硬截 120 字符', async () => {
    const { pluginPeekSession } = await load()
    seedSession('a', {
      messages: [
        { role: 'user', content: 'old', timestamp: 1 },
        { role: 'assistant', content: `${'x'.repeat(400)}`, timestamp: 2 },
      ],
    })
    const h = harness()

    const peek = await pluginPeekSession(h.deps, 'a')
    expect(peek?.lastMessage?.role).toBe('assistant')
    expect(peek?.lastMessage?.at).toBe(2)
    expect(peek?.lastMessage?.preview.length).toBe(120)
  })

  it('contextPercent 复用 ctx 仪表口径;解析不出窗口就不给这个键', async () => {
    const { pluginPeekSession } = await load()
    const h = harness()

    seedSession('known', { lastModel: 'known-model' })
    tokenUsage.set('known', { contextSize: 50_000, lastInputTokens: 0 })
    expect((await pluginPeekSession(h.deps, 'known'))?.contextPercent).toBe(25)

    seedSession('unknown', { lastModel: 'mystery-model' })
    tokenUsage.set('unknown', { contextSize: 50_000, lastInputTokens: 0 })
    expect((await pluginPeekSession(h.deps, 'unknown'))).not.toHaveProperty('contextPercent')

    seedSession('nomodel')
    expect((await pluginPeekSession(h.deps, 'nomodel'))).not.toHaveProperty('contextPercent')
  })

  it('会话不存在 → null(而不是一份编造的空闲快照)', async () => {
    const { pluginPeekSession } = await load()
    expect(await pluginPeekSession(harness().deps, 'ghost')).toBeNull()
  })

  it('list() 是 peek-lite:无 lastMessage / contextPercent,按 updatedAt 降序', async () => {
    const { pluginListSessions } = await load()
    seedSession('old', { updatedAt: 10, messages: [{ role: 'user', content: 'hi', timestamp: 1 }] })
    seedSession('new', { updatedAt: 99 })
    seedSession('mid', { updatedAt: 50 })

    const list = await pluginListSessions(harness().deps)
    expect(list.map(entry => entry.sessionId)).toEqual(['new', 'mid', 'old'])
    expect(list[2]).not.toHaveProperty('lastMessage')
    expect(list[2]).not.toHaveProperty('contextPercent')
  })

  it('返回值 JSON 可序列化(宪法第 2 条:它过的是一条将来会变成 RPC 的边界)', async () => {
    const { pluginPeekSession, pluginListSessions, pluginSendMessage } = await load()
    const h = harness()
    seedSession('a', { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] })

    const peek = await pluginPeekSession(h.deps, 'a')
    const list = await pluginListSessions(h.deps)
    const sent = await pluginSendMessage(h.deps, 'p', 'a', 'x', {})

    for (const value of [peek, list, sent]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value)
    }
  })
})

/**
 * 派工的装配层验收(自举差距审计 P0-3 / P0-5,
 * `docs/audit/self-hosting-gap-audit-2026-08-11.md`)。
 *
 * 打的是审计骂的那四条语义有没有被真的翻过来:
 * 调用即开跑、cwd 继承调用方、跑完**叫醒**调用方、回报**不截断**;
 * 外加 v1 的两道闸(禁套娃 / 并发上限)。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { bindSessionFacadeMock } from '../../session/testing/facade-mock.js'

interface FakeSession {
  id: string
  name: string
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  permissionMode?: string
  lastProvider?: string
  lastModel?: string
  task?: { parentSessionId: string } | undefined
  messages: Array<{ role: string; content: string }>
}

const sessions = new Map<string, FakeSession>()
const storeCalls = {
  created: [] as Array<{ id: string; name: string }>,
  task: [] as Array<{ id: string; task: unknown }>,
  workdir: [] as Array<{ id: string; dir: string }>,
  workdirRoots: [] as Array<{ id: string; roots: string[] }>,
  permission: [] as Array<{ id: string; mode: string }>,
  model: [] as Array<{ id: string; providerId: string; modelId: string; pinned?: boolean }>,
}

// P0.2 ③:业务代码改走 `sessionCommands` / `sessionReads`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。这两扇门换成共用替身,
// 读写落在下面同一份假会话表上 —— 与迁移前 `store.js` 假表的语义逐条对齐。
vi.mock('../../session/reads.js', () => import('../../session/testing/facade-mock.js'))
vi.mock('../../session/commands.js', () => import('../../session/testing/facade-mock.js'))
bindSessionFacadeMock((id: string) => sessions.get(id))

vi.mock('../../store.js', () => ({
  getSession: (id: string) => sessions.get(id),
  createSessionWithoutFocus: (id: string, name: string) => {
    storeCalls.created.push({ id, name })
    const session: FakeSession = { id, name, messages: [] }
    sessions.set(id, session)
    return session
  },
  updateSessionTask: (id: string, task: unknown) => {
    storeCalls.task.push({ id, task })
    const session = sessions.get(id)
    if (session) session.task = task as FakeSession['task']
    return true
  },
  updateSessionWorkingDirectory: (id: string, dir: string) => {
    storeCalls.workdir.push({ id, dir })
    const session = sessions.get(id)
    if (session) session.workingDirectory = dir
    return true
  },
  updateSessionWorkingDirectoryRoots: (id: string, roots: string[]) => {
    storeCalls.workdirRoots.push({ id, roots })
    return true
  },
  updateSessionPermissionMode: (id: string, mode: string) => {
    storeCalls.permission.push({ id, mode })
    return true
  },
  updateSessionModel: (
    id: string,
    providerId: string,
    modelId: string,
    options?: { pinned?: boolean },
  ) => {
    storeCalls.model.push({ id, providerId, modelId, pinned: options?.pinned })
    return true
  },
}))

type BusHandler = (envelope: { event: { type?: string } }) => void

const busHandlers = new Map<string, Set<BusHandler>>()
const emitted: Array<{ sessionId: string; event: Record<string, unknown> }> = []

vi.mock('../../events/index.js', () => ({
  getEventBus: () => ({
    async emit(sessionId: string, event: Record<string, unknown>) {
      emitted.push({ sessionId, event })
    },
    onAny(sessionId: string, handler: BusHandler) {
      const set = busHandlers.get(sessionId) ?? new Set<BusHandler>()
      set.add(handler)
      busHandlers.set(sessionId, set)
      return () => set.delete(handler)
    },
  }),
}))

vi.mock('../../engine/index.js', () => ({
  getStreamEngineSafe: () => ({ getActiveSessionIds: () => [] }),
}))

const delivered: Array<{
  actorKey: string
  sessionId: string
  content: string
  options: Record<string, unknown>
  origin: unknown
}> = []

vi.mock('../../plugins/sessions.js', () => ({
  deliverInternalMessage: async (
    _deps: unknown,
    request: {
      actorKey: string
      sessionId: string
      content: string
      options: Record<string, unknown>
      origin: (hop: number, now: number) => unknown
    },
  ) => {
    delivered.push({
      actorKey: request.actorKey,
      sessionId: request.sessionId,
      content: request.content,
      options: request.options,
      origin: request.origin(1, 1000),
    })
    return { ok: true, delivered: 'triggered', hop: 1 }
  },
}))

async function load() {
  return import('../dispatch.js')
}

function seedCaller(id: string, overrides: Partial<FakeSession> = {}): void {
  sessions.set(id, {
    id,
    name: overrides.name ?? `Session ${id}`,
    messages: overrides.messages ?? [],
    ...(overrides.workingDirectory ? { workingDirectory: overrides.workingDirectory } : {}),
    ...(overrides.workingDirectoryRoots ? { workingDirectoryRoots: overrides.workingDirectoryRoots } : {}),
    ...(overrides.permissionMode ? { permissionMode: overrides.permissionMode } : {}),
    ...(overrides.lastProvider ? { lastProvider: overrides.lastProvider } : {}),
    ...(overrides.lastModel ? { lastModel: overrides.lastModel } : {}),
    ...(overrides.task ? { task: overrides.task } : {}),
  })
}

/** 引擎在这条会话上跑完了一轮。 */
function fireTerminal(sessionId: string, type: string): void {
  for (const handler of busHandlers.get(sessionId) ?? []) handler({ event: { type } })
}

let seed = 0
const nextId = () => `task-session-${++seed}`

beforeEach(async () => {
  vi.useFakeTimers()
  const { resetTaskDispatchLedger } = await load()
  resetTaskDispatchLedger()
  sessions.clear()
  busHandlers.clear()
  emitted.length = 0
  delivered.length = 0
  storeCalls.created.length = 0
  storeCalls.task.length = 0
  storeCalls.workdir.length = 0
  storeCalls.workdirRoots.length = 0
  storeCalls.permission.length = 0
  storeCalls.model.length = 0
  seed = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('dispatchTask', () => {
  it('starts a background session and returns immediately (fire-and-report)', async () => {
    const { dispatchTask } = await load()
    seedCaller('caller', {
      workingDirectory: '/repo',
      permissionMode: 'auto-accept-edits',
      lastProvider: 'anthropic',
      lastModel: 'claude-x',
    })

    const outcome = await dispatchTask(
      { callerSessionId: 'caller', prompt: '数一下 packages/core 有多少 test 文件', description: '数 test' },
      { newTaskSessionId: nextId },
    )

    expect(outcome).toMatchObject({ ok: true, taskSessionId: 'task-session-1', running: 1 })
    // 不抢焦点。
    expect(storeCalls.created).toEqual([{ id: 'task-session-1', name: '[派工] 数 test' }])
    // 派工戳指回调用方 —— 完成回流靠它。
    expect(storeCalls.task[0]?.task).toMatchObject({ parentSessionId: 'caller' })
    // 驱动走的是既有的 command:send-message,身份戳是 task 一族。
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.sessionId).toBe('task-session-1')
    expect(emitted[0]?.event).toMatchObject({
      type: 'command:send-message',
      content: '数一下 packages/core 有多少 test 文件',
      source: 'task:task-session-1',
    })
  })

  it('inherits the caller session working directory (never a collab room folder)', async () => {
    const { dispatchTask } = await load()
    seedCaller('caller', { workingDirectory: '/repo', workingDirectoryRoots: ['/repo/extra'] })

    const outcome = await dispatchTask(
      { callerSessionId: 'caller', prompt: 'go' },
      { newTaskSessionId: nextId },
    )

    expect(outcome).toMatchObject({ ok: true, workingDirectory: '/repo' })
    expect(storeCalls.workdir).toEqual([{ id: 'task-session-1', dir: '/repo' }])
    expect(storeCalls.workdirRoots).toEqual([{ id: 'task-session-1', roots: ['/repo/extra'] }])
  })

  it('lets an explicit workingDirectory win over the inherited one', async () => {
    const { dispatchTask } = await load()
    seedCaller('caller', { workingDirectory: '/repo' })

    const outcome = await dispatchTask(
      { callerSessionId: 'caller', prompt: 'go', workingDirectory: '/elsewhere' },
      { newTaskSessionId: nextId },
    )

    expect(outcome).toMatchObject({ ok: true, workingDirectory: '/elsewhere' })
  })

  it('inherits the caller permission mode and model, and pins only an explicit model', async () => {
    const { dispatchTask } = await load()
    seedCaller('caller', {
      permissionMode: 'normal',
      lastProvider: 'anthropic',
      lastModel: 'claude-x',
    })

    await dispatchTask({ callerSessionId: 'caller', prompt: 'go' }, { newTaskSessionId: nextId })
    expect(storeCalls.permission).toEqual([{ id: 'task-session-1', mode: 'normal' }])
    expect(storeCalls.model).toEqual([
      { id: 'task-session-1', providerId: 'anthropic', modelId: 'claude-x', pinned: false },
    ])

    await dispatchTask(
      { callerSessionId: 'caller', prompt: 'go', model: 'other-model' },
      { newTaskSessionId: nextId },
    )
    expect(storeCalls.model[1]).toEqual({
      id: 'task-session-2',
      providerId: 'anthropic',
      modelId: 'other-model',
      pinned: true,
    })
  })

  it('refuses nested dispatch from a task session', async () => {
    const { dispatchTask } = await load()
    seedCaller('worker', { task: { parentSessionId: 'caller' } })

    const outcome = await dispatchTask(
      { callerSessionId: 'worker', prompt: 'go' },
      { newTaskSessionId: nextId },
    )

    expect(outcome).toEqual({ ok: false, reason: 'nested' })
    expect(storeCalls.created).toHaveLength(0)
  })

  it('refuses the fifth concurrent task on one caller session', async () => {
    const { dispatchTask } = await load()
    seedCaller('caller')

    for (let index = 0; index < 4; index += 1) {
      const outcome = await dispatchTask(
        { callerSessionId: 'caller', prompt: `go ${index}` },
        { newTaskSessionId: nextId },
      )
      expect(outcome.ok).toBe(true)
    }

    const fifth = await dispatchTask(
      { callerSessionId: 'caller', prompt: 'go 5' },
      { newTaskSessionId: nextId },
    )
    expect(fifth.ok).toBe(false)
    expect(fifth).toMatchObject({ reason: 'concurrency' })

    // 别的会话不受这条会话的账影响。
    seedCaller('other')
    const elsewhere = await dispatchTask(
      { callerSessionId: 'other', prompt: 'go' },
      { newTaskSessionId: nextId },
    )
    expect(elsewhere.ok).toBe(true)
  })

  it('frees a concurrency slot once a task reports back', async () => {
    const { dispatchTask, runningTaskCount } = await load()
    seedCaller('caller')

    await dispatchTask({ callerSessionId: 'caller', prompt: 'go' }, { newTaskSessionId: nextId })
    expect(runningTaskCount('caller')).toBe(1)

    fireTerminal('task-session-1', 'stream:complete')
    await vi.advanceTimersByTimeAsync(0)

    expect(runningTaskCount('caller')).toBe(0)
  })

  it('wakes the caller with the FULL closing text (no 200-char truncation)', async () => {
    const { dispatchTask } = await load()
    seedCaller('caller')

    await dispatchTask(
      { callerSessionId: 'caller', prompt: 'go', description: '数 test' },
      { newTaskSessionId: nextId },
    )

    const body = `${'结论:'.repeat(4)}${'x'.repeat(900)}`
    sessions.get('task-session-1')!.messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '中间一轮' },
      { role: 'assistant', content: body },
    ]

    fireTerminal('task-session-1', 'stream:start')
    fireTerminal('task-session-1', 'stream:complete')
    await vi.advanceTimersByTimeAsync(0)

    expect(delivered).toHaveLength(1)
    const report = delivered[0]!
    // 投回**调用方**,不是工作会话。
    expect(report.sessionId).toBe('caller')
    // 走的是唤醒那一格:空闲起一轮 / 在忙降级 steer。
    expect(report.options).toEqual({ triggerTurn: true })
    // 身份戳是 task 一族,链长账与插件同一本。
    expect(report.actorKey).toBe('task:task-session-1')
    expect(report.origin).toMatchObject({
      source: 'task:task-session-1',
      task: { sessionId: 'task-session-1', hop: 1 },
    })
    // 正文整条回来 —— 这是本期的主诉。
    expect(report.content).toContain(body)
    expect(report.content.length).toBeGreaterThan(900)
    expect(report.content).toContain('数 test')
  })

  it('reports error / aborted / timeout honestly instead of going silent', async () => {
    const { dispatchTask } = await load()
    seedCaller('caller')

    await dispatchTask({ callerSessionId: 'caller', prompt: 'a' }, { newTaskSessionId: nextId })
    fireTerminal('task-session-1', 'stream:error')
    await vi.advanceTimersByTimeAsync(0)
    expect(delivered[0]?.content).toContain('出错结束')

    await dispatchTask({ callerSessionId: 'caller', prompt: 'b' }, { newTaskSessionId: nextId })
    fireTerminal('task-session-2', 'stream:aborted')
    await vi.advanceTimersByTimeAsync(0)
    expect(delivered[1]?.content).toContain('被中止')

    // 命令根本没起流(宿主没有投递面)—— 起流超时后仍然报一句话回去。
    await dispatchTask({ callerSessionId: 'caller', prompt: 'c' }, { newTaskSessionId: nextId })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(delivered[2]?.content).toContain('超时结束')
  })

  it('rejects when the calling session is gone', async () => {
    const { dispatchTask } = await load()
    const outcome = await dispatchTask(
      { callerSessionId: 'ghost', prompt: 'go' },
      { newTaskSessionId: nextId },
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'unsupported' })
  })
})

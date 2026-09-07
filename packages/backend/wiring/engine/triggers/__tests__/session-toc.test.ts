/**
 * The TOC trigger must never do its model call inline: triggers are awaited in
 * series after every response, so a synchronous call here would stretch each
 * turn's teardown. It also must not segment against a turn the conversation
 * has already moved past.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { messages: Array<{ role: string; id: string; timestamp: number; reasoning?: string }> }>(),
  recordTocTurn: vi.fn(async (_input: Record<string, unknown>, _options: { signal?: AbortSignal }) => undefined),
  collectGoalFileChanges: vi.fn(async () => [] as Array<{ path: string; added: number; removed: number }>),
}))

// 读走门面(P0.2 区 ②):替身与生产同源,`bindSessionFacadeMock` 装的就是这张假会话表。
vi.mock('../../../../session/reads.js', () => import('../../../../session/testing/facade-mock.js'))

vi.mock('../../../toc/index.js', () => ({
  recordTocTurn: mocks.recordTocTurn,
}))

vi.mock('../../../goals/file-changes.js', () => ({
  collectGoalFileChanges: mocks.collectGoalFileChanges,
}))

const { bindSessionFacadeMock } = await import('../../../../session/testing/facade-mock.js')
const { createSessionTocTrigger } = await import('../session-toc.js')
const triggers: ReturnType<typeof createSessionTocTrigger>[] = []
const runTask = vi.fn()
function createTrigger() {
  const trigger = createSessionTocTrigger({
    async runTask(label, run) { runTask(label); return run() },
    assertAccepting: () => {},
  })
  triggers.push(trigger)
  return trigger
}

bindSessionFacadeMock((sessionId: string) => mocks.sessions.get(sessionId))

const SESSION = 's1'

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    lastUserMessage: 'do the thing',
    lastAssistantMessage: 'did the thing',
    toolIterations: 2,
    session: { workingDirectory: '/work' },
    messages: [],
    ...overrides,
  } as never
}

function seed(messages: Array<{ role: string; id: string; timestamp: number; reasoning?: string }>) {
  mocks.sessions.set(SESSION, { messages })
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.sessions.clear()
  mocks.recordTocTurn.mockClear()
  mocks.collectGoalFileChanges.mockClear()
  runTask.mockClear()
})

afterEach(async () => {
  for (const trigger of triggers) trigger.stop()
  await Promise.allSettled(triggers.splice(0).map(trigger => trigger.drain()))
  vi.useRealTimers()
})

describe('session TOC trigger', () => {
  it('returns without calling the model, deferring the work to a timer', async () => {
    seed([{ role: 'assistant', id: 'a1', timestamp: 1000 }])

    await createTrigger().execute(ctx())

    // The whole point: turn teardown does not wait on a model call.
    expect(mocks.recordTocTurn).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.recordTocTurn).toHaveBeenCalledTimes(1)
  })

  it('collapses a rapid back-and-forth into a single call for the newest turn', async () => {
    const trigger = createTrigger()

    seed([{ role: 'assistant', id: 'a1', timestamp: 1000 }])
    await trigger.execute(ctx())

    await vi.advanceTimersByTimeAsync(10_000)
    seed([
      { role: 'assistant', id: 'a1', timestamp: 1000 },
      { role: 'assistant', id: 'a2', timestamp: 2000 },
    ])
    await trigger.execute(ctx())

    await vi.advanceTimersByTimeAsync(60_000)

    expect(mocks.recordTocTurn).toHaveBeenCalledTimes(1)
    expect(mocks.recordTocTurn.mock.calls[0]?.[0]).toMatchObject({ assistantMessageId: 'a2' })
  })

  it('abandons a fired timer whose turn is no longer the newest', async () => {
    // Belt-and-braces for a missed clearTimeout: the fired timer re-checks
    // that its turn is still current before spending anything.
    const trigger = createTrigger()
    seed([{ role: 'assistant', id: 'a1', timestamp: 1000 }])
    await trigger.execute(ctx())

    seed([
      { role: 'assistant', id: 'a1', timestamp: 1000 },
      { role: 'assistant', id: 'a2', timestamp: 2000 },
    ])
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mocks.recordTocTurn).not.toHaveBeenCalled()
  })

  it('passes the assistant reasoning and the away-time signal through', async () => {
    seed([
      { role: 'assistant', id: 'a1', timestamp: 0 },
      { role: 'assistant', id: 'a2', timestamp: 6 * 60_000, reasoning: 'thinking hard' },
    ])

    await createTrigger().execute(ctx())
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mocks.recordTocTurn.mock.calls[0]?.[0]).toMatchObject({
      reasoning: 'thinking hard',
      // Measured from the previous assistant message, not the previous user
      // one — an agent can work for hours on a single instruction.
      awayMinutes: 6,
    })
  })

  it('does nothing for a session with no assistant message yet', async () => {
    seed([{ role: 'user', id: 'u1', timestamp: 1000 }])

    await createTrigger().execute(ctx())
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mocks.recordTocTurn).not.toHaveBeenCalled()
  })

  it('reports a deferred failure to its owner when draining', async () => {
    mocks.recordTocTurn.mockRejectedValueOnce(new Error('provider exploded') as never)
    seed([{ role: 'assistant', id: 'a1', timestamp: 1000 }])

    const trigger = createTrigger()
    await trigger.execute(ctx())
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mocks.recordTocTurn).toHaveBeenCalledTimes(1)
    await expect(trigger.drain()).rejects.toThrow('Session TOC task failed')
  })

  it('drops the session after a failed write instead of throwing the stale failure at it', async () => {
    // 工单 4 A2:失败表从前只增不清 —— 一次写盘失败之后,这个会话**每一次**删除
    // 都会拿那条陈年错误再抛一遍,于是删不掉。
    mocks.recordTocTurn.mockRejectedValueOnce(new Error('disk full') as never)
    seed([{ role: 'assistant', id: 'a1', timestamp: 1000 }])

    const trigger = createTrigger()
    await trigger.execute(ctx())
    await vi.advanceTimersByTimeAsync(60_000)

    await expect(trigger.abortAndDrain(SESSION)).resolves.toBeUndefined()
    // 销过账:接下来的关机也不再被这条陈年失败绊住。
    await expect(trigger.drain()).resolves.toBeUndefined()
  })

  it('reports a failure to shutdown once, not on every drain', async () => {
    mocks.recordTocTurn.mockRejectedValueOnce(new Error('provider exploded') as never)
    seed([{ role: 'assistant', id: 'a1', timestamp: 1000 }])

    const trigger = createTrigger()
    await trigger.execute(ctx())
    await vi.advanceTimersByTimeAsync(60_000)

    await expect(trigger.drain()).rejects.toThrow('Session TOC task failed')
    await expect(trigger.drain()).resolves.toBeUndefined()
  })

  it('clears the session\u0027s failures on its next successful write', async () => {
    mocks.recordTocTurn.mockRejectedValueOnce(new Error('disk full') as never)
    seed([{ role: 'assistant', id: 'a1', timestamp: 1000 }])

    const trigger = createTrigger()
    await trigger.execute(ctx())
    await vi.advanceTimersByTimeAsync(60_000)

    // 下一轮写盘成功 —— 上一条失败销账。
    seed([
      { role: 'assistant', id: 'a1', timestamp: 1000 },
      { role: 'assistant', id: 'a2', timestamp: 2000 },
    ])
    await trigger.execute(ctx())
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mocks.recordTocTurn).toHaveBeenCalledTimes(2)
    await expect(trigger.drain()).resolves.toBeUndefined()
  })

  it('cancels idle work on disposal and leaves a newly assembled trigger usable', async () => {
    seed([{ role: 'assistant', id: 'a1', timestamp: 1000 }])
    const old = createTrigger()
    await old.execute(ctx())
    old.stop()
    await old.drain()
    const fresh = createTrigger()
    await fresh.execute(ctx())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runTask).toHaveBeenCalledTimes(1)
    expect(mocks.recordTocTurn).toHaveBeenCalledTimes(1)
  })

  it.each(['shutdown', 'delete'] as const)('waits for non-cooperative work after %s cancels it', async reason => {
    let release!: () => void
    let signal: AbortSignal | undefined
    mocks.recordTocTurn.mockImplementationOnce(async (_input, options) => {
      signal = options.signal
      await new Promise<void>(resolve => { release = resolve })
      signal?.throwIfAborted()
      return undefined
    })
    seed([{ role: 'assistant', id: 'a1', timestamp: 1000 }])
    const trigger = createTrigger()
    await trigger.execute(ctx())
    await vi.advanceTimersByTimeAsync(60_000)
    if (reason === 'shutdown') trigger.stop()
    const waiting = reason === 'shutdown' ? trigger.drain() : trigger.abortAndDrain(SESSION)
    let drained = false
    void waiting.then(() => { drained = true })
    await Promise.resolve()
    expect(signal?.aborted).toBe(true)
    expect(drained).toBe(false)
    release()
    await waiting
    expect(drained).toBe(true)
  })
})

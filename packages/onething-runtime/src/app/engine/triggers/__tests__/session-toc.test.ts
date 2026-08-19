/**
 * The TOC trigger must never do its model call inline: triggers are awaited in
 * series after every response, so a synchronous call here would stretch each
 * turn's teardown. It also must not segment against a turn the conversation
 * has already moved past.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { messages: Array<{ role: string; id: string; timestamp: number; reasoning?: string }> }>(),
  recordTocTurn: vi.fn(async (_input: Record<string, unknown>) => undefined),
  collectGoalFileChanges: vi.fn(async () => [] as Array<{ path: string; added: number; removed: number }>),
}))

// 读走门面(P0.2 区 ②):替身与生产同源,`bindSessionFacadeMock` 装的就是这张假会话表。
vi.mock('../../../session/reads.js', () => import('../../../session/testing/facade-mock.js'))

vi.mock('../../../toc/index.js', () => ({
  recordTocTurn: mocks.recordTocTurn,
}))

vi.mock('../../../goals/file-changes.js', () => ({
  collectGoalFileChanges: mocks.collectGoalFileChanges,
}))

const { bindSessionFacadeMock } = await import('../../../session/testing/facade-mock.js')
const { createSessionTocTrigger } = await import('../session-toc.js')

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
})

afterEach(() => {
  vi.useRealTimers()
})

describe('session TOC trigger', () => {
  it('returns without calling the model, deferring the work to a timer', async () => {
    seed([{ role: 'assistant', id: 'a1', timestamp: 1000 }])

    await createSessionTocTrigger().execute(ctx())

    // The whole point: turn teardown does not wait on a model call.
    expect(mocks.recordTocTurn).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.recordTocTurn).toHaveBeenCalledTimes(1)
  })

  it('collapses a rapid back-and-forth into a single call for the newest turn', async () => {
    const trigger = createSessionTocTrigger()

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
    const trigger = createSessionTocTrigger()
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

    await createSessionTocTrigger().execute(ctx())
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

    await createSessionTocTrigger().execute(ctx())
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mocks.recordTocTurn).not.toHaveBeenCalled()
  })

  it('survives a segmentation failure without escaping to the caller', async () => {
    mocks.recordTocTurn.mockRejectedValueOnce(new Error('provider exploded') as never)
    seed([{ role: 'assistant', id: 'a1', timestamp: 1000 }])

    await createSessionTocTrigger().execute(ctx())
    // The rejection is swallowed inside the timer; nothing escapes to a caller
    // that has long since returned.
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mocks.recordTocTurn).toHaveBeenCalledTimes(1)
  })
})

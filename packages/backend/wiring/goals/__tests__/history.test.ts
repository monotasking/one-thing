/**
 * GoalManager persistence shape (docs/design/goal-system-v3.md).
 *
 * Before v3 a session held one mutable `goal` field, so finishing a goal and
 * starting another silently destroyed the first — including the fileChanges
 * table that had just been filled in at completion. These tests pin the new
 * contract: goals accumulate as history, stepping aside never deletes, and the
 * v2 scalar keeps being written so an older build still works.
 *
 * The runtime state machine and record helpers are deliberately NOT mocked —
 * the point is the real read/write round trip through a stand-in session store.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSessionFacadeMock } from '../../../session/testing/facade-mock.js'
import type { SessionGoal } from '@onething/runtime/goals'

interface StoredSession {
  id: string
  messages: Array<{ id: string }>
  goal?: SessionGoal
  goals?: SessionGoal[]
}

type FileChange = { path: string; added: number; removed: number }

const mocks = vi.hoisted(() => {
  const sessions = new Map<string, StoredSession>()
  // Keyed by session rather than a single time-varying return value. The
  // completion path fires enrichment as a detached promise whose dynamic
  // import resolves at an unpredictable point — often during a *later* test —
  // so a global mockResolvedValue gets read by the wrong straggler. Keying by
  // session makes the answer correct whenever it happens to be asked.
  const fileChangesBySession = new Map<string, Array<{ path: string; added: number; removed: number }>>()
  return {
    sessions,
    fileChangesBySession,
    emit: vi.fn(),
    collectGoalFileChanges: vi.fn(
      async (sessionId: string) => fileChangesBySession.get(sessionId) ?? [],
    ),
  }
})

// P0.2 ③:业务代码改走 `sessionCommands` / `sessionReads`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。这两扇门换成共用替身,
// 读写落在下面同一份假会话表上 —— 与迁移前 `store.js` 假表的语义逐条对齐。
vi.mock('../../../session/reads.js', () => import('../../../session/testing/facade-mock.js'))
vi.mock('../../../session/commands.js', () => import('../../../session/testing/facade-mock.js'))
bindSessionFacadeMock((id: string) => mocks.sessions.get(id))

vi.mock('../../../store.js', () => ({
  getSession: (sessionId: string) => mocks.sessions.get(sessionId),
  getSettings: () => ({ chat: {} }),
  updateSessionGoal: (sessionId: string, goal: SessionGoal | null) => {
    const session = mocks.sessions.get(sessionId)
    if (!session) return
    if (goal === null) delete session.goal
    else session.goal = goal
  },
  updateSessionGoals: (sessionId: string, goals: SessionGoal[], current: SessionGoal | null) => {
    const session = mocks.sessions.get(sessionId)
    if (!session) return
    if (goals.length === 0) delete session.goals
    else session.goals = goals
    if (current === null) delete session.goal
    else session.goal = current
  },
}))

vi.mock('../../../events/index.js', () => ({
  getEventBus: () => ({ emit: mocks.emit }),
}))

vi.mock('../file-changes.js', () => ({
  collectGoalFileChanges: mocks.collectGoalFileChanges,
}))

const { clearGoal, createGoal, getGoal, getGoals, updateGoalFromModel, updateGoalFromUser } =
  await import('../index.js')

/**
 * Fresh per test. The completion path fires the fileChanges enrichment as a
 * detached promise, which can outlive the test that started it; a unique id
 * means a straggler can never find a record to write into and cannot bleed
 * into the next test.
 */
let SESSION = 's1'
let sessionSeq = 0

function seedSession(messages: string[] = ['m1']): StoredSession {
  const session: StoredSession = { id: SESSION, messages: messages.map(id => ({ id })) }
  mocks.sessions.set(SESSION, session)
  return session
}

function stored(): StoredSession {
  const session = mocks.sessions.get(SESSION)
  if (!session) throw new Error('session missing')
  return session
}

// The completion path reaches file-changes.js through a lazy dynamic import.
// Resolving that module graph the first time costs seconds — enough to blow a
// per-test timeout — so pay it once, up front, rather than inside whichever
// test happens to complete a goal first.
beforeAll(async () => {
  await import('../file-changes.js')
})

function expectFileChanges(changes: FileChange[]): void {
  mocks.fileChangesBySession.set(SESSION, changes)
}

beforeEach(() => {
  SESSION = `s${++sessionSeq}`
  mocks.sessions.clear()
  mocks.emit.mockClear()
  mocks.collectGoalFileChanges.mockClear()
})

describe('mock wiring', () => {
  // Guards against the failure mode where a bad mock path silently falls
  // through to the real store and the suite writes to the user's data dir.
  it('routes reads and writes through the in-memory store', () => {
    seedSession()
    createGoal(SESSION, { objective: 'first' })
    expect(stored().goals).toHaveLength(1)
    expect(getGoal(SESSION)?.objective).toBe('first')
  })

  it('throws when the session does not exist, proving getSession is the mock', () => {
    expect(() => createGoal(SESSION, { objective: 'x' })).toThrow(/Session not found/)
  })
})

describe('goal history', () => {
  it('keeps the finished goal when a new one is created', () => {
    seedSession()
    createGoal(SESSION, { objective: 'first' })
    updateGoalFromModel(SESSION, 'complete', 'shipped it')
    createGoal(SESSION, { objective: 'second' })

    const history = getGoals(SESSION)
    expect(history).toHaveLength(2)
    expect(history[0]?.objective).toBe('first')
    expect(history[0]?.status).toBe('complete')
    expect(history[0]?.statusReason).toBe('shipped it')
    expect(history[1]?.objective).toBe('second')
    // Only the new one is current.
    expect(getGoal(SESSION)?.objective).toBe('second')
  })

  it('archives rather than deletes when the user clears a stalled goal', () => {
    seedSession()
    createGoal(SESSION, { objective: 'doomed' })
    updateGoalFromUser(SESSION, { status: 'paused' })
    clearGoal(SESSION, 'not worth it')

    const history = getGoals(SESSION)
    expect(history).toHaveLength(1)
    expect(history[0]?.status).toBe('abandoned')
    expect(history[0]?.statusReason).toBe('not worth it')
    expect(history[0]?.objective).toBe('doomed')
    // Archived goals free the slot.
    expect(getGoal(SESSION)).toBeUndefined()
  })

  it('lets a new goal start after the previous one was abandoned', () => {
    seedSession()
    createGoal(SESSION, { objective: 'first' })
    clearGoal(SESSION)
    expect(() => createGoal(SESSION, { objective: 'second' })).not.toThrow()
    expect(getGoals(SESSION)).toHaveLength(2)
  })

  it('still refuses a new goal while one is unfinished', () => {
    seedSession()
    createGoal(SESSION, { objective: 'first' })
    // paused / blocked / budget_limited are resumable and keep the slot.
    updateGoalFromUser(SESSION, { status: 'paused' })
    expect(() => createGoal(SESSION, { objective: 'second' })).toThrow(/unfinished goal/)
  })
})

describe('dual write for downgrade safety', () => {
  it('writes both the history array and the v2 scalar', () => {
    seedSession()
    createGoal(SESSION, { objective: 'first' })

    expect(stored().goals).toHaveLength(1)
    expect(stored().goal?.objective).toBe('first')
  })

  it('drops the scalar but keeps history once every goal has finished', () => {
    seedSession()
    createGoal(SESSION, { objective: 'first' })
    updateGoalFromModel(SESSION, 'complete', 'done')

    expect(stored().goal).toBeUndefined()
    expect(stored().goals).toHaveLength(1)
  })

  it('reconciles a goal an old build mutated behind the array', () => {
    seedSession()
    createGoal(SESSION, { objective: 'first' })
    // Simulate an older build: it knows only about `goal` and rewrites it.
    const session = stored()
    session.goal = { ...session.goal!, objective: 'edited by old build', tokensUsed: 77 }

    expect(getGoal(SESSION)?.objective).toBe('edited by old build')
    expect(getGoal(SESSION)?.tokensUsed).toBe(77)
    expect(getGoals(SESSION)).toHaveLength(1)
  })

  it('adopts a goal an old build created with no array at all', () => {
    const session = seedSession()
    session.goal = {
      id: 'legacy-1',
      objective: 'made by old build',
      status: 'active',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      continuationCount: 0,
      createdAt: 1,
      updatedAt: 1,
    }

    expect(getGoals(SESSION)).toHaveLength(1)
    expect(getGoal(SESSION)?.id).toBe('legacy-1')
  })
})

describe('timeline anchors', () => {
  it('records the last message id when the goal is created', () => {
    seedSession(['m1', 'm2'])
    expect(createGoal(SESSION, { objective: 'x' }).startMessageId).toBe('m2')
  })

  it('stamps endedAt and endMessageId when the goal leaves active', () => {
    const session = seedSession(['m1'])
    createGoal(SESSION, { objective: 'x' })
    session.messages.push({ id: 'm2' })
    updateGoalFromModel(SESSION, 'complete', 'done')

    const record = getGoals(SESSION)[0]!
    expect(record.endedAt).toBeGreaterThan(0)
    expect(record.endMessageId).toBe('m2')
  })

  it('clears the anchor when the user resumes', () => {
    seedSession()
    createGoal(SESSION, { objective: 'x' })
    updateGoalFromUser(SESSION, { status: 'paused' })
    expect(getGoal(SESSION)?.endedAt).toBeGreaterThan(0)

    updateGoalFromUser(SESSION, { status: 'active' })
    expect(getGoal(SESSION)?.endedAt).toBeUndefined()
    expect(getGoal(SESSION)?.endMessageId).toBeUndefined()
  })

  it('keeps the pause anchor when a paused goal is later abandoned', () => {
    seedSession()
    createGoal(SESSION, { objective: 'x' })
    updateGoalFromUser(SESSION, { status: 'paused' })
    const pausedAt = getGoal(SESSION)!.endedAt

    clearGoal(SESSION)
    // The work stopped at the pause, not when the user wrote it off.
    expect(getGoals(SESSION)[0]?.endedAt).toBe(pausedAt)
  })
})

describe('fileChanges backfill', () => {
  it('still finds the completed goal even though it is no longer current', async () => {
    // Regression: the backfill used to look itself up via the *current* goal.
    // A completed goal is terminal, so that lookup now returns undefined and
    // the enrichment would silently never land.
    expectFileChanges([{ path: 'a.ts', added: 3, removed: 1 }])
    seedSession()
    createGoal(SESSION, { objective: 'x' })
    updateGoalFromModel(SESSION, 'complete', 'done')
    // Generous timeout: the enrichment lazily dynamic-imports file-changes.js,
    // and the very first import in the process pays the module load.
    await vi.waitFor(() => expect(getGoals(SESSION)[0]?.fileChanges).toBeDefined(), { timeout: 5000 })

    expect(getGoals(SESSION)[0]?.fileChanges).toEqual([{ path: 'a.ts', added: 3, removed: 1 }])
  })

  it('does not stamp a bogus anchor on the old goal when a new one is already running', async () => {
    expectFileChanges([{ path: 'a.ts', added: 1, removed: 0 }])
    seedSession()
    createGoal(SESSION, { objective: 'first' })
    updateGoalFromModel(SESSION, 'complete', 'done')
    const endedAt = getGoals(SESSION)[0]!.endedAt
    createGoal(SESSION, { objective: 'second' })

    await vi.waitFor(() => expect(getGoals(SESSION)[0]?.fileChanges).toBeDefined(), { timeout: 5000 })
    expect(getGoals(SESSION)[0]?.endedAt).toBe(endedAt)
    expect(getGoals(SESSION)[1]?.status).toBe('active')
    expect(getGoal(SESSION)?.objective).toBe('second')
  })
})

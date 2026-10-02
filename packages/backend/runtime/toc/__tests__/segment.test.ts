import { describe, expect, it } from 'vitest'
import {
  coarseSegments,
  isEngineDrivenMessage,
  mergeSegments,
  segmentsFromGoals,
  startsNewSegment,
  touchesDisjointFiles,
  userWasAway,
  type SegmentSourceTurn,
} from '../segment.js'
import type { SessionGoal } from '../../goals/types.js'

const MINUTE = 60 * 1000

function turn(
  id: string,
  atMinute: number,
  options: {
    content?: string
    files?: string[]
    assistantAtMinute?: number
    source?: string
  } = {},
): SegmentSourceTurn {
  return {
    userMessage: {
      id,
      role: 'user',
      content: options.content ?? `message ${id}`,
      timestamp: atMinute * MINUTE,
      source: options.source,
    },
    lastAssistantMessage: {
      id: `${id}-a`,
      role: 'assistant',
      content: 'reply',
      timestamp: (options.assistantAtMinute ?? atMinute) * MINUTE,
    },
    files: (options.files ?? []).map(path => ({ path, added: 1, removed: 0 })),
  }
}

function goal(overrides: Partial<SessionGoal> & { id: string }): SessionGoal {
  return {
    objective: 'do the thing',
    status: 'complete',
    tokensUsed: 0,
    timeUsedSeconds: 0,
    continuationCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as SessionGoal
}

describe('userWasAway', () => {
  it('measures from when the agent finished, not from the previous user message', () => {
    // The agent worked for three hours on one instruction; the user replied
    // five minutes after it stopped. That is a continuation, not a new intent.
    const previous = turn('m1', 0, { assistantAtMinute: 180 })
    const next = turn('m2', 185)

    expect(userWasAway(previous, next)).toBe(false)
  })

  it('counts a long silence after the agent stopped as stepping away', () => {
    const previous = turn('m1', 0, { assistantAtMinute: 2 })
    const next = turn('m2', 200)

    expect(userWasAway(previous, next)).toBe(true)
  })

  it('falls back to the user message when the turn produced no reply', () => {
    const previous: SegmentSourceTurn = { ...turn('m1', 0), lastAssistantMessage: undefined }
    expect(userWasAway(previous, turn('m2', 200))).toBe(true)
  })
})

describe('touchesDisjointFiles', () => {
  it('flags two turns with no file in common', () => {
    expect(touchesDisjointFiles(turn('m1', 0, { files: ['a.ts'] }), turn('m2', 1, { files: ['b.ts'] })))
      .toBe(true)
  })

  it('does not flag turns that share a file', () => {
    expect(touchesDisjointFiles(
      turn('m1', 0, { files: ['a.ts', 'b.ts'] }),
      turn('m2', 1, { files: ['b.ts'] }),
    )).toBe(false)
  })

  it('stays silent when either side touched nothing — absence of evidence only', () => {
    expect(touchesDisjointFiles(turn('m1', 0, { files: ['a.ts'] }), turn('m2', 1))).toBe(false)
    expect(touchesDisjointFiles(turn('m1', 0), turn('m2', 1, { files: ['b.ts'] }))).toBe(false)
  })
})

describe('coarseSegments', () => {
  it('keeps consecutive work on the same files in one segment', () => {
    const segments = coarseSegments([
      turn('m1', 0, { files: ['a.ts'], content: 'fix the parser' }),
      turn('m2', 5, { files: ['a.ts'] }),
      turn('m3', 10, { files: ['a.ts'] }),
    ])

    expect(segments).toHaveLength(1)
    expect(segments[0]?.turnCount).toBe(3)
    expect(segments[0]?.title).toBe('fix the parser')
    expect(segments[0]?.kind).toBe('task')
  })

  it('splits when the work moves to unrelated files', () => {
    const segments = coarseSegments([
      turn('m1', 0, { files: ['a.ts'] }),
      turn('m2', 5, { files: ['b.ts'] }),
    ])

    expect(segments).toHaveLength(2)
    expect(segments[0]?.endMessageId).toBe('m1-a')
    expect(segments[1]?.startMessageId).toBe('m2')
  })

  it('splits when the user came back hours later', () => {
    const segments = coarseSegments([
      turn('m1', 0, { assistantAtMinute: 1 }),
      turn('m2', 300),
    ])
    expect(segments).toHaveLength(2)
  })

  it('marks a stretch that touched no files as a question', () => {
    const segments = coarseSegments([turn('m1', 0), turn('m2', 5)])
    expect(segments[0]?.kind).toBe('question')
    expect(segments[0]?.files).toEqual([])
  })

  it('ignores engine-driven turns so a continued goal is not shattered', () => {
    // Regression guard: goal continuation injects synthetic user messages.
    // Counting them as turns would split one goal into one segment per push.
    const segments = coarseSegments([
      turn('m1', 0, { files: ['a.ts'] }),
      turn('m2', 200, { files: ['a.ts'], source: 'goal' }),
      turn('m3', 400, { files: ['a.ts'], source: 'goal' }),
    ])

    expect(segments).toHaveLength(1)
    expect(segments[0]?.turnCount).toBe(1)
  })

  it('sums file churn across the turns of a segment', () => {
    const segments = coarseSegments([
      turn('m1', 0, { files: ['a.ts'] }),
      turn('m2', 5, { files: ['a.ts'] }),
    ])
    expect(segments[0]?.files).toEqual([{ path: 'a.ts', added: 2, removed: 0 }])
  })

  it('returns nothing for a session with only engine-driven turns', () => {
    expect(coarseSegments([turn('m1', 0, { source: 'goal' })])).toEqual([])
  })
})

describe('segmentsFromGoals', () => {
  it('projects a finished goal, carrying the engine-recorded outcome', () => {
    const segments = segmentsFromGoals([
      goal({
        id: 'g1',
        objective: 'ship the parser',
        status: 'blocked',
        statusReason: 'ripgrep exploded',
        startMessageId: 'm1',
        endMessageId: 'm9',
        createdAt: 1000,
        endedAt: 5000,
        fileChanges: [{ path: 'a.ts', added: 3, removed: 1 }],
      }),
    ])

    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({
      origin: 'goal',
      kind: 'task',
      title: 'ship the parser',
      detail: 'ripgrep exploded',
      outcome: 'blocked',
      goalId: 'g1',
      startMessageId: 'm1',
      endMessageId: 'm9',
      endedAt: 5000,
    })
  })

  it('skips a goal that is still running', () => {
    expect(segmentsFromGoals([goal({ id: 'g1', status: 'active' })])).toEqual([])
  })

  it('prefers endedAt over updatedAt, which keeps moving after completion', () => {
    const segments = segmentsFromGoals([
      goal({ id: 'g1', createdAt: 1000, endedAt: 4000, updatedAt: 9000 }),
    ])
    expect(segments[0]?.endedAt).toBe(4000)
  })
})

describe('mergeSegments', () => {
  it('orders the combined timeline by start time', () => {
    const goalSegments = segmentsFromGoals([
      goal({ id: 'g1', createdAt: 100, endedAt: 200, startMessageId: 'm5' }),
    ])
    const coarse = coarseSegments([turn('m1', 0)])

    const merged = mergeSegments(goalSegments, coarse)
    expect(merged.map(segment => segment.origin)).toEqual(['inferred', 'goal'])
  })

  it('drops a coarse segment that starts inside a goal span — fact beats guess', () => {
    const goalSegments = segmentsFromGoals([
      goal({ id: 'g1', createdAt: 0, endedAt: 20 * MINUTE }),
    ])
    const coarse = coarseSegments([turn('m1', 5)])

    const merged = mergeSegments(goalSegments, coarse)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.origin).toBe('goal')
  })

  it('keeps coarse segments that fall outside every goal span', () => {
    const goalSegments = segmentsFromGoals([
      goal({ id: 'g1', createdAt: 0, endedAt: 10 * MINUTE }),
    ])
    const coarse = coarseSegments([turn('m1', 100)])

    expect(mergeSegments(goalSegments, coarse)).toHaveLength(2)
  })
})

describe('isEngineDrivenMessage', () => {
  it('recognises the sources the engine injects', () => {
    expect(isEngineDrivenMessage({ id: 'm', role: 'user', content: '', timestamp: 0, source: 'goal' })).toBe(true)
    expect(isEngineDrivenMessage({ id: 'm', role: 'user', content: '', timestamp: 0, source: 'radio' })).toBe(true)
    expect(isEngineDrivenMessage({ id: 'm', role: 'user', content: '', timestamp: 0 })).toBe(false)
    // 'goal-set' is the user typing /goal — a real turn, and a real boundary.
    expect(isEngineDrivenMessage({ id: 'm', role: 'user', content: '', timestamp: 0, source: 'goal-set' })).toBe(false)
  })
})

describe('startsNewSegment', () => {
  it('breaks on either signal alone', () => {
    expect(startsNewSegment(turn('m1', 0, { assistantAtMinute: 1 }), turn('m2', 500))).toBe(true)
    expect(startsNewSegment(turn('m1', 0, { files: ['a.ts'] }), turn('m2', 1, { files: ['b.ts'] }))).toBe(true)
    expect(startsNewSegment(turn('m1', 0, { files: ['a.ts'] }), turn('m2', 1, { files: ['a.ts'] }))).toBe(false)
  })
})

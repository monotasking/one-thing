import { describe, expect, it } from 'vitest'
import {
  currentGoalOf,
  isGoalTerminal,
  mergeGoalRecord,
  normalizeGoalRecords,
  pruneGoalHistory,
} from '../records.js'
import { abandonGoal, applyGoalSettlement, createSessionGoal } from '../state.js'
import type { SessionGoal, SessionGoalStatus } from '../types.js'

function goal(id: string, status: SessionGoalStatus, createdAt = 1000): SessionGoal {
  return {
    ...createSessionGoal({ id, objective: `objective ${id}`, now: createdAt }),
    status,
  }
}

describe('isGoalTerminal / currentGoalOf', () => {
  it('treats only complete and abandoned as terminal', () => {
    expect(isGoalTerminal(goal('a', 'complete'))).toBe(true)
    expect(isGoalTerminal(goal('a', 'abandoned'))).toBe(true)
    // Resumable: these still occupy the session's single slot.
    expect(isGoalTerminal(goal('a', 'active'))).toBe(false)
    expect(isGoalTerminal(goal('a', 'paused'))).toBe(false)
    expect(isGoalTerminal(goal('a', 'blocked'))).toBe(false)
    expect(isGoalTerminal(goal('a', 'budget_limited'))).toBe(false)
    expect(isGoalTerminal(undefined)).toBe(false)
  })

  it('derives the current goal as the newest non-terminal record', () => {
    const goals = [goal('a', 'complete'), goal('b', 'abandoned'), goal('c', 'paused')]
    expect(currentGoalOf(goals)?.id).toBe('c')
  })

  it('returns undefined when every goal has finished', () => {
    expect(currentGoalOf([goal('a', 'complete'), goal('b', 'abandoned')])).toBeUndefined()
    expect(currentGoalOf([])).toBeUndefined()
  })

  it('picks the newest when a malformed list holds several non-terminal records', () => {
    expect(currentGoalOf([goal('a', 'active'), goal('b', 'paused')])?.id).toBe('b')
  })
})

describe('normalizeGoalRecords', () => {
  it('wraps a v2 scalar goal into a single-element history', () => {
    const legacy = goal('a', 'active')
    expect(normalizeGoalRecords(undefined, legacy)).toEqual([legacy])
  })

  it('returns an empty history when the session never had a goal', () => {
    expect(normalizeGoalRecords(undefined, undefined)).toEqual([])
    expect(normalizeGoalRecords([], undefined)).toEqual([])
  })

  it('passes the array through when there is no legacy scalar', () => {
    const goals = [goal('a', 'complete'), goal('b', 'active')]
    expect(normalizeGoalRecords(goals, undefined)).toEqual(goals)
  })

  it('lets the legacy scalar win on conflict, so a downgrade round trip is lossless', () => {
    // An old build resumed the goal and wrote only the scalar field.
    const stale = goal('b', 'paused')
    const fromOldBuild: SessionGoal = { ...stale, status: 'active', tokensUsed: 42 }
    const merged = normalizeGoalRecords([goal('a', 'complete'), stale], fromOldBuild)

    expect(merged).toHaveLength(2)
    expect(merged[1]).toEqual(fromOldBuild)
    expect(currentGoalOf(merged)?.tokensUsed).toBe(42)
  })

  it('appends a goal an old build created that the array never saw', () => {
    const history = [goal('a', 'complete')]
    const createdByOldBuild = goal('b', 'active', 2000)
    const merged = normalizeGoalRecords(history, createdByOldBuild)

    expect(merged.map(g => g.id)).toEqual(['a', 'b'])
    expect(currentGoalOf(merged)?.id).toBe('b')
  })

  it('does not mutate its input', () => {
    const history = [goal('a', 'complete')]
    normalizeGoalRecords(history, goal('b', 'active'))
    expect(history).toHaveLength(1)
  })
})

describe('mergeGoalRecord', () => {
  it('replaces the record carrying the same id', () => {
    const history = [goal('a', 'complete'), goal('b', 'active')]
    const merged = mergeGoalRecord(history, { ...history[1]!, status: 'paused' })

    expect(merged).toHaveLength(2)
    expect(merged[1]?.status).toBe('paused')
  })

  it('appends a brand-new goal, keeping the finished ones as history', () => {
    const merged = mergeGoalRecord([goal('a', 'complete')], goal('b', 'active', 2000))
    expect(merged.map(g => g.id)).toEqual(['a', 'b'])
  })

  it('drops only the current goal on null, preserving finished history', () => {
    const history = [goal('a', 'complete'), goal('b', 'abandoned'), goal('c', 'paused')]
    expect(mergeGoalRecord(history, null).map(g => g.id)).toEqual(['a', 'b'])
  })

  it('does not mutate its input', () => {
    const history = [goal('a', 'active')]
    mergeGoalRecord(history, { ...history[0]!, status: 'complete' })
    expect(history[0]?.status).toBe('active')
  })
})

describe('pruneGoalHistory', () => {
  it('keeps every record but strips fileChanges off all but the newest N', () => {
    const goals = Array.from({ length: 13 }, (_, i) => ({
      ...goal(`g${i}`, 'complete', 1000 + i),
      fileChanges: [{ path: 'a.ts', added: 1, removed: 0 }],
    }))
    const pruned = pruneGoalHistory(goals, 10)

    expect(pruned).toHaveLength(13)
    expect(pruned.slice(0, 3).every(g => g.fileChanges === undefined)).toBe(true)
    expect(pruned.slice(3).every(g => g.fileChanges !== undefined)).toBe(true)
    // The record itself survives — only the heavy table goes.
    expect(pruned[0]?.objective).toBe('objective g0')
  })

  it('leaves a short history untouched', () => {
    const goals = [{ ...goal('a', 'complete'), fileChanges: [{ path: 'a.ts', added: 1, removed: 0 }] }]
    expect(pruneGoalHistory(goals, 10)[0]?.fileChanges).toBeDefined()
  })
})

describe('applyGoalSettlement', () => {
  it('stamps the anchor when the goal leaves active', () => {
    const previous = goal('a', 'active')
    const next = { ...previous, status: 'complete' as const }
    const settled = applyGoalSettlement(previous, next, 5000, { messageId: 'm9' })

    expect(settled.endedAt).toBe(5000)
    expect(settled.endMessageId).toBe('m9')
  })

  it('clears the anchor on resume', () => {
    const previous: SessionGoal = { ...goal('a', 'paused'), endedAt: 5000, endMessageId: 'm9' }
    const settled = applyGoalSettlement(previous, { ...previous, status: 'active' }, 9000)

    expect(settled.endedAt).toBeUndefined()
    expect(settled.endMessageId).toBeUndefined()
  })

  it('keeps the pause timestamp when a paused goal is later abandoned', () => {
    // The work stopped at the pause, not when the user got around to writing
    // it off — the anchor must not jump forward.
    const paused: SessionGoal = { ...goal('a', 'paused'), endedAt: 5000, endMessageId: 'm9' }
    const settled = applyGoalSettlement(paused, abandonGoal(paused, 90_000), 90_000)

    expect(settled.status).toBe('abandoned')
    expect(settled.endedAt).toBe(5000)
    expect(settled.endMessageId).toBe('m9')
  })

  it('does not stamp an anchor on a freshly created active goal', () => {
    const created = goal('a', 'active')
    expect(applyGoalSettlement(undefined, created, 1000).endedAt).toBeUndefined()
  })

  it('leaves the anchor alone on an active→active accounting update', () => {
    const previous = goal('a', 'active')
    const settled = applyGoalSettlement(previous, { ...previous, tokensUsed: 500 }, 7000)
    expect(settled.endedAt).toBeUndefined()
  })
})

describe('abandonGoal', () => {
  it('preserves the record with its reason instead of deleting it', () => {
    const blocked: SessionGoal = { ...goal('a', 'blocked'), statusReason: 'ripgrep exploded' }
    const abandoned = abandonGoal(blocked, 9000)

    expect(abandoned.status).toBe('abandoned')
    expect(abandoned.statusReason).toBe('ripgrep exploded')
    expect(abandoned.objective).toBe(blocked.objective)
  })

  it('takes an explicit reason when the user gives one', () => {
    expect(abandonGoal(goal('a', 'paused'), 9000, 'changed my mind').statusReason)
      .toBe('changed my mind')
  })

  it('is a no-op on an already terminal goal', () => {
    const done = goal('a', 'complete')
    expect(abandonGoal(done, 9000)).toBe(done)
  })
})

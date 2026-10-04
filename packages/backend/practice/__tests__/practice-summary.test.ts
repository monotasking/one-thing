import { describe, expect, it } from 'vitest'
import { computeOnethingPracticeSummary } from '../practice-summary.js'
import type { OnethingPracticeLedgerRecord } from '@shared/contracts/practice.js'

function kegelRecord(ts: number, repsDone: number, setsDone: number, setsTarget = 3): OnethingPracticeLedgerRecord {
  return {
    id: `p_${ts}`,
    ts,
    kind: 'kegel',
    source: 'timer',
    name: '凯格尔',
    kegel: { holdSec: 10, relaxSec: 5, repsDone, repsTarget: 20, setsDone, setsTarget },
  }
}

function pomodoroRecord(ts: number, name: string, elapsedMin: number, completed: boolean): OnethingPracticeLedgerRecord {
  return {
    id: `p_${ts}`,
    ts,
    kind: 'pomodoro',
    source: 'timer',
    name,
    pomodoro: { minutes: 25, elapsedMin, completed },
  }
}

function exerciseRecord(ts: number, name: string, sets: number, repsPerSet: number): OnethingPracticeLedgerRecord {
  return {
    id: `p_${ts}`,
    ts,
    kind: 'exercise',
    source: 'agent',
    name,
    exercise: { sets, repsPerSet },
  }
}

describe('computeOnethingPracticeSummary', () => {
  // 2026-07-18 is a Saturday.
  const saturday = new Date(2026, 6, 18, 12, 0).getTime()

  it('buckets records into trailing local days', () => {
    const records = [
      kegelRecord(new Date(2026, 6, 18, 8, 0).getTime(), 60, 3),
      kegelRecord(new Date(2026, 6, 17, 23, 59).getTime(), 12, 0),
      pomodoroRecord(new Date(2026, 6, 18, 9, 0).getTime(), '学习', 25, true),
    ]
    const result = computeOnethingPracticeSummary(records, { granularity: 'day', count: 3, now: saturday })

    expect(result.buckets).toHaveLength(3)
    const [d16, d17, d18] = result.buckets
    expect(d16.records).toBe(0)
    expect(d17.kegel).toEqual({ sessions: 1, completedSessions: 0, reps: 12 })
    expect(d18.kegel).toEqual({ sessions: 1, completedSessions: 1, reps: 60 })
    expect(d18.pomodoro.sessions).toBe(1)
    expect(d18.bucketKey).toBe('2026-07-18')
  })

  it('starts weeks on Monday', () => {
    const mondayEarly = new Date(2026, 6, 13, 0, 30).getTime()
    const sundayLate = new Date(2026, 6, 12, 23, 30).getTime()
    const result = computeOnethingPracticeSummary(
      [kegelRecord(mondayEarly, 1, 0), kegelRecord(sundayLate, 2, 0)],
      { granularity: 'week', count: 2, now: saturday },
    )
    expect(result.buckets[0].kegel.reps).toBe(2) // week of Jul 6–12
    expect(result.buckets[1].kegel.reps).toBe(1) // week of Jul 13–19
  })

  it('aggregates pomodoro minutes per category and exercise reps per name', () => {
    const ts = new Date(2026, 6, 18, 10, 0).getTime()
    const records = [
      pomodoroRecord(ts, '学习', 25, true),
      pomodoroRecord(ts + 1, '学习', 11, false),
      pomodoroRecord(ts + 2, '看视频', 25, true),
      exerciseRecord(ts + 3, '俯卧撑', 3, 20),
      exerciseRecord(ts + 4, '俯卧撑', 2, 15),
    ]
    const result = computeOnethingPracticeSummary(records, { granularity: 'day', count: 1, now: saturday })
    const bucket = result.buckets[0]

    expect(bucket.pomodoro).toMatchObject({ sessions: 3, completedSessions: 2, minutes: 61 })
    expect(bucket.pomodoro.byCategory).toEqual([
      { key: '学习', sessions: 2, minutes: 36 },
      { key: '看视频', sessions: 1, minutes: 25 },
    ])
    expect(bucket.exercise.entries).toBe(2)
    expect(bucket.exercise.byName).toEqual([
      { key: '俯卧撑', entries: 2, sets: 5, reps: 90, durationMin: 0 },
    ])
  })

  it('ignores records outside the requested range', () => {
    const result = computeOnethingPracticeSummary(
      [kegelRecord(new Date(2026, 6, 1).getTime(), 10, 1)],
      { granularity: 'day', count: 2, now: saturday },
    )
    expect(result.buckets.every(bucket => bucket.records === 0)).toBe(true)
  })
})

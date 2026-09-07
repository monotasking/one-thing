import type { OnethingPracticeLedger } from './ledger.js'
import type { OnethingPracticeLedgerRecord } from './types.js'

import type {
  OnethingPracticeSummaryGranularity,
  OnethingPracticeCategoryStat,
  OnethingPracticeExerciseStat,
  OnethingPracticeBucket,
  OnethingPracticeSummaryResult,
} from '@shared/contracts/practice.js'
export type {
  OnethingPracticeSummaryGranularity,
  OnethingPracticeCategoryStat,
  OnethingPracticeExerciseStat,
  OnethingPracticeBucket,
  OnethingPracticeSummaryResult,
} from '@shared/contracts/practice.js'

const DEFAULT_BUCKET_COUNT: Record<OnethingPracticeSummaryGranularity, number> = {
  day: 14,
  week: 12,
  month: 12,
}

export interface OnethingPracticeSummaryRequest {
  granularity: OnethingPracticeSummaryGranularity
  /** Number of trailing buckets to return. Defaults: 14 day / 12 week / 12 month. */
  count?: number
  now?: number
}


function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function addDays(ts: number, days: number): number {
  const d = new Date(ts)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

function startOfLocalMonth(ts: number): number {
  const d = new Date(ts)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function addMonths(ts: number, months: number): number {
  const d = new Date(ts)
  d.setMonth(d.getMonth() + months)
  return d.getTime()
}

/** Monday-start ISO week containing ts. */
function startOfIsoWeek(ts: number): number {
  const d = new Date(startOfLocalDay(ts))
  const isoDayOfWeek = (d.getDay() + 6) % 7 // 0 = Monday
  d.setDate(d.getDate() - isoDayOfWeek)
  return d.getTime()
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function monthKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** ISO 8601 week key, e.g. '2026-W28'. */
function isoWeekKey(weekStartTs: number): string {
  const thursday = addDays(weekStartTs, 3)
  const d = new Date(thursday)
  const year = d.getFullYear()
  const jan1 = new Date(year, 0, 1).getTime()
  const week = Math.floor((thursday - startOfIsoWeek(jan1)) / (7 * 86400000)) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

function bucketRange(granularity: OnethingPracticeSummaryGranularity, ts: number): { start: number; end: number; key: string } {
  if (granularity === 'day') {
    const start = startOfLocalDay(ts)
    return { start, end: addDays(start, 1), key: dayKey(start) }
  }
  if (granularity === 'week') {
    const start = startOfIsoWeek(ts)
    return { start, end: addDays(start, 7), key: isoWeekKey(start) }
  }
  const start = startOfLocalMonth(ts)
  return { start, end: addMonths(start, 1), key: monthKey(start) }
}

function stepBack(granularity: OnethingPracticeSummaryGranularity, ts: number): number {
  if (granularity === 'day') return addDays(ts, -1)
  if (granularity === 'week') return addDays(ts, -7)
  return addMonths(ts, -1)
}

function emptyBucket(range: { start: number; end: number; key: string }): OnethingPracticeBucket {
  return {
    bucketKey: range.key,
    startTs: range.start,
    endTs: range.end,
    records: 0,
    kegel: { sessions: 0, completedSessions: 0, reps: 0 },
    pomodoro: { sessions: 0, completedSessions: 0, minutes: 0, byCategory: [] },
    exercise: { entries: 0, byName: [] },
  }
}

function accumulate(bucket: OnethingPracticeBucket, categoryMap: Map<string, OnethingPracticeCategoryStat>, exerciseMap: Map<string, OnethingPracticeExerciseStat>, record: OnethingPracticeLedgerRecord): void {
  bucket.records += 1
  if (record.kind === 'kegel') {
    const detail = record.kegel
    bucket.kegel.sessions += 1
    bucket.kegel.reps += detail?.repsDone ?? 0
    if (detail && detail.setsDone >= detail.setsTarget) bucket.kegel.completedSessions += 1
    return
  }
  if (record.kind === 'pomodoro') {
    const detail = record.pomodoro
    bucket.pomodoro.sessions += 1
    bucket.pomodoro.minutes += detail?.elapsedMin ?? 0
    if (detail?.completed) bucket.pomodoro.completedSessions += 1
    const stat = categoryMap.get(record.name) ?? { key: record.name, sessions: 0, minutes: 0 }
    stat.sessions += 1
    stat.minutes += detail?.elapsedMin ?? 0
    categoryMap.set(record.name, stat)
    return
  }
  const detail = record.exercise
  bucket.exercise.entries += 1
  const stat = exerciseMap.get(record.name) ?? { key: record.name, entries: 0, sets: 0, reps: 0, durationMin: 0 }
  stat.entries += 1
  stat.sets += detail?.sets ?? 0
  stat.reps += (detail?.sets ?? 0) * (detail?.repsPerSet ?? 0)
  stat.durationMin += detail?.durationMin ?? 0
  exerciseMap.set(record.name, stat)
}

/** Buckets already-loaded records into day/week/month practice totals. */
export function computeOnethingPracticeSummary(
  records: OnethingPracticeLedgerRecord[],
  request: OnethingPracticeSummaryRequest,
): OnethingPracticeSummaryResult {
  const now = request.now ?? Date.now()
  const count = request.count ?? DEFAULT_BUCKET_COUNT[request.granularity]

  const ranges: Array<{ start: number; end: number; key: string }> = []
  let cursor = now
  for (let i = 0; i < count; i++) {
    ranges.unshift(bucketRange(request.granularity, cursor))
    cursor = stepBack(request.granularity, cursor)
  }

  const buckets = ranges.map(emptyBucket)
  const categoryMaps = buckets.map(() => new Map<string, OnethingPracticeCategoryStat>())
  const exerciseMaps = buckets.map(() => new Map<string, OnethingPracticeExerciseStat>())

  const overallStart = ranges[0]?.start ?? now
  const overallEnd = ranges[ranges.length - 1]?.end ?? now

  for (const record of records) {
    if (record.ts < overallStart || record.ts >= overallEnd) continue
    const index = ranges.findIndex(range => record.ts >= range.start && record.ts < range.end)
    if (index === -1) continue
    accumulate(buckets[index], categoryMaps[index], exerciseMaps[index], record)
  }

  buckets.forEach((bucket, index) => {
    bucket.pomodoro.byCategory = Array.from(categoryMaps[index].values())
    bucket.exercise.byName = Array.from(exerciseMaps[index].values())
  })

  return { granularity: request.granularity, buckets }
}

/** Reads the ledger for the needed range and computes the bucketed summary. */
export async function getOnethingPracticeSummary(
  ledger: OnethingPracticeLedger,
  request: OnethingPracticeSummaryRequest,
): Promise<OnethingPracticeSummaryResult> {
  const now = request.now ?? Date.now()
  const count = request.count ?? DEFAULT_BUCKET_COUNT[request.granularity]
  let rangeStart = now
  for (let i = 0; i < count; i++) rangeStart = stepBack(request.granularity, rangeStart)
  const start = bucketRange(request.granularity, rangeStart).start
  const end = bucketRange(request.granularity, now).end
  const records = await ledger.readRecordsInRange(start, end)
  return computeOnethingPracticeSummary(records, request)
}

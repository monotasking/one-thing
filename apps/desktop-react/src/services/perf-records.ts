/**
 * User Timing entries retain their detail payload in Chromium even when no trace
 * is being recorded. React's development measures can contain entire prop trees.
 * Keep only a short, bounded diagnostic window; browser trace recordings receive
 * events when they are emitted and do not depend on this in-page entry buffer.
 */
export const PERFORMANCE_RECORD_WINDOW_MS = 30_000
export const PERFORMANCE_RECORD_CAPACITY = 2_000
export const PERFORMANCE_RECORD_PRESERVE_MS = 10 * 60_000
const SWEEP_MS = 10_000

type EntryGroup = { count: number; oldest: number }
const measures = new Map<string, EntryGroup>()
const marks = new Map<string, EntryGroup>()
let managedEntries = 0
let observer: PerformanceObserver | undefined
let timer: ReturnType<typeof setInterval> | undefined
let preserveUntil = 0

function remember(groups: Map<string, EntryGroup>, name: string, startTime: number): void {
  const group = groups.get(name)
  if (group) {
    group.count += 1
    group.oldest = Math.min(group.oldest, startTime)
  } else groups.set(name, { count: 1, oldest: startTime })
  managedEntries += 1
}

function isReactMeasure(entry: PerformanceEntry): boolean {
  // React prefixes component names; inspecting the name avoids materializing
  // the large props detail payload for the overwhelming majority of records.
  if (entry.name.startsWith('\u200b')) return true
  const detail = (entry as PerformanceMeasure).detail as {
    devtools?: { track?: string; trackGroup?: string }
  } | null
  return detail?.devtools?.track === 'Components ⚛'
    || detail?.devtools?.trackGroup === 'Scheduler ⚛'
}

function clearGroups(groups: Map<string, EntryGroup>, type: 'mark' | 'measure', before: number): number {
  let cleared = 0
  for (const [name, group] of groups) {
    if (group.oldest > before) continue
    if (type === 'mark') performance.clearMarks(name)
    else performance.clearMeasures(name)
    cleared += group.count
    groups.delete(name)
  }
  managedEntries -= cleared
  return cleared
}

export function getPerformanceRecordState(): {
  preserving: boolean
  preserveUntil: number | null
  managedEntries: number
  windowMs: number
  capacity: number
} {
  const preserving = preserveUntil > Date.now()
  return {
    preserving,
    preserveUntil: preserving ? preserveUntil : null,
    managedEntries,
    windowMs: PERFORMANCE_RECORD_WINDOW_MS,
    capacity: PERFORMANCE_RECORD_CAPACITY,
  }
}

/** Diagnostic opt-out expires so a forgotten recording cannot grow forever. */
export function setPreservePerformanceRecords(preserve: boolean): void {
  preserveUntil = preserve ? Date.now() + PERFORMANCE_RECORD_PRESERVE_MS : 0
  if (!preserve) sweepPerformanceRecords()
}

/** Remove owned records only. Unrelated User Timing entries are never cleared. */
export function clearManagedPerformanceRecords(): number {
  if (getPerformanceRecordState().preserving || typeof performance === 'undefined') return 0
  return clearGroups(measures, 'measure', Infinity) + clearGroups(marks, 'mark', Infinity)
}

function sweepPerformanceRecords(): void {
  if (getPerformanceRecordState().preserving || typeof performance === 'undefined') return
  const before = managedEntries > PERFORMANCE_RECORD_CAPACITY
    ? Infinity
    : performance.now() - PERFORMANCE_RECORD_WINDOW_MS
  // User Timing only supports clearing by name. A name that has expired is
  // cleared as a group, including newer occurrences of that same name.
  clearGroups(measures, 'measure', before)
  clearGroups(marks, 'mark', before)
}

export function rememberApplicationMark(name: string): void {
  remember(marks, name, performance.now())
  if (managedEntries > PERFORMANCE_RECORD_CAPACITY) sweepPerformanceRecords()
}

export function startPerformanceRecordRetention(development = import.meta.env.DEV): void {
  if (timer !== undefined || typeof performance === 'undefined') return
  timer = setInterval(sweepPerformanceRecords, SWEEP_MS)
  if (!development || typeof PerformanceObserver === 'undefined'
    || !PerformanceObserver.supportedEntryTypes?.includes('measure')) return
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (isReactMeasure(entry)) remember(measures, entry.name, entry.startTime)
      }
      if (managedEntries > PERFORMANCE_RECORD_CAPACITY) sweepPerformanceRecords()
    })
    observer.observe({ type: 'measure', buffered: true })
  } catch {
    observer?.disconnect()
    observer = undefined
  }
}

export function stopPerformanceRecordRetention(): void {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
  observer?.disconnect()
  observer = undefined
  preserveUntil = 0
  clearManagedPerformanceRecords()
}

if (import.meta.hot) import.meta.hot.dispose(stopPerformanceRecordRetention)

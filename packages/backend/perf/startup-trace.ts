/**
 * Startup trace: lightweight named timestamps for measuring app boot phases.
 *
 * Marks are recorded process-wide (module singleton). The summary line is
 * emitted once, after the main window exists, in the form:
 *   [Perf][Startup] a→b=12ms | b→c=340ms | total=352ms
 *
 * Renderer and server processes log their own marks through their existing
 * console channels; this module only needs to cover one process at a time.
 */

export interface StartupMark {
  name: string
  at: number
}

const marks: StartupMark[] = []

export function markStartup(name: string, at: number = Date.now()): void {
  marks.push({ name, at })
}

/**
 * Record the true process start instant derived from uptime, so the trace
 * includes runtime boot cost that happened before any code could mark it.
 */
export function markStartupProcessStart(
  uptimeSeconds: number,
  now: number = Date.now(),
): void {
  marks.push({ name: 'process-start', at: now - Math.round(uptimeSeconds * 1000) })
}

export function getStartupMarks(): readonly StartupMark[] {
  return marks
}

export function formatStartupSummary(): string {
  if (marks.length === 0) return '[Perf][Startup] no marks recorded'
  const sorted = [...marks].sort((a, b) => a.at - b.at)
  const segments: string[] = []
  for (let i = 1; i < sorted.length; i++) {
    segments.push(`${sorted[i - 1].name}→${sorted[i].name}=${sorted[i].at - sorted[i - 1].at}ms`)
  }
  const total = sorted[sorted.length - 1].at - sorted[0].at
  const body = segments.length > 0 ? `${segments.join(' | ')} | ` : `${sorted[0].name} | `
  return `[Perf][Startup] ${body}total=${total}ms`
}

export function resetStartupTrace(): void {
  marks.length = 0
}

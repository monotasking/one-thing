import fs from 'node:fs'
import path from 'node:path'

export const MAX_ONETHING_SCHEDULER_RUN_HISTORY_PER_TASK = 200

export interface SchedulerRunHistoryLogger {
  error?: (...args: unknown[]) => void
}

export interface SchedulerRunDetailLike {
  runId?: string
  taskId: string
  startedAt: number
}

export interface SchedulerRunHistoryOptions {
  runsDir: string | (() => string | undefined)
  maxRunsPerTask?: number
  logger?: SchedulerRunHistoryLogger
}

function resolveRunsDir(value: SchedulerRunHistoryOptions['runsDir']): string | undefined {
  const resolved = typeof value === 'function' ? value() : value
  return typeof resolved === 'string' && resolved.trim() ? resolved : undefined
}

export function safeSchedulerRunTaskFileName(taskId: string): string {
  return `${taskId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`
}

export function getSchedulerRunHistoryPath(runsDir: string, taskId: string): string {
  return path.join(runsDir, safeSchedulerRunTaskFileName(taskId))
}

export class OnethingSchedulerRunHistory<TDetail extends SchedulerRunDetailLike = SchedulerRunDetailLike> {
  private readonly options: SchedulerRunHistoryOptions

  constructor(options: SchedulerRunHistoryOptions) {
    this.options = options
  }

  save(detail: TDetail): TDetail {
    if (!detail.runId) throw new Error('Scheduler run id is required')
    const runs = this.read(detail.taskId)
    const next = runs
      .filter(run => run.runId !== detail.runId)
      .concat(detail)
      .slice(-this.maxRunsPerTask())
    this.write(detail.taskId, next)
    return detail
  }

  list(taskId: string, limit = 50): TDetail[] {
    const safeLimit = Math.max(1, Math.min(this.maxRunsPerTask(), Math.floor(limit)))
    return this.read(taskId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, safeLimit)
  }

  get(taskId: string, runId: string): TDetail | undefined {
    return this.read(taskId).find(run => run.runId === runId)
  }

  private read(taskId: string): TDetail[] {
    try {
      const filePath = this.filePath(taskId)
      if (!fs.existsSync(filePath)) return []
      return fs.readFileSync(filePath, 'utf-8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => JSON.parse(line) as TDetail)
        .filter(run => run && typeof run.runId === 'string')
    } catch (error) {
      this.options.logger?.error?.('[SchedulerRuns] Failed to read run history:', error)
      return []
    }
  }

  private write(taskId: string, runs: TDetail[]): void {
    const filePath = this.filePath(taskId)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const payload = runs.map(run => JSON.stringify(run)).join('\n')
    fs.writeFileSync(filePath, payload ? `${payload}\n` : '', 'utf-8')
  }

  private filePath(taskId: string): string {
    const runsDir = resolveRunsDir(this.options.runsDir)
    if (!runsDir) throw new Error('Scheduler run history directory is not configured')
    return getSchedulerRunHistoryPath(runsDir, taskId)
  }

  private maxRunsPerTask(): number {
    const configured = this.options.maxRunsPerTask
    if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
      return MAX_ONETHING_SCHEDULER_RUN_HISTORY_PER_TASK
    }
    return Math.floor(configured)
  }
}

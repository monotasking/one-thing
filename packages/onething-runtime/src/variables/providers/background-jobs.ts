import { listBackgroundJobs, type BackgroundJob } from '../../tools/background-jobs.js'
import type { ContextVariable, VariableContext, VariableProvider } from '../types.js'

const NAME = 'background_jobs'

/** Ended jobs stay on the board briefly so the model sees the transition. */
const RECENTLY_ENDED_WINDOW_MS = 10 * 60 * 1000

const MAX_COMMAND_CHARS = 48

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Fixed at job start (minute granularity) — the line must not contain live
 * durations, or the turn-channel dedupe would inject a new block every turn.
 */
function startClock(startedAt: number): string {
  const date = new Date(startedAt)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function describeJob(job: BackgroundJob): string {
  const command = job.command.replace(/\s+/g, ' ').trim()
  const shortCommand = command.length > MAX_COMMAND_CHARS
    ? `${command.slice(0, MAX_COMMAND_CHARS)}…`
    : command
  const ports = job.status === 'running' && job.ports?.length
    ? `, ports ${job.ports.join('/')}`
    : ''
  return `${job.id}: ${shortCommand} — ${job.status}, started ${startClock(job.startedAt)}${ports}`
}

export interface BackgroundJobsProviderDeps {
  listJobs?: typeof listBackgroundJobs
  now?: () => number
}

/**
 * Read-only state provider exposing the managed background jobs
 * (bash run_in_background) as a single state-board line. Scoped to the
 * session that started each job — other sessions (and gateway users) never
 * see it. Running jobs are always shown; ended jobs linger for a short
 * window so the model notices the transition instead of assuming the job
 * is still alive.
 */
export class BackgroundJobsProvider implements VariableProvider {
  readonly id = 'background-jobs'
  readonly priority = 22

  constructor(private readonly deps: BackgroundJobsProviderDeps = {}) {}

  list(ctx: VariableContext): ContextVariable[] {
    const now = (this.deps.now ?? Date.now)()
    const jobs = (this.deps.listJobs ?? listBackgroundJobs)({ includeInactive: true })
      .filter(job => job.sessionId === ctx.sessionId)
      .filter(job =>
        job.status === 'running'
        || (job.endedAt !== undefined && now - job.endedAt < RECENTLY_ENDED_WINDOW_MS))
      .sort((a, b) => a.startedAt - b.startedAt)
    if (jobs.length === 0) return []
    return [{
      name: NAME,
      value: jobs.map(describeJob).join('; '),
      readonly: true,
      state: true,
      description: 'Managed background jobs started by bash run_in_background. Read output by tailing the log file; stop with kill -- -<pid>.',
    }]
  }

  claims(name: string): boolean {
    return name === NAME
  }
}

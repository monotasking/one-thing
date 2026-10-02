export type SchedulerRunReason = 'startup' | 'scheduled' | 'manual'
export type SchedulerTaskKind = 'agent' | 'plugin'
export type SchedulerTaskSource = 'user' | 'plugin'
export type SchedulerRunStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'skipped' | 'cancelled'

export type SchedulerSchedule =
  | {
      kind: 'cron'
      expr: string
      timezone?: string
    }
  | {
      kind: 'interval'
      everyMs: number
      startDelayMs?: number
    }
  | {
      kind: 'at'
      atMs: number
    }

export interface SchedulerTaskContext {
  runId: string
  taskId: string
  pluginId?: string
  reason: SchedulerRunReason
  scheduledFor: number
  startedAt: number
  signal: AbortSignal
}

export type SchedulerTaskRunner = (context: SchedulerTaskContext) => unknown | Promise<unknown>

export interface SchedulerTaskRegistration {
  id: string
  name?: string
  pluginId?: string
  kind?: SchedulerTaskKind
  source?: SchedulerTaskSource
  readonly?: boolean
  agentId?: string
  prompt?: string
  promptPreview?: string
  workingDirectory?: string
  enabled?: boolean | (() => boolean)
  schedule: SchedulerSchedule | (() => SchedulerSchedule | null | undefined)
  timeoutMs?: number | (() => number | undefined)
  allowConcurrent?: boolean
  tags?: string[]
  run: SchedulerTaskRunner
}

export interface SchedulerRunOptions {
  reason?: SchedulerRunReason
  force?: boolean
}

export interface SchedulerRunRecord {
  runId?: string
  taskId: string
  pluginId?: string
  reason: SchedulerRunReason
  scheduledFor: number
  startedAt: number
  finishedAt: number
  durationMs: number
  ok: boolean
  skipped?: boolean
  skippedReason?: string
  error?: string
  result?: unknown
}

export interface SchedulerTaskSnapshot {
  id: string
  name?: string
  pluginId?: string
  kind: SchedulerTaskKind
  source: SchedulerTaskSource
  readonly: boolean
  agentId?: string
  prompt?: string
  promptPreview?: string
  workingDirectory?: string
  enabled: boolean
  userEnabled?: boolean
  schedule?: SchedulerSchedule
  scheduleKey?: string
  tags: string[]
  inFlight: boolean
  nextRunAt?: number
  lastRunAt?: number
  lastSuccessAt?: number
  lastErrorAt?: number
  lastError?: string
  lastDurationMs?: number
  lastRunReason?: SchedulerRunReason
  lastScheduledFor?: number
  runCount: number
  successCount: number
  failureCount: number
  recentRuns?: SchedulerRunRecord[]
}

export interface SchedulerTaskHandle {
  id: string
  unregister(): void
  refresh(): SchedulerTaskSnapshot | undefined
  getStatus(): SchedulerTaskSnapshot | undefined
  runNow(options?: SchedulerRunOptions): Promise<SchedulerRunRecord>
  setEnabled(enabled: boolean): SchedulerTaskSnapshot | undefined
}

import fs from 'node:fs'
import type { CorePluginSchedulerHost } from '@onething/core/plugins'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  cronRunKey,
  currentCronRunAt,
  nextCronRunAt,
  parseCronExpression,
} from './cron.js'
import type {
  SchedulerRunOptions,
  SchedulerRunReason,
  SchedulerRunRecord,
  SchedulerSchedule,
  SchedulerTaskContext,
  SchedulerTaskHandle,
  SchedulerTaskRegistration,
  SchedulerTaskSnapshot,
} from './types.js'

export type {
  SchedulerRunOptions,
  SchedulerRunReason,
  SchedulerRunRecord,
  SchedulerSchedule,
  SchedulerTaskContext,
  SchedulerTaskHandle,
  SchedulerTaskRegistration,
  SchedulerTaskSnapshot,
} from './types.js'
export {
  cronRunKey,
  currentCronRunAt,
  isValidTimezone,
  nextCronRunAt,
  parseCronExpression,
} from './cron.js'

const SCHEDULER_STATE_VERSION = 1
const SCHEDULER_HEARTBEAT_MS = 60_000
const MAX_TIMER_DELAY_MS = 2_147_000_000
const MIN_TIMER_DELAY_MS = 250
const MAX_RUN_HISTORY = 20

type StoredTaskState = {
  userEnabled?: boolean
  enabled?: boolean
  schedule?: SchedulerSchedule
  scheduleKey?: string
  nextRunAt?: number
  lastRunAt?: number
  lastSuccessAt?: number
  lastErrorAt?: number
  lastError?: string
  lastDurationMs?: number
  lastRunReason?: SchedulerRunReason
  lastScheduledFor?: number
  lastRunKey?: string
  runCount?: number
  successCount?: number
  failureCount?: number
  inFlight?: boolean
  recentRuns?: SchedulerRunRecord[]
}

type SchedulerStateFile = {
  version: number
  tasks: Record<string, StoredTaskState>
}

type InternalTask = SchedulerTaskRegistration & {
  id: string
}

interface SchedulerRefreshOptions {
  persist?: boolean
  reschedule?: boolean
}

interface SchedulerRefreshResult {
  snapshot?: SchedulerTaskSnapshot
  changed: boolean
}

function normalizeSchedule(schedule: SchedulerSchedule): SchedulerSchedule {
  if (schedule.kind === 'cron') {
    const expr = schedule.expr.trim()
    parseCronExpression(expr)
    return {
      kind: 'cron',
      expr,
      ...(schedule.timezone?.trim() ? { timezone: schedule.timezone.trim() } : {}),
    }
  }
  if (schedule.kind === 'interval') {
    const everyMs = Math.max(1000, Math.floor(schedule.everyMs))
    return {
      kind: 'interval',
      everyMs,
      ...(typeof schedule.startDelayMs === 'number'
        ? { startDelayMs: Math.max(0, Math.floor(schedule.startDelayMs)) }
        : {}),
    }
  }
  return {
    kind: 'at',
    atMs: Math.max(0, Math.floor(schedule.atMs)),
  }
}

function scheduleKey(schedule: SchedulerSchedule | undefined): string | undefined {
  if (!schedule) return undefined
  return JSON.stringify(schedule)
}

function resolveBoolean(value: boolean | (() => boolean) | undefined, fallback: boolean): boolean {
  if (typeof value === 'function') return value()
  if (typeof value === 'boolean') return value
  return fallback
}

function resolveTimeoutMs(value: number | (() => number | undefined) | undefined): number | undefined {
  const resolved = typeof value === 'function' ? value() : value
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved <= 0) return undefined
  return Math.floor(resolved)
}

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface SchedulerLogger {
  error?: (...args: unknown[]) => void
}

export interface SchedulerOptions {
  stateFilePath?: string | (() => string | undefined)
  createRunId?: () => string
  now?: () => number
  logger?: SchedulerLogger
}

function resolveStateFilePath(value: SchedulerOptions['stateFilePath']): string | undefined {
  const resolved = typeof value === 'function' ? value() : value
  return typeof resolved === 'string' && resolved.trim() ? resolved : undefined
}

export class Scheduler
  implements
    CorePluginSchedulerHost<
      SchedulerTaskRegistration,
      SchedulerTaskSnapshot,
      SchedulerRunOptions,
      SchedulerRunRecord
    >
{
  private tasks = new Map<string, InternalTask>()
  private state: SchedulerStateFile = { version: SCHEDULER_STATE_VERSION, tasks: {} }
  private loaded = false
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private readonly options: SchedulerOptions

  constructor(options: SchedulerOptions = {}) {
    this.options = options
  }

  register(task: SchedulerTaskRegistration): SchedulerTaskHandle {
    const id = task.id.trim()
    if (!id) throw new Error('Scheduled task id is required')
    this.ensureLoaded()
    if (this.tasks.has(id)) {
      this.unregister(id)
    }
    this.tasks.set(id, { ...task, id })
    this.refresh(id)

    return {
      id,
      unregister: () => this.unregister(id),
      refresh: () => this.refresh(id),
      getStatus: () => this.getStatus(id),
      runNow: options => this.runNow(id, options),
      setEnabled: enabled => this.setEnabled(id, enabled),
    }
  }

  unregister(id: string): void {
    this.tasks.delete(id)
    const state = this.state.tasks[id]
    if (state) {
      state.inFlight = false
      this.save()
    }
    this.rescheduleTimer()
  }

  list(): SchedulerTaskSnapshot[] {
    this.ensureLoaded()
    let changed = false
    const snapshots = Array.from(this.tasks.keys())
      .map(id => {
        const result = this.refreshTask(id, { persist: false, reschedule: false })
        changed = changed || result.changed
        return result.snapshot
      })
      .filter((snapshot): snapshot is SchedulerTaskSnapshot => Boolean(snapshot))

    if (changed) this.save()
    this.rescheduleTimer()
    return snapshots
  }

  getStatus(id: string): SchedulerTaskSnapshot | undefined {
    this.ensureLoaded()
    return this.refresh(id)
  }

  refresh(id: string): SchedulerTaskSnapshot | undefined {
    return this.refreshTask(id).snapshot
  }

  private refreshTask(id: string, options: SchedulerRefreshOptions = {}): SchedulerRefreshResult {
    this.ensureLoaded()
    const task = this.tasks.get(id)
    if (!task) return { changed: false }
    const state = this.getOrCreateState(id)
    const previous = {
      enabled: state.enabled,
      scheduleKey: state.scheduleKey,
      nextRunAt: state.nextRunAt,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
    }

    let schedule: SchedulerSchedule | undefined
    let enabled = false
    let nextRunAt: number | undefined
    let newScheduleKey: string | undefined
    try {
      const baseEnabled = resolveBoolean(task.enabled, true)
      enabled = state.userEnabled === undefined ? baseEnabled : baseEnabled && state.userEnabled
      const resolved = typeof task.schedule === 'function' ? task.schedule() : task.schedule
      schedule = resolved ? normalizeSchedule(resolved) : undefined
      newScheduleKey = scheduleKey(schedule)
      const changed = state.scheduleKey !== newScheduleKey
      state.enabled = enabled
      state.schedule = schedule
      state.scheduleKey = newScheduleKey
      if (enabled && schedule) {
        nextRunAt = changed || !state.nextRunAt
          ? this.computeInitialNextRunAt(schedule, state, this.nowMs())
          : state.nextRunAt
      }
      state.nextRunAt = nextRunAt
      if (changed) delete state.lastError
    } catch (error) {
      const message = cleanError(error)
      state.enabled = false
      state.schedule = undefined
      state.scheduleKey = undefined
      state.nextRunAt = undefined
      if (state.lastError !== message) {
        state.lastErrorAt = this.nowMs()
      }
      state.lastError = message
    }

    const changed =
      previous.enabled !== state.enabled ||
      previous.scheduleKey !== state.scheduleKey ||
      previous.nextRunAt !== state.nextRunAt ||
      previous.lastError !== state.lastError ||
      previous.lastErrorAt !== state.lastErrorAt

    if (changed && options.persist !== false) this.save()
    if (options.reschedule !== false) this.rescheduleTimer()
    return {
      snapshot: this.snapshot(task, state),
      changed,
    }
  }

  async runNow(id: string, options: SchedulerRunOptions = {}): Promise<SchedulerRunRecord> {
    this.ensureLoaded()
    const task = this.tasks.get(id)
    if (!task) {
      throw new Error(`Scheduled task not registered: ${id}`)
    }
    const startedAt = this.nowMs()
    return await this.runTask(task, {
      force: options.force ?? true,
      reason: options.reason || 'manual',
      scheduledFor: startedAt,
    })
  }

  setEnabled(id: string, enabled: boolean): SchedulerTaskSnapshot | undefined {
    this.ensureLoaded()
    const task = this.tasks.get(id)
    if (!task) return undefined
    const state = this.getOrCreateState(id)
    state.userEnabled = enabled
    this.save()
    return this.refresh(id)
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const filePath = this.schedulerStatePath()
      if (filePath && fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SchedulerStateFile
        this.state = {
          version: SCHEDULER_STATE_VERSION,
          tasks: parsed && typeof parsed === 'object' && parsed.tasks ? parsed.tasks : {},
        }
      }
    } catch (error) {
      this.options.logger?.error?.('[Scheduler] Failed to load scheduler state:', error)
      this.state = { version: SCHEDULER_STATE_VERSION, tasks: {} }
    }
    for (const state of Object.values(this.state.tasks)) {
      state.inFlight = false
    }
  }

  private save(): void {
    this.ensureLoaded()
    const filePath = this.schedulerStatePath()
    if (!filePath) return
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const tmpPath = `${filePath}.${process.pid}.${this.nowMs()}.tmp`
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf-8')
      fs.renameSync(tmpPath, filePath)
    } catch (error) {
      this.options.logger?.error?.('[Scheduler] Failed to save scheduler state:', error)
    }
  }

  private getOrCreateState(id: string): StoredTaskState {
    const existing = this.state.tasks[id]
    if (existing) return existing
    const created: StoredTaskState = {
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      inFlight: false,
    }
    this.state.tasks[id] = created
    return created
  }

  private computeInitialNextRunAt(
    schedule: SchedulerSchedule,
    state: StoredTaskState,
    now: number,
  ): number | undefined {
    if (schedule.kind === 'cron') {
      const current = currentCronRunAt(schedule.expr, schedule.timezone, new Date(now))
      if (current !== undefined) {
        const key = this.runKey(schedule, current)
        if (state.lastRunKey !== key) return current
      }
      return nextCronRunAt(schedule.expr, schedule.timezone, new Date(now))
    }
    if (schedule.kind === 'interval') {
      return now + (schedule.startDelayMs ?? schedule.everyMs)
    }
    if (schedule.atMs <= now && state.lastRunAt) return undefined
    return schedule.atMs
  }

  private computeFollowingNextRunAt(schedule: SchedulerSchedule, scheduledFor: number): number | undefined {
    const after = Math.max(this.nowMs(), scheduledFor)
    if (schedule.kind === 'cron') {
      return nextCronRunAt(schedule.expr, schedule.timezone, new Date(after))
    }
    if (schedule.kind === 'interval') {
      return after + schedule.everyMs
    }
    return undefined
  }

  private runKey(schedule: SchedulerSchedule | undefined, scheduledFor: number): string {
    if (!schedule) return `manual:${scheduledFor}`
    if (schedule.kind === 'cron') {
      return `cron:${cronRunKey(schedule.expr, new Date(scheduledFor), schedule.timezone)}`
    }
    if (schedule.kind === 'interval') {
      return `interval:${scheduledFor}`
    }
    return `at:${schedule.atMs}`
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.nowMs()
      for (const id of Array.from(this.tasks.keys())) {
        const snapshot = this.refresh(id)
        if (!snapshot?.enabled || !snapshot.nextRunAt || snapshot.nextRunAt > now) continue
        const task = this.tasks.get(id)
        if (!task) continue
        await this.runTask(task, {
          reason: 'scheduled',
          scheduledFor: snapshot.nextRunAt,
          force: false,
        })
      }
    } finally {
      this.ticking = false
      this.rescheduleTimer()
    }
  }

  private async runTask(
    task: InternalTask,
    options: { reason: SchedulerRunReason; scheduledFor: number; force: boolean },
  ): Promise<SchedulerRunRecord> {
    const state = this.getOrCreateState(task.id)
    const runId = this.createRunId()
    const startedAt = this.nowMs()
    const schedule = state.schedule
    const baseEnabled = resolveBoolean(task.enabled, true)
    const enabled = state.userEnabled === undefined ? baseEnabled : baseEnabled && state.userEnabled
    const runKey = this.runKey(schedule, options.scheduledFor)

    if (!options.force && !enabled) {
      return this.skipped(task, options, startedAt, 'disabled')
    }
    if (!options.force && state.lastRunKey === runKey) {
      state.nextRunAt = schedule ? this.computeFollowingNextRunAt(schedule, options.scheduledFor) : undefined
      this.save()
      return this.skipped(task, options, startedAt, 'already-ran')
    }
    if (!task.allowConcurrent && state.inFlight) {
      return this.skipped(task, options, startedAt, 'in-flight')
    }

    state.inFlight = true
    state.lastRunAt = startedAt
    state.lastRunReason = options.reason
    state.lastScheduledFor = options.scheduledFor
    this.save()

    const controller = new AbortController()
    const timeoutMs = resolveTimeoutMs(task.timeoutMs)
    let timer: NodeJS.Timeout | undefined
    try {
      const context: SchedulerTaskContext = {
        runId,
        taskId: task.id,
        ...(task.pluginId ? { pluginId: task.pluginId } : {}),
        reason: options.reason,
        scheduledFor: options.scheduledFor,
        startedAt,
        signal: controller.signal,
      }
      const runPromise = Promise.resolve(task.run(context))
      const result = timeoutMs
        ? await Promise.race([
            runPromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort()
                reject(new Error(`scheduled task timed out after ${Math.round(timeoutMs / 1000)}s`))
              }, timeoutMs)
            }),
          ])
        : await runPromise
      const finishedAt = this.nowMs()
      state.inFlight = false
      state.lastRunKey = runKey
      state.lastSuccessAt = finishedAt
      state.lastDurationMs = finishedAt - startedAt
      state.runCount = (state.runCount || 0) + 1
      state.successCount = (state.successCount || 0) + 1
      delete state.lastError
      delete state.lastErrorAt
      state.nextRunAt = schedule ? this.computeFollowingNextRunAt(schedule, options.scheduledFor) : undefined
      const record: SchedulerRunRecord = {
        runId,
        taskId: task.id,
        ...(task.pluginId ? { pluginId: task.pluginId } : {}),
        reason: options.reason,
        scheduledFor: options.scheduledFor,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        ok: true,
        result,
      }
      this.recordRun(state, record)
      this.save()
      return record
    } catch (error) {
      const finishedAt = this.nowMs()
      const message = cleanError(error)
      state.inFlight = false
      state.lastRunKey = runKey
      state.lastError = message
      state.lastErrorAt = finishedAt
      state.lastDurationMs = finishedAt - startedAt
      state.runCount = (state.runCount || 0) + 1
      state.failureCount = (state.failureCount || 0) + 1
      state.nextRunAt = schedule ? this.computeFollowingNextRunAt(schedule, options.scheduledFor) : undefined
      const record: SchedulerRunRecord = {
        runId,
        taskId: task.id,
        ...(task.pluginId ? { pluginId: task.pluginId } : {}),
        reason: options.reason,
        scheduledFor: options.scheduledFor,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        ok: false,
        error: message,
      }
      this.recordRun(state, record)
      this.save()
      return record
    } finally {
      if (timer) clearTimeout(timer)
      this.rescheduleTimer()
    }
  }

  private skipped(
    task: InternalTask,
    options: { reason: SchedulerRunReason; scheduledFor: number },
    startedAt: number,
    skippedReason: string,
  ): SchedulerRunRecord {
    const finishedAt = this.nowMs()
    const state = this.getOrCreateState(task.id)
    const record: SchedulerRunRecord = {
      runId: this.createRunId(),
      taskId: task.id,
      ...(task.pluginId ? { pluginId: task.pluginId } : {}),
      reason: options.reason,
      scheduledFor: options.scheduledFor,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      ok: true,
      skipped: true,
      skippedReason,
    }
    this.recordRun(state, record)
    this.save()
    return record
  }

  private recordRun(state: StoredTaskState, record: SchedulerRunRecord): void {
    state.recentRuns = [record, ...(state.recentRuns || [])].slice(0, MAX_RUN_HISTORY)
  }

  private snapshot(task: InternalTask, state: StoredTaskState): SchedulerTaskSnapshot {
    return {
      id: task.id,
      ...(task.name ? { name: task.name } : {}),
      ...(task.pluginId ? { pluginId: task.pluginId } : {}),
      kind: task.kind || (task.pluginId ? 'plugin' : 'agent'),
      source: task.source || (task.pluginId ? 'plugin' : 'user'),
      readonly: task.readonly ?? Boolean(task.pluginId),
      ...(task.agentId ? { agentId: task.agentId } : {}),
      ...(task.prompt ? { prompt: task.prompt } : {}),
      ...(task.promptPreview ? { promptPreview: task.promptPreview } : {}),
      ...(task.workingDirectory ? { workingDirectory: task.workingDirectory } : {}),
      enabled: state.enabled ?? false,
      ...(typeof state.userEnabled === 'boolean' ? { userEnabled: state.userEnabled } : {}),
      ...(state.schedule ? { schedule: state.schedule } : {}),
      ...(state.scheduleKey ? { scheduleKey: state.scheduleKey } : {}),
      tags: task.tags || [],
      inFlight: state.inFlight === true,
      ...(typeof state.nextRunAt === 'number' ? { nextRunAt: state.nextRunAt } : {}),
      ...(typeof state.lastRunAt === 'number' ? { lastRunAt: state.lastRunAt } : {}),
      ...(typeof state.lastSuccessAt === 'number' ? { lastSuccessAt: state.lastSuccessAt } : {}),
      ...(typeof state.lastErrorAt === 'number' ? { lastErrorAt: state.lastErrorAt } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      ...(typeof state.lastDurationMs === 'number' ? { lastDurationMs: state.lastDurationMs } : {}),
      ...(state.lastRunReason ? { lastRunReason: state.lastRunReason } : {}),
      ...(typeof state.lastScheduledFor === 'number' ? { lastScheduledFor: state.lastScheduledFor } : {}),
      runCount: state.runCount || 0,
      successCount: state.successCount || 0,
      failureCount: state.failureCount || 0,
      ...(state.recentRuns ? { recentRuns: state.recentRuns.slice(0, MAX_RUN_HISTORY) } : {}),
    }
  }

  private rescheduleTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.tasks.size === 0) return
    const now = this.nowMs()
    let next = Number.POSITIVE_INFINITY
    for (const id of this.tasks.keys()) {
      const state = this.state.tasks[id]
      if (!state?.enabled || !state.nextRunAt) continue
      next = Math.min(next, state.nextRunAt)
    }
    const delay = Number.isFinite(next)
      ? Math.max(MIN_TIMER_DELAY_MS, Math.min(MAX_TIMER_DELAY_MS, next - now, SCHEDULER_HEARTBEAT_MS))
      : SCHEDULER_HEARTBEAT_MS
    this.timer = setTimeout(() => {
      void this.tick().catch(error => {
        this.options.logger?.error?.('[Scheduler] Tick failed:', error)
      })
    }, delay)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.tasks.clear()
  }

  private schedulerStatePath(): string | undefined {
    return resolveStateFilePath(this.options.stateFilePath)
  }

  private createRunId(): string {
    return this.options.createRunId?.() || randomUUID()
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now()
  }
}

let scheduler: Scheduler | null = null
let schedulerOptions: SchedulerOptions = {}

export function configureOnethingScheduler(options: SchedulerOptions): void {
  schedulerOptions = options
  scheduler?.dispose()
  scheduler = null
}

export function getOnethingScheduler(): Scheduler {
  if (!scheduler) scheduler = new Scheduler(schedulerOptions)
  return scheduler
}

export function resetOnethingSchedulerForTests(): void {
  scheduler?.dispose()
  scheduler = null
  schedulerOptions = {}
}

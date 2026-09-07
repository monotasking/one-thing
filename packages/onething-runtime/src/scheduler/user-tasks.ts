import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isValidTimezone, parseCronExpression } from './cron.js'
import type { SchedulerSchedule } from './types.js'

export interface OnethingSchedulerUserTaskLogger {
  error?: (...args: unknown[]) => void
}

export interface OnethingSchedulerUserTask {
  ownerUserId?: string
  ownerWorkspaceId?: string
  id: string
  name: string
  prompt: string
  agentId: string
  enabled: boolean
  schedule: SchedulerSchedule
  workingDirectory?: string
  createdAt: number
  updatedAt: number
}

export interface OnethingSchedulerCreateTaskRequest {
  name: string
  prompt: string
  agentId: string
  enabled?: boolean
  schedule: SchedulerSchedule
  workingDirectory?: string
}

export interface OnethingSchedulerUpdateTaskRequest {
  id: string
  name?: string
  prompt?: string
  agentId?: string
  enabled?: boolean
  schedule?: SchedulerSchedule
  workingDirectory?: string | null
}

export interface OnethingSchedulerUserTasksFile {
  version: 1
  tasks: OnethingSchedulerUserTask[]
}

export interface OnethingSchedulerUserTaskStoreOptions {
  tasksFilePath: string | (() => string | undefined)
  defaultAgentId: string
  agentExists?: (agentId: string) => boolean
  createId?: () => string
  now?: () => number
  minIntervalMs?: number
  logger?: OnethingSchedulerUserTaskLogger
}

function resolveTasksFilePath(value: OnethingSchedulerUserTaskStoreOptions['tasksFilePath']): string | undefined {
  const resolved = typeof value === 'function' ? value() : value
  return typeof resolved === 'string' && resolved.trim() ? resolved : undefined
}

export function previewOnethingSchedulerPrompt(prompt: string, maxLength = 180): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized
}

export function normalizeOnethingSchedulerUserTaskSchedule(
  schedule: SchedulerSchedule,
  options: { minIntervalMs?: number } = {},
): SchedulerSchedule {
  if (schedule.kind === 'cron') {
    const expr = schedule.expr.trim()
    parseCronExpression(expr)
    const timezone = schedule.timezone?.trim()
    if (timezone && !isValidTimezone(timezone)) throw new Error(`Invalid timezone: ${timezone}`)
    return {
      kind: 'cron',
      expr,
      ...(timezone ? { timezone } : {}),
    }
  }
  if (schedule.kind === 'interval') {
    const everyMs = Math.max(options.minIntervalMs ?? 60_000, Math.floor(schedule.everyMs))
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

export class OnethingSchedulerUserTaskStore {
  private readonly options: OnethingSchedulerUserTaskStoreOptions

  constructor(options: OnethingSchedulerUserTaskStoreOptions) {
    this.options = options
  }

  list(): OnethingSchedulerUserTask[] {
    return this.readTasksFile().tasks
  }

  get(id: string): OnethingSchedulerUserTask | undefined {
    return this.list().find(task => task.id === id)
  }

  create(input: OnethingSchedulerCreateTaskRequest, owner?: { userId: string; workspaceId: string }): OnethingSchedulerUserTask {
    const file = this.readTasksFile()
    const task = this.validateTaskInput(input)
    if (owner) {
      task.ownerUserId = owner.userId
      task.ownerWorkspaceId = owner.workspaceId
    }
    file.tasks.push(task)
    this.writeTasksFile(file)
    return task
  }

  update(input: OnethingSchedulerUpdateTaskRequest): OnethingSchedulerUserTask {
    const file = this.readTasksFile()
    const index = file.tasks.findIndex(task => task.id === input.id)
    if (index < 0) throw new Error('Scheduled task not found')
    const task = this.validateTaskInput(input, file.tasks[index])
    file.tasks[index] = task
    this.writeTasksFile(file)
    return task
  }

  delete(id: string): void {
    const file = this.readTasksFile()
    const nextTasks = file.tasks.filter(task => task.id !== id)
    if (nextTasks.length === file.tasks.length) throw new Error('Scheduled task not found')
    this.writeTasksFile({ version: 1, tasks: nextTasks })
  }

  setEnabled(id: string, enabled: boolean): OnethingSchedulerUserTask {
    return this.update({ id, enabled })
  }

  private readTasksFile(): OnethingSchedulerUserTasksFile {
    try {
      const filePath = this.tasksFilePath()
      if (!filePath || !fs.existsSync(filePath)) return { version: 1, tasks: [] }
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<OnethingSchedulerUserTasksFile>
      return {
        version: 1,
        tasks: Array.isArray(parsed.tasks)
          ? parsed.tasks.map(task => this.normalizeStoredTask(task)).filter((task): task is OnethingSchedulerUserTask => Boolean(task))
          : [],
      }
    } catch (error) {
      this.options.logger?.error?.('[SchedulerUserTasks] Failed to read tasks file:', error)
      return { version: 1, tasks: [] }
    }
  }

  private writeTasksFile(file: OnethingSchedulerUserTasksFile): void {
    const filePath = this.tasksFilePath()
    if (!filePath) throw new Error('Scheduler user tasks file path is not configured')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.${process.pid}.${this.nowMs()}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, tasks: file.tasks }, null, 2), 'utf-8')
    fs.renameSync(tmpPath, filePath)
  }

  private normalizeStoredTask(raw: Partial<OnethingSchedulerUserTask>): OnethingSchedulerUserTask | null {
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
    const agentId = typeof raw.agentId === 'string' && raw.agentId.trim()
      ? raw.agentId.trim()
      : this.options.defaultAgentId
    if (!id || !name || !prompt || !raw.schedule) return null
    try {
      return {
        id,
        name,
        prompt,
        agentId,
        enabled: raw.enabled !== false,
        schedule: normalizeOnethingSchedulerUserTaskSchedule(raw.schedule, {
          minIntervalMs: this.options.minIntervalMs,
        }),
        ...(typeof raw.workingDirectory === 'string' && raw.workingDirectory.trim()
          ? { workingDirectory: raw.workingDirectory.trim() }
          : {}),
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : this.nowMs(),
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : this.nowMs(),
        ...(typeof raw.ownerUserId === 'string' ? { ownerUserId: raw.ownerUserId } : {}),
        ...(typeof raw.ownerWorkspaceId === 'string' ? { ownerWorkspaceId: raw.ownerWorkspaceId } : {}),
      }
    } catch {
      return null
    }
  }

  private validateTaskInput(
    input: OnethingSchedulerCreateTaskRequest | OnethingSchedulerUpdateTaskRequest,
    current?: OnethingSchedulerUserTask,
  ): OnethingSchedulerUserTask {
    const timestamp = this.nowMs()
    const id = current?.id || `user:${this.options.createId?.() || randomUUID()}`
    const name = (input.name ?? current?.name ?? '').trim()
    const prompt = (input.prompt ?? current?.prompt ?? '').trim()
    const agentId = (input.agentId ?? current?.agentId ?? this.options.defaultAgentId).trim()
      || this.options.defaultAgentId
    if (!name) throw new Error('Task name is required')
    if (!prompt) throw new Error('Task prompt is required')
    if (this.options.agentExists && !this.options.agentExists(agentId)) throw new Error('Agent not found')
    const schedule = input.schedule
      ? normalizeOnethingSchedulerUserTaskSchedule(input.schedule, { minIntervalMs: this.options.minIntervalMs })
      : current?.schedule
    if (!schedule) throw new Error('Task schedule is required')
    const workingDirectory = input.workingDirectory === null
      ? undefined
      : typeof input.workingDirectory === 'string'
        ? input.workingDirectory.trim() || undefined
        : current?.workingDirectory

    return {
      id,
      name,
      prompt,
      agentId,
      enabled: input.enabled ?? current?.enabled ?? true,
      schedule,
      ...(workingDirectory ? { workingDirectory } : {}),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(current?.ownerUserId !== undefined ? { ownerUserId: current.ownerUserId } : {}),
      ...(current?.ownerWorkspaceId !== undefined ? { ownerWorkspaceId: current.ownerWorkspaceId } : {}),
    }
  }

  private tasksFilePath(): string | undefined {
    return resolveTasksFilePath(this.options.tasksFilePath)
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now()
  }
}

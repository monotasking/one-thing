import type { JsonObject, JsonValue } from '../json.js'
import { defineRouter } from './router.js'

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

export interface SchedulerRunRecordDTO {
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
  result?: JsonValue
}

export interface SchedulerRunTimelineEntryDTO {
  id: string
  timestamp: number
  type: string
  title: string
  detail?: string
  durationMs?: number
  toolCallId?: string
  stepId?: string
  status?: string
  metadata?: JsonObject
}

export interface SchedulerRunToolCallDTO {
  id: string
  toolName: string
  status: string
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  argumentsPreview?: string
  resultPreview?: string
  error?: string
}

export interface SchedulerRunStepDTO {
  id: string
  title: string
  status: string
  timestamp: number
  finishedAt?: number
  durationMs?: number
  toolCallId?: string
  resultPreview?: string
  error?: string
}

export interface SchedulerRunDetailDTO extends SchedulerRunRecordDTO {
  status: SchedulerRunStatus
  agentId?: string
  sessionId?: string
  assistantMessageId?: string
  resultPreview?: string
  steps?: SchedulerRunStepDTO[]
  toolCalls?: SchedulerRunToolCallDTO[]
  timeline?: SchedulerRunTimelineEntryDTO[]
}

export interface SchedulerTaskSnapshotDTO {
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
  recentRuns?: SchedulerRunRecordDTO[]
}

export interface SchedulerUserTaskDTO {
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

export interface SchedulerListResponse {
  success: boolean
  tasks?: SchedulerTaskSnapshotDTO[]
  error?: string
}

export interface SchedulerGetRequest {
  id: string
}

export interface SchedulerGetResponse {
  success: boolean
  task?: SchedulerTaskSnapshotDTO
  error?: string
}

export interface SchedulerRunNowRequest {
  id: string
  force?: boolean
}

export interface SchedulerRunNowResponse {
  success: boolean
  record?: SchedulerRunRecordDTO
  error?: string
}

export interface SchedulerSetEnabledRequest {
  id: string
  enabled: boolean
}

export interface SchedulerSetEnabledResponse {
  success: boolean
  task?: SchedulerTaskSnapshotDTO
  error?: string
}

export interface SchedulerCreateTaskRequest {
  name: string
  prompt: string
  agentId: string
  enabled?: boolean
  schedule: SchedulerSchedule
  workingDirectory?: string
}

export interface SchedulerUpdateTaskRequest {
  id: string
  name?: string
  prompt?: string
  agentId?: string
  enabled?: boolean
  schedule?: SchedulerSchedule
  workingDirectory?: string | null
}

export interface SchedulerDeleteTaskRequest {
  id: string
}

export interface SchedulerWriteTaskResponse {
  success: boolean
  task?: SchedulerTaskSnapshotDTO
  error?: string
}

export interface SchedulerDeleteTaskResponse {
  success: boolean
  error?: string
}

export interface SchedulerListRunsRequest {
  taskId: string
  limit?: number
}

export interface SchedulerListRunsResponse {
  success: boolean
  runs?: SchedulerRunDetailDTO[]
  error?: string
}

export interface SchedulerGetRunRequest {
  taskId: string
  runId: string
}

export interface SchedulerGetRunResponse {
  success: boolean
  run?: SchedulerRunDetailDTO
  error?: string
}

/**
 * scheduler(定时任务:内置任务 + 用户任务 + 运行历史)域 —— 结构债 P4c 第一域。
 *
 * 九个方法全是**纯数据面**:列任务 / 读一个 / 立刻跑 / 开关 / 用户任务的增改删 /
 * 运行历史的列与读。判定与降级(`{ success, error }` 的包法)住在
 * `@onething/runtime/scheduler` 的那批依赖注入投影(`*ForIpc`)里,传输面只把
 * 端口接上去 —— 这也是它能整只搬进 `app/rpc/domains/scheduler.ts` 的原因。
 *
 * **无入参的方法一律 `Record<string, never>`**,调用处传 `{}`(spaces 的
 * `list({})` 判例):router 的 payload 是一个信封,位置参数在这条通道上没有位置。
 *
 * 这个域**一条推送都没有** —— 任务状态的变化今天不往渲染层推,面板是拉的。
 */
export type SchedulerRoutes = {
  list: { input: Record<string, never>; output: SchedulerListResponse }
  get: { input: SchedulerGetRequest; output: SchedulerGetResponse }
  runNow: { input: SchedulerRunNowRequest; output: SchedulerRunNowResponse }
  setEnabled: { input: SchedulerSetEnabledRequest; output: SchedulerSetEnabledResponse }
  createTask: { input: SchedulerCreateTaskRequest; output: SchedulerWriteTaskResponse }
  updateTask: { input: SchedulerUpdateTaskRequest; output: SchedulerWriteTaskResponse }
  deleteTask: { input: SchedulerDeleteTaskRequest; output: SchedulerDeleteTaskResponse }
  listRuns: { input: SchedulerListRunsRequest; output: SchedulerListRunsResponse }
  getRun: { input: SchedulerGetRunRequest; output: SchedulerGetRunResponse }
}

export const schedulerRouter = defineRouter<SchedulerRoutes>('scheduler', [
  'list',
  'get',
  'runNow',
  'setEnabled',
  'createTask',
  'updateTask',
  'deleteTask',
  'listRuns',
  'getRun',
])

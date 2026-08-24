import { v4 as uuidv4 } from 'uuid'
import {
  OnethingSchedulerUserTaskStore,
  previewOnethingSchedulerPrompt,
  runOnethingSchedulerAgentTask,
  type OnethingSchedulerRunDetail,
} from '@onething/runtime/scheduler'
import type {
  SchedulerCreateTaskRequest,
  SchedulerRunDetailDTO,
  SchedulerTaskSnapshotDTO,
  SchedulerUpdateTaskRequest,
  SchedulerUserTaskDTO,
} from '@shared/ipc.js'
import { DEFAULT_AGENT_ID, agentExists } from '../agents/index.js'
import { getEventBus } from '../../events/index.js'
import { getStreamEngineSafe } from '../engine/index.js'
import * as store from '../../store.js'
import { getScheduler } from '@onething/runtime/scheduler/scheduler-bound'
import type { SchedulerTaskContext, SchedulerTaskHandle } from '@onething/runtime/scheduler'
import {
  getOnethingSchedulerTasksPath,
} from '@onething/runtime/storage'
import { saveSchedulerRunDetail } from '@onething/runtime/scheduler/run-history-bound.wiring'
import { consolePort, getLogger } from '../logging/index.js'
import type { OnethingSchedulerAgentTaskEventBus, OnethingSchedulerAgentTaskSessionStore, OnethingSchedulerAgentTaskRunnerOptions, OnethingSchedulerAgentTaskLogger } from '@onething/runtime/scheduler/agent-task-runner'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingSchedulerUserTaskLogger } from '@onething/runtime/scheduler/user-tasks'

const log = getLogger('scheduler')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingSchedulerAgentTaskLogger & OnethingSchedulerUserTaskLogger = consolePort(log)


const USER_TASK_TIMEOUT_MS = 30 * 60 * 1000
const userTaskStore = new OnethingSchedulerUserTaskStore({
  tasksFilePath: getOnethingSchedulerTasksPath,
  defaultAgentId: DEFAULT_AGENT_ID,
  agentExists,
  createId: uuidv4,
  logger: consoleLog,
})
const userTaskHandles = new Map<string, SchedulerTaskHandle>()
let initialized = false

function nowMs(): number {
  return Date.now()
}

function getUserTask(id: string): SchedulerUserTaskDTO | undefined {
  return userTaskStore.get(id) as SchedulerUserTaskDTO | undefined
}

function registerUserTask(task: SchedulerUserTaskDTO): SchedulerTaskSnapshotDTO | undefined {
  userTaskHandles.get(task.id)?.unregister()
  const handle = getScheduler().register({
    id: task.id,
    name: task.name,
    kind: 'agent',
    source: 'user',
    readonly: false,
    agentId: task.agentId,
    prompt: task.prompt,
    promptPreview: previewOnethingSchedulerPrompt(task.prompt),
    workingDirectory: task.workingDirectory,
    tags: ['agent', 'user'],
    enabled: () => task.enabled,
    schedule: () => task.schedule,
    timeoutMs: USER_TASK_TIMEOUT_MS,
    run: context => runAgentTask(task.id, context),
  })
  userTaskHandles.set(task.id, handle)
  return handle.getStatus() as SchedulerTaskSnapshotDTO | undefined
}

function unregisterUserTask(id: string): void {
  userTaskHandles.get(id)?.unregister()
  userTaskHandles.delete(id)
}

export function initializeUserSchedulerTasks(): void {
  if (initialized) return
  initialized = true
  for (const task of userTaskStore.list()) {
    registerUserTask(task as SchedulerUserTaskDTO)
  }
}

export function isUserSchedulerTask(id: string): boolean {
  return id.startsWith('user:') || Boolean(getUserTask(id))
}

export function createUserSchedulerTask(input: SchedulerCreateTaskRequest): SchedulerTaskSnapshotDTO {
  const task = userTaskStore.create(input)
  const snapshot = registerUserTask(task as SchedulerUserTaskDTO)
  if (!snapshot) throw new Error('Failed to register scheduled task')
  return snapshot
}

export function updateUserSchedulerTask(input: SchedulerUpdateTaskRequest): SchedulerTaskSnapshotDTO {
  const task = userTaskStore.update(input)
  const snapshot = registerUserTask(task as SchedulerUserTaskDTO)
  if (!snapshot) throw new Error('Failed to register scheduled task')
  return snapshot
}

export function deleteUserSchedulerTask(id: string): void {
  userTaskStore.delete(id)
  unregisterUserTask(id)
}

export function setUserSchedulerTaskEnabled(id: string, enabled: boolean): SchedulerTaskSnapshotDTO {
  return updateUserSchedulerTask({ id, enabled })
}

async function runAgentTask(taskId: string, context: SchedulerTaskContext): Promise<Record<string, unknown>> {
  const eventBus = getEventBus()
  const eventBusPort: OnethingSchedulerAgentTaskEventBus = {
    onAny: (sessionId, handler, label) =>
      eventBus.onAny(sessionId, handler as unknown as Parameters<typeof eventBus.onAny>[1], label),
    emit: (sessionId, event) =>
      eventBus.emit(sessionId, event as unknown as Parameters<typeof eventBus.emit>[1]),
  };
  const sessionsPort: OnethingSchedulerAgentTaskSessionStore = {
    getCurrentSessionId: store.getCurrentSessionId,
    createSession: store.createSession,
    updateSessionAgent: store.updateSessionAgent,
    updateSessionWorkingDirectory: store.updateSessionWorkingDirectory,
    updateSessionArchived: store.updateSessionArchived,
    setCurrentSessionId: store.setCurrentSessionId,
    getSession: store.getSession,
  };
  const schedulerAgentTaskRunnerOptions: OnethingSchedulerAgentTaskRunnerOptions = {
    getTask: getUserTask,
    getStreamHost: getStreamEngineSafe,
    eventBus: eventBusPort,
    sessions: sessionsPort,
    saveRunDetail: detail => saveSchedulerRunDetail(detail as SchedulerRunDetailDTO) as OnethingSchedulerRunDetail,
    createId: uuidv4,
    now: nowMs,
    logger: consoleLog,
  };
  return await runOnethingSchedulerAgentTask(taskId, context, schedulerAgentTaskRunnerOptions)
}

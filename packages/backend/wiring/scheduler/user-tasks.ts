import { v4 as uuidv4 } from 'uuid'
import {
  OnethingSchedulerUserTaskStore,
  previewOnethingSchedulerPrompt,
  runOnethingSchedulerAgentTask,
  type OnethingSchedulerRunDetail,
  type OnethingSchedulerUserTask,
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
import { DEFAULT_SESSION_OWNER, isHistoricalLocalOperator, ownsSessionRecord, requestSessionOwner, sessionOwnerOf, sessionAccess, type SessionAccessContext } from '../../session/access.js'
import { fixedExecutionContext } from '../engine/execution-context.js'

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

function getUserTask(id: string): OnethingSchedulerUserTask | undefined {
  return userTaskStore.get(id)
}

export function canAccessSchedulerTask(context: SessionAccessContext, id: string): boolean {
  const task = getUserTask(id)
  if (task) return ownsSessionRecord(task, context)
  // Built-in/plugin tasks and historical records have one fixed local owner.
  return Boolean(getScheduler().getStatus(id)) && isHistoricalLocalOperator(context)
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

/**
 * 盘上那些用户定义的定时任务装进调度器。
 *
 * A3(`docs/design/backend-composition-root-2026-09.md` §2.4「谁起的,谁 own()」):
 * 返回一个 disposer,两个 GUI 宿主起完就 `backend.own(...)` 它 —— 从前这件事
 * **没有 stop 口**,于是它是关机链上唯一一件按设计就关不掉的:每个 handle 背后
 * 是 `Scheduler` 的 `setTimeout` 链(scheduler.ts `rescheduleTimer`),而那条链
 * 只有在表空了之后 `rescheduleTimer` 才会 `clearTimeout` 且不再续。
 *
 * disposer 幂等,并且把 `initialized` 放回去 —— 装配 → dispose → 再装配要真的
 * 重新读一次盘,否则第二份进程里一条用户任务都不会被注册。
 */
export function initializeUserSchedulerTasks(): () => void {
  if (initialized) return stopUserSchedulerTasks
  initialized = true
  for (const task of userTaskStore.list()) {
    registerUserTask(task as SchedulerUserTaskDTO)
  }
  return stopUserSchedulerTasks
}

/**
 * 对称的收尾:把这里注册进去的每一只都从调度器上摘掉。
 *
 * 只摘**自己**注册的那些(`userTaskHandles` 里的),插件任务与内置任务不碰 ——
 * 摘完最后一只时 `Scheduler.unregister` 自己会 `rescheduleTimer`,表空了那条
 * `setTimeout` 链就断了。没起过就是一次 no-op。
 */
export function stopUserSchedulerTasks(): void {
  for (const handle of userTaskHandles.values()) {
    try {
      handle.unregister()
    } catch (error) {
      log.error('scheduled task unregister failed', { taskId: handle.id }, error)
    }
  }
  const stopped = userTaskHandles.size
  userTaskHandles.clear()
  initialized = false
  // 关机链上这一步从前不存在,所以它在账本里也不存在 —— 真机走查判断"调度器
  // 到底收没收摊"时,没有这一行就只能靠猜。
  if (stopped > 0) log.info('scheduled tasks stopped', { count: stopped })
}

export function isUserSchedulerTask(id: string): boolean {
  return id.startsWith('user:') || Boolean(getUserTask(id))
}

export function createUserSchedulerTask(input: SchedulerCreateTaskRequest, context: SessionAccessContext = DEFAULT_SESSION_OWNER): SchedulerTaskSnapshotDTO {
  const task = userTaskStore.create(input, requestSessionOwner(context))
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
  const task = getUserTask(taskId)
  if (!task) throw new Error('Scheduled task not found')
  // Snapshot the persisted creator, never the owner of a session selected later.
  const executionContext = fixedExecutionContext(sessionOwnerOf(task))
  const eventBus = getEventBus()
  const eventBusPort: OnethingSchedulerAgentTaskEventBus = {
    onAny: (sessionId, handler, label) => {
      sessionAccess.resolve(executionContext, sessionId, 'subscribe')
      return eventBus.onAny(sessionId, handler as unknown as Parameters<typeof eventBus.onAny>[1], label)
    },
    emit: (sessionId, event) => {
      sessionAccess.resolve(executionContext, sessionId, 'write')
      return eventBus.emit(sessionId, event as unknown as Parameters<typeof eventBus.emit>[1], { executionContext })
    },
  };
  const sessionsPort: OnethingSchedulerAgentTaskSessionStore = {
    getCurrentSessionId: store.getCurrentSessionId,
    createSession: store.createSession,
    updateSessionAgent: store.updateSessionAgent,
    updateSessionWorkingDirectory: store.updateSessionWorkingDirectory,
    updateSessionArchived: store.updateSessionArchived,
    setCurrentSessionId: store.setCurrentSessionId,
    getSession: sessionId => {
      sessionAccess.resolve(executionContext, sessionId, 'read')
      return store.getSession(sessionId)
    },
  };
  const schedulerAgentTaskRunnerOptions: OnethingSchedulerAgentTaskRunnerOptions = {
    initialOwner: executionContext,
    getTask: () => task,
    getStreamHost: () => {
      const engine = getStreamEngineSafe()
      return engine && {
        hasBoundSender: () => engine.hasBoundSender(),
        abort: sessionId => {
          try {
            sessionAccess.resolve(executionContext, sessionId, 'abort')
            return engine.abort(sessionId)
          } catch (error) {
            // Timer/signal callbacks must not throw after session deletion or shutdown.
            log.warn('scheduled session abort refused', { taskId, sessionId }, error)
            return false
          }
        },
      }
    },
    eventBus: eventBusPort,
    sessions: sessionsPort,
    saveRunDetail: detail => saveSchedulerRunDetail(detail as SchedulerRunDetailDTO) as OnethingSchedulerRunDetail,
    createId: uuidv4,
    now: nowMs,
    logger: consoleLog,
  };
  return await runOnethingSchedulerAgentTask(taskId, context, schedulerAgentTaskRunnerOptions)
}

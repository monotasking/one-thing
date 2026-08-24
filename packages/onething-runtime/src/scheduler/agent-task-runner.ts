import { randomUUID } from 'node:crypto'
import {
  createOnethingSchedulerTimelineEntry,
  finishOnethingSchedulerRunDetail,
  previewOnethingSchedulerRunValue,
  toOnethingSchedulerRunStep,
  toOnethingSchedulerRunToolCall,
  type OnethingSchedulerMessageStepLike,
  type OnethingSchedulerRunDetail,
  type OnethingSchedulerToolCallLike, type OnethingSchedulerRunDetailOptions,
} from './run-detail.js'
import type { SchedulerTaskContext } from './types.js'
import type { OnethingSchedulerUserTask } from './user-tasks.js'

import { SESSION_EVENT_TYPES, SESSION_COMMAND_TYPES } from '@shared/events/index.js'

type MaybePromise<T> = T | Promise<T>

export interface OnethingSchedulerAgentTaskLogger {
  error?: (...args: unknown[]) => void
}

export interface OnethingSchedulerAgentTaskStreamHost {
  hasBoundSender(): boolean
  abort(sessionId: string): unknown
}

export interface OnethingSchedulerAgentTaskEventEnvelope {
  timestamp: number
  event: {
    type: string
    [key: string]: unknown
  }
}

export interface OnethingSchedulerAgentTaskEventBus {
  onAny(
    sessionId: string,
    handler: (envelope: OnethingSchedulerAgentTaskEventEnvelope) => void,
    label: string,
  ): () => void
  emit(sessionId: string, event: Record<string, unknown>): Promise<unknown>
}

export interface OnethingSchedulerAgentTaskMessage {
  id: string
  role: string
  content?: string
  steps?: OnethingSchedulerMessageStepLike[]
  toolCalls?: Array<OnethingSchedulerToolCallLike & {
    rejected?: boolean
    rejectionReason?: string
  }>
}

export interface OnethingSchedulerAgentTaskSession {
  id: string
  messages?: OnethingSchedulerAgentTaskMessage[]
}

export interface OnethingSchedulerAgentTaskSessionStore {
  getCurrentSessionId(): string | undefined
  createSession(sessionId: string, name: string): OnethingSchedulerAgentTaskSession
  updateSessionAgent(sessionId: string, agentId: string): unknown
  updateSessionWorkingDirectory(sessionId: string, workingDirectory: string): unknown
  updateSessionArchived(sessionId: string, isArchived: boolean, archivedAt?: number | null): unknown
  setCurrentSessionId(sessionId: string): unknown
  getSession(sessionId: string): OnethingSchedulerAgentTaskSession | undefined
}

export interface OnethingSchedulerAgentTaskRunnerOptions {
  getTask(taskId: string): MaybePromise<OnethingSchedulerUserTask | undefined>
  getStreamHost(): OnethingSchedulerAgentTaskStreamHost | null | undefined
  eventBus: OnethingSchedulerAgentTaskEventBus
  sessions: OnethingSchedulerAgentTaskSessionStore
  saveRunDetail(detail: OnethingSchedulerRunDetail): MaybePromise<OnethingSchedulerRunDetail>
  createId?: () => string
  now?: () => number
  startTimeoutMs?: number
  logger?: OnethingSchedulerAgentTaskLogger
}

function nowMs(options: OnethingSchedulerAgentTaskRunnerOptions): number {
  return options.now?.() ?? Date.now()
}

function createId(options: OnethingSchedulerAgentTaskRunnerOptions): string {
  return options.createId?.() || randomUUID()
}

function timelineEntry(
  input: Parameters<typeof createOnethingSchedulerTimelineEntry>[0],
  options: OnethingSchedulerAgentTaskRunnerOptions,
) {
  const schedulerRunDetailOptions: OnethingSchedulerRunDetailOptions = {
    createId: () => createId(options),
    now: () => nowMs(options),
  };
  return createOnethingSchedulerTimelineEntry(input, schedulerRunDetailOptions)
}

async function finishRunDetail(
  detail: OnethingSchedulerRunDetail,
  options: OnethingSchedulerAgentTaskRunnerOptions,
): Promise<OnethingSchedulerRunDetail> {
  const schedulerRunDetailOptions2: OnethingSchedulerRunDetailOptions = { now: () => nowMs(options) };
  const next = finishOnethingSchedulerRunDetail(detail, schedulerRunDetailOptions2)
  return await options.saveRunDetail(next)
}

function eventObject(envelope: OnethingSchedulerAgentTaskEventEnvelope): Record<string, unknown> & { type: string } {
  return envelope.event
}

export async function runOnethingSchedulerAgentTask(
  taskId: string,
  context: SchedulerTaskContext,
  options: OnethingSchedulerAgentTaskRunnerOptions,
): Promise<Record<string, unknown>> {
  const task = await options.getTask(taskId)
  if (!task) throw new Error(`Scheduled task not found: ${taskId}`)

  const startedAt = nowMs(options)
  const detail: OnethingSchedulerRunDetail = {
    runId: context.runId,
    taskId,
    reason: context.reason,
    scheduledFor: context.scheduledFor,
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    ok: false,
    status: 'running',
    agentId: task.agentId,
    steps: [],
    toolCalls: [],
    timeline: [
      timelineEntry({
        type: 'run:start',
        title: 'Run started',
        detail: task.name,
        timestamp: startedAt,
      }, options),
    ],
  }

  const streamHost = options.getStreamHost()
  if (!streamHost?.hasBoundSender()) {
    detail.status = 'skipped'
    detail.ok = true
    detail.skipped = true
    detail.skippedReason = 'main-window-unavailable'
    detail.error = 'Scheduled task skipped because no app window is available to host the stream.'
    const result = await finishRunDetail(detail, options)
    return {
      status: result.status,
      runId: result.runId,
      error: result.error,
      skippedReason: result.skippedReason,
    }
  }

  const previousSessionId = options.sessions.getCurrentSessionId()
  const sessionId = createId(options)
  const session = options.sessions.createSession(sessionId, `Scheduled: ${task.name}`)
  options.sessions.updateSessionAgent(sessionId, task.agentId)
  if (task.workingDirectory) options.sessions.updateSessionWorkingDirectory(sessionId, task.workingDirectory)
  options.sessions.updateSessionArchived(sessionId, true, startedAt)
  if (previousSessionId && previousSessionId !== sessionId) options.sessions.setCurrentSessionId(previousSessionId)

  detail.sessionId = session.id
  detail.timeline?.push(timelineEntry({
    type: 'session:created',
    title: 'Execution session created',
    detail: session.id,
  }, options))

  let blocked = false
  let terminalError = ''
  let assistantMessageId = ''

  const terminal = new Promise<void>((resolve) => {
    const cleanupFns: Array<() => void> = []
    let resolved = false
    const startTimer = setTimeout(() => {
      options.getStreamHost()?.abort(sessionId)
      complete('Scheduled task did not start within 15 seconds.')
    }, options.startTimeoutMs ?? 15_000)
    startTimer.unref?.()
    cleanupFns.push(() => clearTimeout(startTimer))

    const complete = (error?: string) => {
      if (resolved) return
      resolved = true
      terminalError = error || terminalError
      for (const cleanup of cleanupFns) cleanup()
      resolve()
    }

    cleanupFns.push(options.eventBus.onAny(sessionId, (envelope) => {
      const event = eventObject(envelope)
      if (event.type === SESSION_EVENT_TYPES.STREAM_START) {
        clearTimeout(startTimer)
        assistantMessageId = typeof event.assistantMessageId === 'string' ? event.assistantMessageId : ''
        detail.assistantMessageId = assistantMessageId
        detail.timeline?.push(timelineEntry({
          type: SESSION_EVENT_TYPES.STREAM_START,
          title: 'Agent stream started',
          detail: typeof event.model === 'string' ? event.model : undefined,
          timestamp: envelope.timestamp,
        }, options))
        return
      }
      if (event.type === SESSION_EVENT_TYPES.PERMISSION_REQUEST) {
        blocked = true
        const requestId = typeof event.requestId === 'string' ? event.requestId : ''
        detail.timeline?.push(timelineEntry({
          type: 'permission:blocked',
          title: 'Permission blocked',
          detail: typeof event.title === 'string' ? event.title : undefined,
          timestamp: envelope.timestamp,
          toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
          metadata: { permissionType: event.permissionType, pattern: event.pattern },
        }, options))
        options.eventBus.emit(sessionId, {
          type: SESSION_COMMAND_TYPES.PERMISSION_RESPOND,
          channel: 'scheduler',
          requestId,
          decision: 'reject',
          rejectReason: 'Scheduled tasks can only use tools that were already authorized.',
        }).catch(error => options.logger?.error?.('[SchedulerUserTasks] Failed to reject permission:', error))
        return
      }
      if (event.type === SESSION_EVENT_TYPES.STEP_ADDED) {
        const step = event.step as { id?: string; title?: string; status?: string; toolCallId?: string } | undefined
        detail.timeline?.push(timelineEntry({
          type: SESSION_EVENT_TYPES.STEP_ADDED,
          title: step?.title || 'Step added',
          status: step?.status,
          stepId: step?.id,
          toolCallId: step?.toolCallId,
          timestamp: envelope.timestamp,
        }, options))
        return
      }
      if (event.type === SESSION_EVENT_TYPES.STEP_UPDATED) {
        const updates = event.updates as { title?: string; status?: string } | undefined
        const stepId = typeof event.stepId === 'string' ? event.stepId : ''
        detail.timeline?.push(timelineEntry({
          type: SESSION_EVENT_TYPES.STEP_UPDATED,
          title: updates?.title || stepId,
          status: updates?.status,
          stepId,
          timestamp: envelope.timestamp,
        }, options))
        return
      }
      if (event.type === SESSION_EVENT_TYPES.TOOL_CALL || event.type === SESSION_EVENT_TYPES.TOOL_RESULT) {
        const toolCall = event.toolCall as { id?: string; toolName?: string; status?: string; error?: string } | undefined
        detail.timeline?.push(timelineEntry({
          type: event.type,
          title: toolCall?.toolName || 'Tool call',
          status: toolCall?.status,
          toolCallId: toolCall?.id,
          timestamp: envelope.timestamp,
          detail: toolCall?.error,
        }, options))
        return
      }
      if (event.type === SESSION_EVENT_TYPES.STREAM_COMPLETE) {
        const data = event.data as { error?: string; usage?: unknown } | undefined
        detail.timeline?.push(timelineEntry({
          type: SESSION_EVENT_TYPES.STREAM_COMPLETE,
          title: 'Agent stream completed',
          detail: data?.error,
          timestamp: envelope.timestamp,
          metadata: data?.usage ? { usage: data.usage } : undefined,
        }, options))
        complete(data?.error)
        return
      }
      if (event.type === SESSION_EVENT_TYPES.STREAM_ERROR) {
        const data = event.data as { error?: string } | undefined
        detail.timeline?.push(timelineEntry({
          type: SESSION_EVENT_TYPES.STREAM_ERROR,
          title: 'Agent stream failed',
          detail: data?.error,
          timestamp: envelope.timestamp,
        }, options))
        complete(data?.error)
        return
      }
      if (event.type === SESSION_EVENT_TYPES.STREAM_ABORTED) {
        const reason = typeof event.reason === 'string' ? event.reason : undefined
        detail.timeline?.push(timelineEntry({
          type: SESSION_EVENT_TYPES.STREAM_ABORTED,
          title: 'Agent stream aborted',
          detail: reason,
          timestamp: envelope.timestamp,
        }, options))
        complete(reason || 'Stream aborted')
      }
    }, 'SchedulerUserTaskRun'))

    const onAbort = () => {
      options.getStreamHost()?.abort(sessionId)
      complete('Scheduled task was cancelled.')
    }
    context.signal.addEventListener('abort', onAbort, { once: true })
    cleanupFns.push(() => context.signal.removeEventListener('abort', onAbort))

    options.eventBus.emit(sessionId, {
      type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
      channel: 'scheduler',
      content: task.prompt,
    }).catch(error => complete(error instanceof Error ? error.message : String(error)))
  })

  await terminal

  const finishedAt = nowMs(options)
  const finishedSession = options.sessions.getSession(sessionId)
  const assistant = assistantMessageId
    ? finishedSession?.messages?.find(message => message.id === assistantMessageId)
    : finishedSession?.messages?.filter(message => message.role === 'assistant').pop()
  const failedTool = assistant?.toolCalls?.find(toolCall => toolCall.status === 'failed' || toolCall.rejected)

  detail.finishedAt = finishedAt
  detail.durationMs = finishedAt - startedAt
  detail.assistantMessageId = assistant?.id || detail.assistantMessageId
  detail.steps = (assistant?.steps || []).map(step => toOnethingSchedulerRunStep(step))
  detail.toolCalls = (assistant?.toolCalls || []).map(toolCall => toOnethingSchedulerRunToolCall(toolCall))
  detail.resultPreview = assistant?.content ? previewOnethingSchedulerRunValue(assistant.content, 1000) : undefined
  detail.error = terminalError || failedTool?.error || failedTool?.rejectionReason
  if (blocked && !detail.error) {
    detail.error = 'Scheduled task requested a tool permission that was not pre-authorized.'
  }
  detail.status = context.signal.aborted
    ? 'cancelled'
    : blocked
      ? 'blocked'
      : detail.error
        ? 'failed'
        : 'succeeded'
  detail.ok = detail.status === 'succeeded'
  detail.timeline?.push(timelineEntry({
    type: 'run:finish',
    title: `Run ${detail.status}`,
    detail: detail.error,
    timestamp: finishedAt,
    durationMs: detail.durationMs,
  }, options))

  const result = await finishRunDetail(detail, options)
  if (!result.ok && result.error) throw new Error(result.error)
  return {
    status: result.status,
    sessionId: result.sessionId,
    runId: result.runId,
    resultPreview: result.resultPreview,
    error: result.error,
  }
}

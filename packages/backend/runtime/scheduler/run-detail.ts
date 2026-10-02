import { randomUUID } from 'node:crypto'
import type { SchedulerRunReason } from './types.js'

export type OnethingSchedulerRunStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'skipped' | 'cancelled'

export interface OnethingSchedulerRunTimelineEntry {
  id: string
  timestamp: number
  type: string
  title: string
  detail?: string
  durationMs?: number
  toolCallId?: string
  stepId?: string
  status?: string
  metadata?: Record<string, unknown>
}

export interface OnethingSchedulerRunTimelineInput {
  type: string
  title: string
  timestamp?: number
  detail?: string
  durationMs?: number
  toolCallId?: string
  stepId?: string
  status?: string
  metadata?: Record<string, unknown>
}

export interface OnethingSchedulerRunStep {
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

export interface OnethingSchedulerRunToolCall {
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

export interface OnethingSchedulerRunDetail {
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
  status: OnethingSchedulerRunStatus
  agentId?: string
  sessionId?: string
  assistantMessageId?: string
  resultPreview?: string
  steps?: OnethingSchedulerRunStep[]
  toolCalls?: OnethingSchedulerRunToolCall[]
  timeline?: OnethingSchedulerRunTimelineEntry[]
}

export interface OnethingSchedulerMessageStepLike {
  id: string
  title: string
  status: string
  timestamp: number
  toolCallId?: string
  result?: unknown
  error?: string
  toolCall?: {
    startTime?: number
    endTime?: number
  }
}

export interface OnethingSchedulerToolCallLike {
  id: string
  toolName: string
  status: string
  startTime?: number
  endTime?: number
  arguments?: unknown
  result?: unknown
  error?: string
}

export interface OnethingSchedulerRunDetailRecordLike {
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

export interface OnethingSchedulerRunDetailOptions {
  createId?: () => string
  now?: () => number
}

function nowMs(options: OnethingSchedulerRunDetailOptions | undefined): number {
  return options?.now?.() ?? Date.now()
}

function createId(options: OnethingSchedulerRunDetailOptions | undefined): string {
  return options?.createId?.() || randomUUID()
}

export function previewOnethingSchedulerRunValue(value: unknown, maxLength = 500): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text
}

export function createOnethingSchedulerTimelineEntry(
  input: OnethingSchedulerRunTimelineInput,
  options?: OnethingSchedulerRunDetailOptions,
): OnethingSchedulerRunTimelineEntry {
  return {
    id: createId(options),
    timestamp: input.timestamp ?? nowMs(options),
    type: input.type,
    title: input.title,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(typeof input.durationMs === 'number' ? { durationMs: input.durationMs } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }
}

export function toOnethingSchedulerRunStep(messageStep: OnethingSchedulerMessageStepLike): OnethingSchedulerRunStep {
  const finishedAt = messageStep.toolCall?.endTime
  const startedAt = messageStep.toolCall?.startTime || messageStep.timestamp
  return {
    id: messageStep.id,
    title: messageStep.title,
    status: messageStep.status,
    timestamp: messageStep.timestamp,
    ...(typeof finishedAt === 'number' ? { finishedAt } : {}),
    ...(typeof finishedAt === 'number' ? { durationMs: Math.max(0, finishedAt - startedAt) } : {}),
    ...(messageStep.toolCallId ? { toolCallId: messageStep.toolCallId } : {}),
    ...(messageStep.result ? { resultPreview: previewOnethingSchedulerRunValue(messageStep.result, 300) } : {}),
    ...(messageStep.error ? { error: messageStep.error } : {}),
  }
}

export function toOnethingSchedulerRunToolCall(toolCall: OnethingSchedulerToolCallLike): OnethingSchedulerRunToolCall {
  return {
    id: toolCall.id,
    toolName: toolCall.toolName,
    status: toolCall.status,
    ...(typeof toolCall.startTime === 'number' ? { startedAt: toolCall.startTime } : {}),
    ...(typeof toolCall.endTime === 'number' ? { finishedAt: toolCall.endTime } : {}),
    ...(typeof toolCall.startTime === 'number' && typeof toolCall.endTime === 'number'
      ? { durationMs: Math.max(0, toolCall.endTime - toolCall.startTime) }
      : {}),
    argumentsPreview: previewOnethingSchedulerRunValue(toolCall.arguments, 500),
    ...(toolCall.result !== undefined ? { resultPreview: previewOnethingSchedulerRunValue(toolCall.result, 500) } : {}),
    ...(toolCall.error ? { error: toolCall.error } : {}),
  }
}

export function finishOnethingSchedulerRunDetail<TDetail extends OnethingSchedulerRunDetail>(
  detail: TDetail,
  options?: OnethingSchedulerRunDetailOptions,
): TDetail {
  const finishedAt = detail.finishedAt || nowMs(options)
  return {
    ...detail,
    finishedAt,
    durationMs: Math.max(0, finishedAt - detail.startedAt),
  }
}

export function createOnethingSchedulerRunDetailFromRecord(
  record: OnethingSchedulerRunDetailRecordLike,
  options?: OnethingSchedulerRunDetailOptions,
): OnethingSchedulerRunDetail {
  const result = record.result as { report?: unknown; memory?: unknown; timeline?: OnethingSchedulerRunTimelineEntry[] } | undefined
  const resultPreview = typeof result?.report === 'string'
    ? result.report
    : typeof result?.memory === 'string'
      ? result.memory
      : record.result === undefined
        ? undefined
        : previewOnethingSchedulerRunValue(record.result, 1000)

  return {
    ...record,
    status: record.skipped
      ? 'skipped'
      : record.ok
        ? 'succeeded'
        : 'failed',
    resultPreview,
    timeline: Array.isArray(result?.timeline) && result.timeline.length > 0 ? result.timeline : [
      createOnethingSchedulerTimelineEntry({
        type: 'run:finish',
        title: record.ok ? 'Run completed' : 'Run failed',
        detail: record.error || record.skippedReason,
        timestamp: record.finishedAt,
        durationMs: record.durationMs,
      }, options),
    ],
  }
}

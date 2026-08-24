/**
 * MCP Tasks (P3-1): full client-side support for server-returned task handles.
 *
 * Era reality (from the v2 SDK): task vocabulary (`tasks/get`, `tasks/result`,
 * `tasks/cancel`, `tasks/list`, `notifications/tasks/status`) is **2025-11-25
 * wire** — the 2026-07-28 revision deleted it (`capabilities.tasks` /
 * `execution.taskSupport` are in the 2026 codec's known deleted-field set,
 * and the SDK raises `MethodNotSupportedByProtocolVersion` locally when task
 * methods are sent to a 2026-era peer). The v2 SDK keeps the wire schemas
 * importable but offers NO runtime: polling is ours to implement — exactly
 * the adapters seam (core stays SDK-free; the two SDK call sites implement
 * the three task methods via the schema overload of `client.request()`).
 *
 * Lifecycle: a tools/call answer carrying a `task` handle (P2-4 detects the
 * shape) is accepted-NOT-finished. When the server advertises
 * `capabilities.tasks.requests.tools.call`, we poll `tasks/get` until a
 * terminal status, then fetch the real payload with `tasks/result`. The
 * initial tools/call keeps its normal timeout; the poll phase gets its own
 * generous budget and a best-effort `tasks/cancel` on abort/timeout — long
 * tasks are no longer bound by the 60s tool-call ceiling.
 */

import type { JsonObject } from '../json.js'

/** 2025-11-25 wire vocabulary (mirrored — core never imports the SDK). */
export type CoreMCPTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'

export interface CoreMCPTask {
  taskId: string
  status: CoreMCPTaskStatus
  ttl?: number | null
  createdAt?: string
  lastUpdatedAt?: string
  /** Server-suggested poll interval in ms — honored when present. */
  pollInterval?: number
  statusMessage?: string
}

export function mcpTaskIsTerminal(status: CoreMCPTaskStatus | string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/**
 * Does the server let tools/call run as tasks? Spec shape:
 * `capabilities.tasks.requests.tools.call` (a loose object whose PRESENCE
 * signals support). Legacy-era only — a 2026-era server never advertises it.
 */
export function mcpServerSupportsToolTasks(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false
  const tasks = (capabilities as { tasks?: unknown }).tasks
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return false
  const requests = (tasks as { requests?: unknown }).requests
  if (!requests || typeof requests !== 'object' || Array.isArray(requests)) return false
  const tools = (requests as { tools?: unknown }).tools
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) return false
  return (tools as { call?: unknown }).call !== undefined
}

export interface CoreMCPTaskHandle {
  taskId: string
  status?: string
  statusMessage?: string
}

/**
 * Extract an uninvited task handle from a raw tools/call result — the same
 * two carriers P2-4 defends against: a `task` object on the result, or the
 * `io.modelcontextprotocol/related-task` marker in `_meta`.
 */
export function mcpTaskHandleFromResult(record: Record<string, unknown>): CoreMCPTaskHandle | undefined {
  const task = record.task
  const taskFromResult = task && typeof task === 'object' && !Array.isArray(task)
    ? (task as { taskId?: unknown; status?: unknown; statusMessage?: unknown })
    : undefined
  const meta = record._meta
  const relatedTask = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)['io.modelcontextprotocol/related-task']
    : undefined
  const relatedTaskId = relatedTask && typeof relatedTask === 'object' && !Array.isArray(relatedTask)
    ? (relatedTask as { taskId?: unknown }).taskId
    : undefined

  const taskId = typeof taskFromResult?.taskId === 'string'
    ? taskFromResult.taskId
    : typeof relatedTaskId === 'string'
      ? relatedTaskId
      : undefined
  if (!taskId) return undefined
  return {
    taskId,
    status: typeof taskFromResult?.status === 'string' ? taskFromResult.status : undefined,
    statusMessage: typeof taskFromResult?.statusMessage === 'string' ? taskFromResult.statusMessage : undefined,
  }
}

export type CoreMCPTaskPollOutcome =
  | { kind: 'completed'; task: CoreMCPTask; payload: unknown; polls: number; elapsedMs: number }
  | { kind: 'failed'; task: CoreMCPTask; polls: number; elapsedMs: number }
  | { kind: 'cancelled'; task: CoreMCPTask; polls: number; elapsedMs: number }
  | { kind: 'timeout'; task: CoreMCPTask; polls: number; elapsedMs: number }
  | { kind: 'aborted'; task: CoreMCPTask; polls: number; elapsedMs: number }

export const MCP_TASK_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
export const MCP_TASK_DEFAULT_INTERVAL_MS = 1000
const MCP_TASK_MIN_INTERVAL_MS = 250
const MCP_TASK_MAX_INTERVAL_MS = 10_000

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return MCP_TASK_DEFAULT_INTERVAL_MS
  return Math.min(Math.max(ms, MCP_TASK_MIN_INTERVAL_MS), MCP_TASK_MAX_INTERVAL_MS)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

/**
 * Poll `tasks/get` until the task reaches a terminal status, the budget
 * expires, or the caller aborts (the last two trigger a best-effort
 * `tasks/cancel`). `input_required` keeps polling — elicitation is a
 * separate surface; the status flows through `onStatus` so the host can
 * show it, and the eventual terminal state still arrives here.
 */
export async function pollMCPTaskWithAdapters(
  initialTask: CoreMCPTask,
  adapters: {
    /** `tasks/get` — read the current task state. */
    getTask(taskId: string): Promise<CoreMCPTask>
    /** `tasks/result` — fetch the payload of a COMPLETED task. */
    getTaskPayload(taskId: string): Promise<unknown>
    /** `tasks/cancel` — best-effort only; failures are swallowed. */
    cancelTask(taskId: string): Promise<unknown>
  },
  options: {
    /** Overall poll budget. Default 10 min — long tasks escape the 60s ceiling. */
    timeoutMs?: number
    /** Fallback interval when the task carries no pollInterval hint. Default 1s. */
    defaultIntervalMs?: number
    signal?: AbortSignal
    onStatus?: (task: CoreMCPTask, pollIndex: number) => void
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<CoreMCPTaskPollOutcome> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const timeoutMs = options.timeoutMs ?? MCP_TASK_DEFAULT_TIMEOUT_MS
  const startedAt = now()
  const deadline = startedAt + timeoutMs

  let task = initialTask
  let polls = 0

  const cancelQuietly = async () => {
    try { await adapters.cancelTask(task.taskId) } catch { /* best-effort */ }
  }

  while (!mcpTaskIsTerminal(task.status)) {
    if (options.signal?.aborted) {
      await cancelQuietly()
      return { kind: 'aborted', task, polls, elapsedMs: now() - startedAt }
    }
    const remaining = deadline - now()
    if (remaining <= 0) {
      await cancelQuietly()
      return { kind: 'timeout', task, polls, elapsedMs: now() - startedAt }
    }
    const interval = clampInterval(task.pollInterval ?? options.defaultIntervalMs ?? MCP_TASK_DEFAULT_INTERVAL_MS)
    await sleep(Math.min(interval, remaining))
    polls += 1
    task = await adapters.getTask(task.taskId)
    options.onStatus?.(task, polls)
  }

  const elapsedMs = now() - startedAt
  if (task.status === 'completed') {
    const payload = await adapters.getTaskPayload(task.taskId)
    return { kind: 'completed', task, payload, polls, elapsedMs }
  }
  return task.status === 'failed'
    ? { kind: 'failed', task, polls, elapsedMs }
    : { kind: 'cancelled', task, polls, elapsedMs }
}

/** Human-readable provenance line prepended to the final tool result. */
export function mcpTaskProvenanceText(outcome: CoreMCPTaskPollOutcome): string {
  const seconds = (outcome.elapsedMs / 1000).toFixed(1)
  if (outcome.kind === 'completed') {
    return `[MCP task "${outcome.task.taskId}" completed after ${seconds}s (${outcome.polls} polls)]`
  }
  const detail = outcome.task.statusMessage ? ` — ${outcome.task.statusMessage}` : ''
  if (outcome.kind === 'failed') {
    return `[MCP task "${outcome.task.taskId}" FAILED after ${seconds}s${detail}]`
  }
  if (outcome.kind === 'cancelled') {
    return `[MCP task "${outcome.task.taskId}" was cancelled by the server${detail}]`
  }
  if (outcome.kind === 'timeout') {
    return `[MCP task "${outcome.task.taskId}" did not finish within the poll budget (${seconds}s); a cancel was requested]`
  }
  return `[MCP task "${outcome.task.taskId}" was aborted locally; a cancel was requested]`
}

/** Loose structural parse of a wire Task (the SDK validates on its side). */
export function mcpTaskFromWire(value: unknown): CoreMCPTask | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as JsonObject
  return typeof record.taskId === 'string' && typeof record.status === 'string'
    ? (record as unknown as CoreMCPTask)
    : undefined
}

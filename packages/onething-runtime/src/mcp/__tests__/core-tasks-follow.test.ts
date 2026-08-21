import { describe, expect, it } from 'vitest'
import { callMCPToolWithTimeout } from '@onething/core/mcp'
import type { CoreMCPTask } from '@onething/core/mcp'

/**
 * P3-1: callMCPToolWithTimeout follows a task handle (polls tasks/get, then
 * fetches tasks/result) when the client supports tasks — and preserves the
 * P2-4 notice behavior when it does not.
 */

const task = (status: CoreMCPTask['status'], overrides: Partial<CoreMCPTask> = {}): CoreMCPTask => ({
  taskId: 'task-9',
  status,
  ...overrides,
})

function fakeTaskClient(opts: {
  handle: Record<string, unknown>
  statuses: CoreMCPTask['status'][]
  payload?: unknown
  supports?: boolean
}) {
  const calls = { getTask: 0, getPayload: 0, cancel: 0 }
  const statuses = [...opts.statuses]
  return {
    calls,
    client: {
      async callTool() {
        return {
          content: [{ type: 'text', text: 'accepted' }],
          task: opts.handle,
        }
      },
      supportsMCPTasks: () => opts.supports ?? true,
      async getMCPTask(taskId: string): Promise<CoreMCPTask> {
        calls.getTask += 1
        return task(statuses.shift() ?? 'completed', { taskId })
      },
      async getMCPTaskPayload() {
        calls.getPayload += 1
        return opts.payload ?? { content: [{ type: 'text', text: 'real result' }] }
      },
      async cancelMCPTask() {
        calls.cancel += 1
        return {}
      },
    },
  }
}

describe('callMCPToolWithTimeout task following (P3-1)', () => {
  it('polls the task and returns the real payload with provenance', async () => {
    const { client, calls } = fakeTaskClient({
      handle: { taskId: 'task-9', status: 'working' },
      statuses: ['working', 'completed'],
      payload: {
        content: [{ type: 'text', text: 'real result' }],
        structuredContent: { rows: 3 },
      },
    })
    const result = await callMCPToolWithTimeout(
      client, 'slow-op', {}, 1000, undefined, { taskIntervalMs: 250 },
    )
    expect(result.success).toBe(true)
    expect(result.isError).toBe(false)
    expect(result.content?.[0]?.text).toContain('MCP task "task-9" completed after')
    expect(result.content?.[1]?.text).toBe('real result')
    expect(result.structuredContent).toEqual({ rows: 3 })
    expect(calls.getTask).toBe(2)
    expect(calls.getPayload).toBe(1)
    expect(calls.cancel).toBe(0)
  })

  it('a failed task surfaces as an isError result, not a call failure', async () => {
    const { client, calls } = fakeTaskClient({
      handle: { taskId: 'task-9', status: 'working' },
      statuses: ['failed'],
    })
    const result = await callMCPToolWithTimeout(
      client, 'slow-op', {}, 1000, undefined, { taskIntervalMs: 250 },
    )
    expect(result.success).toBe(true)
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('FAILED')
    expect(calls.getPayload).toBe(0)
  })

  it('a payload-level isError is preserved alongside the provenance', async () => {
    const { client } = fakeTaskClient({
      handle: { taskId: 'task-9', status: 'working' },
      statuses: ['completed'],
      payload: { content: [{ type: 'text', text: 'tool exploded' }], isError: true },
    })
    const result = await callMCPToolWithTimeout(
      client, 'slow-op', {}, 1000, undefined, { taskIntervalMs: 250 },
    )
    expect(result.success).toBe(true)
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('completed after')
    expect(result.content?.[1]?.text).toBe('tool exploded')
  })

  it('falls back to the P2-4 notice when the server does not support tasks', async () => {
    const { client, calls } = fakeTaskClient({
      handle: { taskId: 'task-9', status: 'working' },
      statuses: ['completed'],
      supports: false,
    })
    const result = await callMCPToolWithTimeout(
      client, 'slow-op', {}, 1000, undefined, { taskIntervalMs: 250 },
    )
    expect(result.success).toBe(true)
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('task-9')
    expect(result.content?.[0]?.text).toContain('accepted-but-unresolved')
    expect(result.content?.[1]?.text).toBe('accepted')
    expect(calls.getTask).toBe(0)
    expect(calls.getPayload).toBe(0)
  })

  it('falls back to the P2-4 notice when the client has no task methods', async () => {
    const result = await callMCPToolWithTimeout({
      async callTool() {
        return {
          content: [{ type: 'text', text: 'accepted' }],
          task: { taskId: 'task-9', status: 'working' },
        }
      },
      // supportsMCPTasks claims support, but the three methods are missing.
      supportsMCPTasks: () => true,
    }, 'slow-op', {}, 1000)
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('accepted-but-unresolved')
  })

  it('an already-terminal handle is resolved without polling', async () => {
    const { client, calls } = fakeTaskClient({
      handle: { taskId: 'task-9', status: 'completed' },
      statuses: [],
    })
    const result = await callMCPToolWithTimeout(
      client, 'slow-op', {}, 1000, undefined, { taskIntervalMs: 250 },
    )
    expect(result.success).toBe(true)
    expect(result.content?.[0]?.text).toContain('completed after')
    expect(calls.getTask).toBe(0)
    expect(calls.getPayload).toBe(1)
  })
})

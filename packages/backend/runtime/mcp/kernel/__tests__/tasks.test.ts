import { describe, expect, it } from 'vitest'
import {
  mcpServerSupportsToolTasks,
  mcpTaskFromWire,
  mcpTaskHandleFromResult,
  mcpTaskIsTerminal,
  mcpTaskProvenanceText,
  pollMCPTaskWithAdapters,
  type CoreMCPTask,
  type CoreMCPTaskStatus,
} from '../tasks.js'

const workingTask = (overrides: Partial<CoreMCPTask> = {}): CoreMCPTask => ({
  taskId: 'task-1',
  status: 'working',
  ...overrides,
})

describe('mcpTaskIsTerminal', () => {
  it('classifies statuses', () => {
    expect(mcpTaskIsTerminal('completed')).toBe(true)
    expect(mcpTaskIsTerminal('failed')).toBe(true)
    expect(mcpTaskIsTerminal('cancelled')).toBe(true)
    expect(mcpTaskIsTerminal('working')).toBe(false)
    expect(mcpTaskIsTerminal('input_required')).toBe(false)
    expect(mcpTaskIsTerminal('whatever')).toBe(false)
  })
})

describe('mcpServerSupportsToolTasks', () => {
  it('requires capabilities.tasks.requests.tools.call to be present', () => {
    expect(mcpServerSupportsToolTasks({ tasks: { requests: { tools: { call: {} } } } })).toBe(true)
    expect(mcpServerSupportsToolTasks({ tasks: { requests: { tools: { call: {}, list: {} } } } })).toBe(true)
    expect(mcpServerSupportsToolTasks({ tasks: { requests: { tools: {} } } })).toBe(false)
    expect(mcpServerSupportsToolTasks({ tasks: { requests: {} } })).toBe(false)
    expect(mcpServerSupportsToolTasks({ tasks: {} })).toBe(false)
    expect(mcpServerSupportsToolTasks({})).toBe(false)
    expect(mcpServerSupportsToolTasks(undefined)).toBe(false)
    expect(mcpServerSupportsToolTasks('tasks')).toBe(false)
    expect(mcpServerSupportsToolTasks({ tasks: ['call'] })).toBe(false)
  })
})

describe('mcpTaskHandleFromResult', () => {
  it('extracts the handle from a task object on the result', () => {
    expect(mcpTaskHandleFromResult({
      task: { taskId: 't-1', status: 'working', statusMessage: 'grinding' },
    })).toEqual({ taskId: 't-1', status: 'working', statusMessage: 'grinding' })
  })

  it('extracts the handle from the _meta related-task marker', () => {
    expect(mcpTaskHandleFromResult({
      _meta: { 'io.modelcontextprotocol/related-task': { taskId: 't-2' } },
    })).toEqual({ taskId: 't-2', status: undefined, statusMessage: undefined })
  })

  it('prefers the result task object and ignores malformed carriers', () => {
    expect(mcpTaskHandleFromResult({
      task: { taskId: 't-3' },
      _meta: { 'io.modelcontextprotocol/related-task': { taskId: 't-other' } },
    })?.taskId).toBe('t-3')
    expect(mcpTaskHandleFromResult({ task: { status: 'working' } })).toBeUndefined()
    expect(mcpTaskHandleFromResult({ task: 't-4' })).toBeUndefined()
    expect(mcpTaskHandleFromResult({})).toBeUndefined()
    expect(mcpTaskHandleFromResult({ content: [] })).toBeUndefined()
  })
})

describe('mcpTaskFromWire', () => {
  it('accepts only objects with taskId + status', () => {
    expect(mcpTaskFromWire({ taskId: 't', status: 'working' })?.taskId).toBe('t')
    expect(mcpTaskFromWire({ taskId: 't' })).toBeUndefined()
    expect(mcpTaskFromWire({ status: 'working' })).toBeUndefined()
    expect(mcpTaskFromWire(null)).toBeUndefined()
    expect(mcpTaskFromWire(['t', 'working'])).toBeUndefined()
  })
})

describe('pollMCPTaskWithAdapters', () => {
  /** Deterministic clock: every sleep advances it by the slept amount. */
  const harness = (statuses: CoreMCPTaskStatus[], opts: {
    payload?: unknown
    pollInterval?: number
    timeoutMs?: number
    intervalMs?: number
    abortBeforeStart?: boolean
  } = {}) => {
    let now = 0
    const sleeps: number[] = []
    const statusesQueue = [...statuses]
    const cancelled: string[] = []
    const statusEvents: Array<[string, number]> = []
    let payloadFetches = 0
    const controller = new AbortController()
    if (opts.abortBeforeStart) controller.abort()

    const outcome = pollMCPTaskWithAdapters(
      workingTask(opts.pollInterval !== undefined ? { pollInterval: opts.pollInterval } : {}),
      {
        getTask: async (taskId) => {
          const status = statusesQueue.shift() ?? 'working'
          return workingTask({ taskId, status, ...(opts.pollInterval !== undefined ? { pollInterval: opts.pollInterval } : {}) })
        },
        getTaskPayload: async () => {
          payloadFetches += 1
          return opts.payload ?? { content: [{ type: 'text', text: 'real result' }] }
        },
        cancelTask: async (taskId) => { cancelled.push(taskId) },
      },
      {
        now: () => now,
        sleep: async (ms) => { sleeps.push(ms); now += ms },
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.intervalMs !== undefined ? { defaultIntervalMs: opts.intervalMs } : {}),
        signal: controller.signal,
        onStatus: (task, pollIndex) => { statusEvents.push([task.status, pollIndex]) },
      },
    )
    return { outcome, sleeps, cancelled, statusEvents, getPayloadFetches: () => payloadFetches }
  }

  it('polls to completed, then fetches the payload once', async () => {
    const h = harness(['working', 'working', 'completed'])
    const outcome = await h.outcome
    expect(outcome.kind).toBe('completed')
    expect(outcome.polls).toBe(3)
    expect(h.getPayloadFetches()).toBe(1)
    if (outcome.kind === 'completed') {
      expect((outcome.payload as { content: Array<{ text: string }> }).content[0]!.text).toBe('real result')
    }
    expect(h.statusEvents).toEqual([['working', 1], ['working', 2], ['completed', 3]])
    expect(h.cancelled).toEqual([])
  })

  it('failed is terminal and never fetches the payload', async () => {
    const h = harness(['working', 'failed'])
    const outcome = await h.outcome
    expect(outcome.kind).toBe('failed')
    expect(h.getPayloadFetches()).toBe(0)
    expect(h.cancelled).toEqual([])
  })

  it('cancelled is terminal and never fetches the payload', async () => {
    const h = harness(['cancelled'])
    expect((await h.outcome).kind).toBe('cancelled')
    expect(h.getPayloadFetches()).toBe(0)
  })

  it('input_required keeps polling until a terminal state arrives', async () => {
    const h = harness(['input_required', 'working', 'completed'])
    const outcome = await h.outcome
    expect(outcome.kind).toBe('completed')
    expect(outcome.polls).toBe(3)
  })

  it('an initially-terminal handle skips polling entirely', async () => {
    const h = harness([])
    const outcome = await pollMCPTaskWithAdapters(
      workingTask({ status: 'completed' }),
      {
        getTask: async () => { throw new Error('should not be called') },
        getTaskPayload: async () => ({ ok: true }),
        cancelTask: async () => { throw new Error('should not be called') },
      },
      { now: () => 0, sleep: async () => { throw new Error('should not sleep') } },
    )
    expect(outcome.kind).toBe('completed')
    expect(outcome.polls).toBe(0)
    void h
  })

  it('timeout cancels best-effort and reports the elapsed budget', async () => {
    const h = harness(['working', 'working', 'working', 'working'], { timeoutMs: 2500 })
    const outcome = await h.outcome
    expect(outcome.kind).toBe('timeout')
    expect(h.cancelled).toEqual(['task-1'])
    expect(h.getPayloadFetches()).toBe(0)
  })

  it('abort cancels best-effort', async () => {
    const h = harness(['working'], { abortBeforeStart: true })
    const outcome = await h.outcome
    expect(outcome.kind).toBe('aborted')
    expect(h.cancelled).toEqual(['task-1'])
  })

  it('a failing tasks/cancel does not mask the timeout outcome', async () => {
    let now = 0
    const outcome = await pollMCPTaskWithAdapters(
      workingTask(),
      {
        getTask: async () => workingTask(),
        getTaskPayload: async () => ({}),
        cancelTask: async () => { throw new Error('cancel unsupported') },
      },
      { now: () => now, sleep: async (ms) => { now += ms }, timeoutMs: 500 },
    )
    expect(outcome.kind).toBe('timeout')
  })

  it('honors the server pollInterval hint and clamps it to sane bounds', async () => {
    const hinted = harness(['working', 'completed'], { pollInterval: 4000 })
    await hinted.outcome
    expect(hinted.sleeps[0]).toBe(4000)

    const tooSmall = harness(['working', 'completed'], { pollInterval: 5 })
    await tooSmall.outcome
    expect(tooSmall.sleeps[0]).toBe(250)

    const tooLarge = harness(['working', 'completed'], { pollInterval: 60_000 })
    await tooLarge.outcome
    expect(tooLarge.sleeps[0]).toBe(10_000)

    const fallback = harness(['working', 'completed'], { intervalMs: 750 })
    await fallback.outcome
    expect(fallback.sleeps[0]).toBe(750)
  })
})

describe('mcpTaskProvenanceText', () => {
  const base = { task: workingTask({ status: 'completed' }), polls: 4, elapsedMs: 4100 }
  it('renders per-outcome lines', () => {
    expect(mcpTaskProvenanceText({ ...base, kind: 'completed', payload: {} }))
      .toContain('completed after 4.1s (4 polls)')
    expect(mcpTaskProvenanceText({ ...base, kind: 'failed', task: workingTask({ status: 'failed', statusMessage: 'boom' }) }))
      .toContain('FAILED after 4.1s — boom')
    expect(mcpTaskProvenanceText({ ...base, kind: 'cancelled', task: workingTask({ status: 'cancelled' }) }))
      .toContain('cancelled by the server')
    expect(mcpTaskProvenanceText({ ...base, kind: 'timeout' })).toContain('did not finish within the poll budget')
    expect(mcpTaskProvenanceText({ ...base, kind: 'aborted' })).toContain('aborted locally')
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../scheduler.js'

let tempDir: string
let now: number
let runIdCounter: number
const schedulers: Scheduler[] = []

function createScheduler(): Scheduler {
  const scheduler = new Scheduler({
    stateFilePath: path.join(tempDir, 'scheduler-state.json'),
    createRunId: () => `run-${++runIdCounter}`,
    now: () => now,
    logger: { error: vi.fn() },
  })
  schedulers.push(scheduler)
  return scheduler
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-runtime-scheduler-test-'))
  now = Date.parse('2026-06-27T00:00:00.000Z')
  runIdCounter = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const scheduler of schedulers.splice(0)) {
    scheduler.dispose()
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('Scheduler', () => {
  it('runs tasks and persists scheduler state through an injected state file path', async () => {
    const run = vi.fn(() => ({ ok: true }))
    const scheduler = createScheduler()

    scheduler.register({
      id: 'task-1',
      name: 'Daily task',
      schedule: { kind: 'interval', everyMs: 5_000 },
      run,
    })

    expect(scheduler.getStatus('task-1')).toMatchObject({
      enabled: true,
      nextRunAt: now + 5_000,
    })

    now += 2_000
    const record = await scheduler.runNow('task-1')

    expect(record).toMatchObject({
      runId: 'run-1',
      taskId: 'task-1',
      scheduledFor: now,
      startedAt: now,
      finishedAt: now,
      ok: true,
      result: { ok: true },
    })
    expect(run).toHaveBeenCalledTimes(1)

    const snapshot = scheduler.getStatus('task-1')
    expect(snapshot).toMatchObject({
      runCount: 1,
      successCount: 1,
      failureCount: 0,
      nextRunAt: now + 5_000,
    })
    expect(snapshot?.recentRuns?.[0]).toMatchObject({ runId: 'run-1', ok: true })

    scheduler.dispose()
    const reloaded = createScheduler()
    reloaded.register({
      id: 'task-1',
      name: 'Daily task',
      schedule: { kind: 'interval', everyMs: 5_000 },
      run: vi.fn(),
    })

    expect(reloaded.getStatus('task-1')).toMatchObject({
      runCount: 1,
      successCount: 1,
      nextRunAt: now + 5_000,
    })
    expect(reloaded.getStatus('task-1')?.recentRuns?.[0]).toMatchObject({ runId: 'run-1' })
  })

  it('persists user enablement separately from the registered task definition', () => {
    const scheduler = createScheduler()
    scheduler.register({
      id: 'task-2',
      enabled: true,
      schedule: { kind: 'interval', everyMs: 60_000 },
      run: vi.fn(),
    })

    expect(scheduler.setEnabled('task-2', false)).toMatchObject({
      enabled: false,
      userEnabled: false,
    })

    scheduler.dispose()
    const reloaded = createScheduler()
    reloaded.register({
      id: 'task-2',
      enabled: true,
      schedule: { kind: 'interval', everyMs: 60_000 },
      run: vi.fn(),
    })

    expect(reloaded.getStatus('task-2')).toMatchObject({
      enabled: false,
      userEnabled: false,
    })
  })

  it('keeps invalid schedules as disabled snapshots with an error', () => {
    const scheduler = createScheduler()

    scheduler.register({
      id: 'bad-cron',
      schedule: { kind: 'cron', expr: '0 3 * *' },
      run: vi.fn(),
    })

    expect(scheduler.getStatus('bad-cron')).toMatchObject({
      enabled: false,
      lastError: expect.stringMatching(/5-field/),
    })
  })

  it('lists task snapshots without writing scheduler state for every task', () => {
    const scheduler = createScheduler()

    scheduler.register({
      id: 'task-a',
      schedule: { kind: 'interval', everyMs: 60_000 },
      run: vi.fn(),
    })
    scheduler.register({
      id: 'task-b',
      schedule: { kind: 'interval', everyMs: 120_000 },
      run: vi.fn(),
    })

    const writeSpy = vi.spyOn(fs, 'writeFileSync')
    writeSpy.mockClear()

    expect(scheduler.list().map(task => task.id)).toEqual(['task-a', 'task-b'])
    expect(writeSpy).not.toHaveBeenCalled()

    writeSpy.mockRestore()
  })
})

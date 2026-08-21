import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getOnethingSchedulerTasksPath,
} from '@onething/runtime/storage'
import { getScheduler } from '@onething/runtime/scheduler/scheduler-bound'
import {
  createUserSchedulerTask,
  deleteUserSchedulerTask,
  updateUserSchedulerTask,
} from '../user-tasks.js'
import {
  getSchedulerRunDetail,
  listSchedulerRunDetails,
  saveSchedulerRunDetail,
} from '@onething/runtime/scheduler/run-history-bound.wiring'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}))

let previousHome: string | undefined
let tempHome: string

beforeEach(() => {
  previousHome = process.env.HOME
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-scheduler-test-'))
  process.env.HOME = tempHome
})

afterEach(() => {
  process.env.HOME = previousHome
  fs.rmSync(tempHome, { recursive: true, force: true })
})

describe('user scheduler tasks', () => {
  it('creates, updates, registers, and deletes agent tasks', () => {
    const created = createUserSchedulerTask({
      name: 'Morning news',
      prompt: 'Check the news.',
      agentId: 'default',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * *' },
    })

    expect(created).toMatchObject({
      kind: 'agent',
      source: 'user',
      readonly: false,
      agentId: 'default',
      promptPreview: 'Check the news.',
    })
    expect(getScheduler().getStatus(created.id)?.name).toBe('Morning news')

    const updated = updateUserSchedulerTask({
      id: created.id,
      name: 'Daily news',
      enabled: false,
      schedule: { kind: 'interval', everyMs: 120000 },
    })

    expect(updated.name).toBe('Daily news')
    expect(updated.enabled).toBe(false)
    expect(JSON.parse(fs.readFileSync(getOnethingSchedulerTasksPath(), 'utf-8')).tasks[0]).toMatchObject({
      id: created.id,
      name: 'Daily news',
      enabled: false,
    })

    deleteUserSchedulerTask(created.id)
    expect(getScheduler().getStatus(created.id)).toBeUndefined()
  })

  it('persists run history by task id', () => {
    saveSchedulerRunDetail({
      runId: 'run-1',
      taskId: 'user:task-1',
      reason: 'manual',
      scheduledFor: 10,
      startedAt: 10,
      finishedAt: 20,
      durationMs: 10,
      ok: true,
      status: 'succeeded',
      resultPreview: 'Done',
      timeline: [{ id: 'entry-1', timestamp: 20, type: 'run:finish', title: 'Done' }],
    })

    expect(listSchedulerRunDetails('user:task-1')).toHaveLength(1)
    expect(getSchedulerRunDetail('user:task-1', 'run-1')?.resultPreview).toBe('Done')
  })
})

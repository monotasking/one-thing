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
  initializeUserSchedulerTasks,
  stopUserSchedulerTasks,
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
  /**
   * A3(`docs/design/backend-composition-root-2026-09.md` §2.4)。
   *
   * 从前 `initializeUserSchedulerTasks` 是关机清单上**唯一按设计就没有 stop 口**
   * 的一件:每只 handle 背后是 `Scheduler` 的 setTimeout 链,而那条链只有在任务
   * 表空了之后才断。现在它返回 disposer,两个 GUI 宿主起完就 `backend.own(...)`。
   *
   * 三条判据:摘干净(调度器里查不到了)、幂等(再调一次不抛)、闩放回去
   * (第二次 initialize 真的再读一次盘,而不是被闩挡住)。
   */
  it('A3:stopUserSchedulerTasks 摘掉自己注册的每一只,并把闩放回去', () => {
    const created = createUserSchedulerTask({
      name: 'Nightly digest',
      prompt: 'Summarise the day.',
      agentId: 'default',
      enabled: true,
      schedule: { kind: 'interval', everyMs: 60000 },
    })
    expect(getScheduler().getStatus(created.id)).toBeTruthy()

    const stop = initializeUserSchedulerTasks()
    stop()
    expect(getScheduler().getStatus(created.id)).toBeUndefined()
    // 幂等:关机路径上第二次调用(宿主 own + 手抄清单并存的过渡期)不许抛。
    expect(() => stop()).not.toThrow()

    // 闩放回去了 —— 第二份装配从盘上重新读一次,那只任务回到调度器里。
    initializeUserSchedulerTasks()
    expect(getScheduler().getStatus(created.id)?.name).toBe('Nightly digest')
    stopUserSchedulerTasks()
  })

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

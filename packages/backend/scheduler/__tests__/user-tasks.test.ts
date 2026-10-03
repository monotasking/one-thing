import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OnethingSchedulerUserTaskStore,
  normalizeOnethingSchedulerUserTaskSchedule,
  previewOnethingSchedulerPrompt,
} from '../user-tasks.js'

let tempDir: string
let now: number
let idCounter: number

function createStore(agentIds = new Set(['default', 'agent-1'])): OnethingSchedulerUserTaskStore {
  return new OnethingSchedulerUserTaskStore({
    tasksFilePath: path.join(tempDir, 'tasks.json'),
    defaultAgentId: 'default',
    agentExists: id => agentIds.has(id),
    createId: () => `id-${++idCounter}`,
    now: () => now,
    logger: { error: vi.fn() },
  })
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-runtime-user-tasks-test-'))
  now = Date.parse('2026-06-27T00:00:00.000Z')
  idCounter = 0
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('OnethingSchedulerUserTaskStore', () => {
  it('creates, updates, persists, and deletes user scheduler tasks', () => {
    const store = createStore()
    const created = store.create({
      name: ' Morning news ',
      prompt: ' Check the news. ',
      agentId: 'agent-1',
      enabled: true,
      schedule: { kind: 'interval', everyMs: 1_000 },
      workingDirectory: ' /tmp/work ',
    })

    expect(created).toMatchObject({
      id: 'user:id-1',
      name: 'Morning news',
      prompt: 'Check the news.',
      agentId: 'agent-1',
      enabled: true,
      schedule: { kind: 'interval', everyMs: 60_000 },
      workingDirectory: '/tmp/work',
      createdAt: now,
      updatedAt: now,
    })

    now += 1_000
    const updated = store.update({
      id: created.id,
      enabled: false,
      workingDirectory: null,
      schedule: { kind: 'cron', expr: ' 0 9 * * * ', timezone: ' Asia/Shanghai ' },
    })

    expect(updated).toMatchObject({
      id: created.id,
      enabled: false,
      schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'Asia/Shanghai' },
      updatedAt: now,
    })
    expect(updated.workingDirectory).toBeUndefined()
    expect(createStore().get(created.id)).toEqual(updated)

    store.delete(created.id)
    expect(store.get(created.id)).toBeUndefined()
  })

  it('rejects invalid task input with stable error messages', () => {
    const store = createStore()

    expect(() => store.create({
      name: '',
      prompt: 'Prompt',
      agentId: 'default',
      schedule: { kind: 'interval', everyMs: 60_000 },
    })).toThrow(/Task name is required/)
    expect(() => store.create({
      name: 'Task',
      prompt: 'Prompt',
      agentId: 'missing',
      schedule: { kind: 'interval', everyMs: 60_000 },
    })).toThrow(/Agent not found/)
    expect(() => normalizeOnethingSchedulerUserTaskSchedule({
      kind: 'cron',
      expr: '0 9 * * *',
      timezone: 'Not/AZone',
    })).toThrow(/Invalid timezone/)
  })

  it('loads stored tasks with defaults and skips malformed rows', () => {
    const filePath = path.join(tempDir, 'tasks.json')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'user:stored',
          name: ' Stored ',
          prompt: '  hello  ',
          enabled: true,
          schedule: { kind: 'interval', everyMs: 1 },
        },
        {
          id: 'bad',
          name: '',
          prompt: '',
          schedule: { kind: 'cron', expr: 'bad' },
        },
      ],
    }), 'utf-8')

    expect(createStore().list()).toEqual([
      {
        id: 'user:stored',
        name: 'Stored',
        prompt: 'hello',
        agentId: 'default',
        enabled: true,
        schedule: { kind: 'interval', everyMs: 60_000 },
        createdAt: now,
        updatedAt: now,
      },
    ])
  })

  it('builds compact prompt previews', () => {
    expect(previewOnethingSchedulerPrompt('hello\n  world')).toBe('hello world')
    expect(previewOnethingSchedulerPrompt('x'.repeat(200))).toHaveLength(180)
  })
})

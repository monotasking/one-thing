import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OnethingSchedulerRunHistory,
  getSchedulerRunHistoryPath,
  safeSchedulerRunTaskFileName,
} from '../run-history.js'

interface TestRunDetail {
  runId?: string
  taskId: string
  startedAt: number
  value: string
}

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-runtime-run-history-test-'))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('OnethingSchedulerRunHistory', () => {
  it('stores, deduplicates, sorts, and limits run details per task', () => {
    const history = new OnethingSchedulerRunHistory<TestRunDetail>({
      runsDir: tempDir,
      maxRunsPerTask: 3,
      logger: { error: vi.fn() },
    })

    history.save({ runId: 'run-1', taskId: 'task:unsafe/id', startedAt: 10, value: 'old' })
    history.save({ runId: 'run-2', taskId: 'task:unsafe/id', startedAt: 30, value: 'newest' })
    history.save({ runId: 'run-1', taskId: 'task:unsafe/id', startedAt: 20, value: 'updated' })
    history.save({ runId: 'run-3', taskId: 'task:unsafe/id', startedAt: 40, value: 'latest' })
    history.save({ runId: 'run-4', taskId: 'task:unsafe/id', startedAt: 50, value: 'kept' })

    expect(history.list('task:unsafe/id', 2)).toEqual([
      { runId: 'run-4', taskId: 'task:unsafe/id', startedAt: 50, value: 'kept' },
      { runId: 'run-3', taskId: 'task:unsafe/id', startedAt: 40, value: 'latest' },
    ])
    expect(history.get('task:unsafe/id', 'run-2')).toBeUndefined()
    expect(history.get('task:unsafe/id', 'run-1')).toEqual({
      runId: 'run-1',
      taskId: 'task:unsafe/id',
      startedAt: 20,
      value: 'updated',
    })

    const filePath = getSchedulerRunHistoryPath(tempDir, 'task:unsafe/id')
    expect(filePath).toBe(path.join(tempDir, 'task_unsafe_id.jsonl'))
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('requires a run id before saving', () => {
    const history = new OnethingSchedulerRunHistory<TestRunDetail>({ runsDir: tempDir })

    expect(() => history.save({ taskId: 'task-1', startedAt: 1, value: 'missing-id' })).toThrow(
      /run id is required/,
    )
  })

  it('normalizes task ids into safe jsonl file names', () => {
    expect(safeSchedulerRunTaskFileName('user:task/with spaces')).toBe('user_task_with_spaces.jsonl')
  })
})

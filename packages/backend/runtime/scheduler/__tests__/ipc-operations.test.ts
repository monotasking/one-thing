import { describe, expect, it, vi } from 'vitest'
import {
  createOnethingUserSchedulerTask,
  createOnethingUserSchedulerTaskForIpc,
  deleteOnethingUserSchedulerTask,
  getOnethingSchedulerRunForIpc,
  getOnethingSchedulerRun,
  getOnethingSchedulerTask,
  getOnethingSchedulerTaskForIpc,
  listOnethingSchedulerRuns,
  listOnethingSchedulerRunsForIpc,
  listOnethingSchedulerTasks,
  listOnethingSchedulerTasksForIpc,
  runOnethingSchedulerTaskNow,
  runOnethingSchedulerTaskNowForIpc,
  setOnethingSchedulerTaskEnabled,
  updateOnethingUserSchedulerTask,
} from '../ipc-operations.js'

interface Task {
  id: string
  enabled: boolean
  recentRuns?: RunRecord[]
}

interface RunRecord {
  runId?: string
  taskId: string
  result?: unknown
}

interface RunDetail {
  runId?: string
  taskId: string
  detail: true
}

function toRunDetail(record: RunRecord): RunDetail {
  return {
    runId: record.runId,
    taskId: record.taskId,
    detail: true,
  }
}

describe('scheduler IPC operations', () => {
  it('projects task list/get/create responses', async () => {
    const task: Task = { id: 'task-1', enabled: true }

    await expect(listOnethingSchedulerTasks({ listTasks: () => [task] })).resolves.toEqual({
      success: true,
      tasks: [task],
    })
    await expect(getOnethingSchedulerTask({
      id: 'task-1',
      getTaskStatus: () => task,
    })).resolves.toEqual({ success: true, task })
    await expect(getOnethingSchedulerTask({
      id: 'missing',
      getTaskStatus: () => undefined,
    })).resolves.toEqual({ success: false, error: 'Scheduled task not found: missing' })
    await expect(createOnethingUserSchedulerTask({
      request: { id: 'task-2' },
      createUserTask: request => ({ id: request.id, enabled: true }),
    })).resolves.toEqual({ success: true, task: { id: 'task-2', enabled: true } })
  })

  it('runs tasks with manual force defaults and saves plugin run details only', async () => {
    const record: RunRecord = { runId: 'run-1', taskId: 'plugin-task', result: { ok: true } }
    const runNow = vi.fn(async () => record)
    const saveRunDetail = vi.fn(detail => detail)

    await expect(runOnethingSchedulerTaskNow({
      id: 'plugin-task',
      runNow,
      isUserTask: () => false,
      toRunDetail,
      saveRunDetail,
    })).resolves.toEqual({ success: true, record })

    expect(runNow).toHaveBeenCalledWith('plugin-task', { reason: 'manual', force: true })
    expect(saveRunDetail).toHaveBeenCalledWith({ runId: 'run-1', taskId: 'plugin-task', detail: true })

    await runOnethingSchedulerTaskNow({
      id: 'user-task',
      force: false,
      runNow,
      isUserTask: () => true,
      toRunDetail,
      saveRunDetail,
    })

    expect(runNow).toHaveBeenLastCalledWith('user-task', { reason: 'manual', force: false })
    expect(saveRunDetail).toHaveBeenCalledTimes(1)
  })

  it('routes enabled/update/delete rules by user task ownership', async () => {
    const userTask: Task = { id: 'user-task', enabled: false }
    const pluginTask: Task = { id: 'plugin-task', enabled: true }
    const setUserTaskEnabled = vi.fn(() => userTask)
    const setSchedulerTaskEnabled = vi.fn(() => pluginTask)
    const updateUserTask = vi.fn(() => userTask)
    const deleteUserTask = vi.fn()

    await expect(setOnethingSchedulerTaskEnabled({
      id: 'user-task',
      enabled: false,
      isUserTask: id => id === 'user-task',
      setUserTaskEnabled,
      setSchedulerTaskEnabled,
    })).resolves.toEqual({ success: true, task: userTask })
    expect(setUserTaskEnabled).toHaveBeenCalledWith('user-task', false)

    await expect(setOnethingSchedulerTaskEnabled({
      id: 'plugin-task',
      enabled: true,
      isUserTask: id => id === 'user-task',
      setUserTaskEnabled,
      setSchedulerTaskEnabled,
    })).resolves.toEqual({ success: true, task: pluginTask })
    expect(setSchedulerTaskEnabled).toHaveBeenCalledWith('plugin-task', true)

    await expect(updateOnethingUserSchedulerTask({
      request: { id: 'plugin-task' },
      isUserTask: () => false,
      updateUserTask,
    })).resolves.toEqual({ success: false, error: 'Plugin scheduled tasks cannot be edited.' })
    await expect(deleteOnethingUserSchedulerTask({
      id: 'plugin-task',
      isUserTask: () => false,
      deleteUserTask,
    })).resolves.toEqual({ success: false, error: 'Plugin scheduled tasks cannot be deleted.' })

    await expect(updateOnethingUserSchedulerTask({
      request: { id: 'user-task' },
      isUserTask: () => true,
      updateUserTask,
    })).resolves.toEqual({ success: true, task: userTask })
    await expect(deleteOnethingUserSchedulerTask({
      id: 'user-task',
      isUserTask: () => true,
      deleteUserTask,
    })).resolves.toEqual({ success: true })
    expect(deleteUserTask).toHaveBeenCalledWith('user-task')
  })

  it('lists and reads saved run details before falling back to recent in-memory runs', async () => {
    const saved: RunDetail = { runId: 'saved-run', taskId: 'task-1', detail: true }
    const task: Task = {
      id: 'task-1',
      enabled: true,
      recentRuns: [
        { runId: 'recent-1', taskId: 'task-1' },
        { runId: 'recent-2', taskId: 'task-1' },
      ],
    }

    await expect(listOnethingSchedulerRuns({
      taskId: 'task-1',
      limit: 2,
      listSavedRuns: () => [saved],
      getTaskStatus: () => task,
      toRunDetail,
    })).resolves.toEqual({ success: true, runs: [saved] })

    await expect(listOnethingSchedulerRuns({
      taskId: 'task-1',
      limit: 1,
      listSavedRuns: () => [],
      getTaskStatus: () => task,
      toRunDetail,
    })).resolves.toEqual({
      success: true,
      runs: [{ runId: 'recent-1', taskId: 'task-1', detail: true }],
    })

    await expect(getOnethingSchedulerRun({
      taskId: 'task-1',
      runId: 'saved-run',
      getSavedRun: () => saved,
      getTaskStatus: () => task,
      toRunDetail,
    })).resolves.toEqual({ success: true, run: saved })

    await expect(getOnethingSchedulerRun({
      taskId: 'task-1',
      runId: 'recent-2',
      getSavedRun: () => undefined,
      getTaskStatus: () => task,
      toRunDetail,
    })).resolves.toEqual({
      success: true,
      run: { runId: 'recent-2', taskId: 'task-1', detail: true },
    })

    await expect(getOnethingSchedulerRun({
      taskId: 'task-1',
      runId: 'missing',
      getSavedRun: () => undefined,
      getTaskStatus: () => task,
      toRunDetail,
    })).resolves.toEqual({ success: false, error: 'Scheduled run not found: missing' })
  })

  it('normalizes adapter failures for IPC wrappers', async () => {
    const logger = { error: vi.fn() }

    await expect(listOnethingSchedulerTasksForIpc({
      listTasks: () => {
        throw new Error('list failed')
      },
      logger,
    })).resolves.toEqual({ success: false, error: 'list failed' })

    await expect(getOnethingSchedulerTaskForIpc({
      id: 'task-1',
      getTaskStatus: () => {
        throw new Error('get failed')
      },
      logger,
    })).resolves.toEqual({ success: false, error: 'get failed' })

    await expect(runOnethingSchedulerTaskNowForIpc({
      id: 'task-1',
      runNow: () => {
        throw new Error('run failed')
      },
      isUserTask: () => false,
      toRunDetail,
      saveRunDetail: detail => detail,
      logger,
    })).resolves.toEqual({ success: false, error: 'run failed' })

    await expect(createOnethingUserSchedulerTaskForIpc({
      request: { id: 'task-1' },
      createUserTask: () => {
        throw new Error('create failed')
      },
      logger,
    })).resolves.toEqual({ success: false, error: 'create failed' })

    await expect(listOnethingSchedulerRunsForIpc({
      taskId: 'task-1',
      listSavedRuns: () => {
        throw new Error('list runs failed')
      },
      getTaskStatus: () => undefined,
      toRunDetail,
      logger,
    })).resolves.toEqual({ success: false, error: 'list runs failed' })

    await expect(getOnethingSchedulerRunForIpc({
      taskId: 'task-1',
      runId: 'run-1',
      getSavedRun: () => {
        throw new Error('get run failed')
      },
      getTaskStatus: () => undefined,
      toRunDetail,
      logger,
    })).resolves.toEqual({ success: false, error: 'get run failed' })

    expect(logger.error).toHaveBeenCalledTimes(6)
  })
})

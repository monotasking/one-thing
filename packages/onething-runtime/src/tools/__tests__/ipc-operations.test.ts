import { describe, expect, it, vi } from 'vitest'
import {
  cancelOnethingToolForIpc,
  listOnethingBackgroundJobsForIpc,
  stopOnethingBackgroundJobForIpc,
} from '../ipc-operations.js'

describe('tools IPC operations', () => {
  it('normalizes cancel tool requests', async () => {
    // 工单 4 B1:取消今天仍然是空操作 —— 记一行日志、恒回 success。
    const log = vi.fn()

    await expect(cancelOnethingToolForIpc({
      toolCallId: 'tool-call-1',
      logger: { log },
    })).resolves.toEqual({ success: true })

    expect(log).toHaveBeenCalledWith('[Tools IPC] Cancel tool requested:', 'tool-call-1')
  })

  it('wraps background job list and stop operations', async () => {
    const listJobs = vi.fn(() => [{ id: 'job-1' }])
    const stopJob = vi.fn(() => true)

    await expect(listOnethingBackgroundJobsForIpc({ includeInactive: true, listJobs }))
      .resolves.toEqual({
        success: true,
        jobs: [{ id: 'job-1' }],
      })
    expect(listJobs).toHaveBeenCalledWith({ includeInactive: true })

    await expect(stopOnethingBackgroundJobForIpc({ jobId: 'job-1', stopJob }))
      .resolves.toEqual({ success: true })
    expect(stopJob).toHaveBeenCalledWith('job-1')
  })

  it('normalizes background job failures for IPC callers', async () => {
    await expect(listOnethingBackgroundJobsForIpc({
      listJobs: () => {
        throw new Error('list failed')
      },
    })).resolves.toEqual({
      success: false,
      error: 'list failed',
    })

    await expect(stopOnethingBackgroundJobForIpc({
      jobId: 'job-1',
      stopJob: () => {
        throw new Error('stop failed')
      },
    })).resolves.toEqual({
      success: false,
      error: 'stop failed',
    })
  })
})

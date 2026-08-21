import { describe, expect, it, vi } from 'vitest'
import { createScopedPluginScheduler } from '@onething/core/plugins'

interface TestTask {
  id: string
  run(context: Record<string, unknown>): unknown
}

interface TestSnapshot {
  id: string
  pluginId?: string
  enabled: boolean
}

describe('core scoped plugin scheduler', () => {
  it('scopes host task ids while exposing unscoped plugin ids', async () => {
    const disposeCallbacks: Array<() => void> = []
    const registeredTasks: TestTask[] = []
    const unregister = vi.fn()
    const runNow = vi.fn(async (options?: { reason?: string }) => ({
      ok: true,
      options,
    }))
    const scheduler = {
      register(task: TestTask & { pluginId: string }) {
        registeredTasks.push(task)
        return {
          id: task.id,
          unregister,
          refresh: () => ({ id: task.id, pluginId: task.pluginId, enabled: true }),
          getStatus: () => ({ id: task.id, pluginId: task.pluginId, enabled: true }),
          runNow,
          setEnabled: (enabled: boolean) => ({ id: task.id, pluginId: task.pluginId, enabled }),
        }
      },
      getStatus: vi.fn((id: string) => ({ id, pluginId: 'memory', enabled: true })),
      list: vi.fn(() => [
        { id: 'plugin:memory:dream', pluginId: 'memory', enabled: true },
        { id: 'plugin:other:dream', pluginId: 'other', enabled: true },
      ]),
      refresh: vi.fn((id: string) => ({ id, pluginId: 'memory', enabled: true })),
      runNow: vi.fn(async (id: string, options?: { reason?: string }) => ({ id, options })),
      setEnabled: vi.fn((id: string, enabled: boolean) => ({ id, pluginId: 'memory', enabled })),
    }

    const scoped = createScopedPluginScheduler<TestTask, TestSnapshot, { reason?: string }, unknown>({
      pluginId: 'memory',
      scheduler,
      disposeCallbacks,
    })
    const taskRun = vi.fn()
    const handle = scoped.register({ id: ' dream ', run: taskRun })

    expect(registeredTasks[0].id).toBe('plugin:memory:dream')
    expect((registeredTasks[0] as TestTask & { pluginId: string }).pluginId).toBe('memory')
    expect(handle.id).toBe('dream')
    expect(handle.getStatus()).toEqual({ id: 'dream', pluginId: 'memory', enabled: true })
    expect(handle.setEnabled(false)).toEqual({ id: 'dream', pluginId: 'memory', enabled: false })

    registeredTasks[0].run({ taskId: 'plugin:memory:dream', pluginId: 'memory', reason: 'manual' })
    expect(taskRun).toHaveBeenCalledWith({
      taskId: 'dream',
      pluginId: 'memory',
      reason: 'manual',
    })

    await handle.runNow({ reason: 'manual' })
    expect(runNow).toHaveBeenCalledWith({ reason: 'manual' })
    expect(scoped.getStatus('dream')).toEqual({ id: 'dream', pluginId: 'memory', enabled: true })
    expect(scoped.list()).toEqual([{ id: 'dream', pluginId: 'memory', enabled: true }])
    await expect(scoped.runNow('dream', { reason: 'manual' })).resolves.toEqual({
      id: 'plugin:memory:dream',
      options: { reason: 'manual' },
    })
    expect(scoped.setEnabled('dream', false)).toEqual({ id: 'dream', pluginId: 'memory', enabled: false })

    expect(disposeCallbacks).toHaveLength(1)
    disposeCallbacks[0]()
    expect(unregister).toHaveBeenCalled()
  })
})

/**
 * scheduler 域,端到端穿过 dispatcher(结构债 P4c)。
 *
 * 接的是被删掉的两处转发的测试位:`apps/electron/src/ipc/scheduler.ts` 那个手写
 * IPC 工厂(它的 `__tests__/scheduler.test.ts` 只证「九条通道各挂了一个 handle」,
 * 随工厂一起删)与 server 那九条 REST 路由。真正值得钉的是**搬家没搬丢形状** ——
 * 传输面只把端口接上去,判定与降级全在 `@onething/runtime/scheduler` 的
 * `*ForIpc` 投影里。所以这里逐条盯的是:
 *  - 九个方法全在 router 的白名单上(少一个 = 任务面板那一格静默失灵);
 *  - `runNow` / `listRuns` / `getRun` 的 `toRunDetail` 都先把 `record.result`
 *    过一遍 `toJsonValue` —— 漏掉它,运行结果里的非 JSON 值会原样落进运行详情;
 *  - `setEnabled` 靠 `isUserSchedulerTask` 分叉:用户任务改自己的账本,内置/插件
 *    任务只动调度器的开关位;
 *  - 投影本身抛错时回的是 `{ success:false, error }` 而**不是**让 dispatcher 变成
 *    `ok:false` —— 域的错误语义没变,渲染侧那套 `response.success` 判断照旧成立。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { schedulerRouter } from '@shared/ipc/scheduler.js'

const scheduler = vi.hoisted(() => ({
  list: vi.fn(),
  getStatus: vi.fn(),
  runNow: vi.fn(),
  setEnabled: vi.fn(),
}))

const userTasks = vi.hoisted(() => ({
  canAccessSchedulerTask: vi.fn(),
  createUserSchedulerTask: vi.fn(),
  deleteUserSchedulerTask: vi.fn(),
  isUserSchedulerTask: vi.fn(),
  setUserSchedulerTaskEnabled: vi.fn(),
  updateUserSchedulerTask: vi.fn(),
}))

const runHistory = vi.hoisted(() => ({
  getSchedulerRunDetail: vi.fn(),
  listSchedulerRunDetails: vi.fn(),
  saveSchedulerRunDetail: vi.fn(),
}))

vi.mock('@onething/runtime/scheduler/scheduler-bound', () => ({ getScheduler: () => scheduler }))
vi.mock('../../wiring/scheduler/user-tasks.js', () => userTasks)
vi.mock('@onething/runtime/scheduler/run-history-bound.wiring', () => runHistory)

const TASK = {
  id: 'user:task-1',
  name: 'Morning news',
  kind: 'agent',
  source: 'user',
  readonly: false,
  enabled: true,
  tags: ['agent'],
  inFlight: false,
  runCount: 1,
  successCount: 1,
  failureCount: 0,
}

async function loadDomain() {
  const [{ dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests }, { schedulerRpcHandlers }] =
    await Promise.all([import('../registry.js'), import('../domains/scheduler.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, schedulerRpcHandlers }
}

describe('scheduler RPC domain', () => {
  it('filters foreign tasks and refuses every task control and history read before side effects', async () => {
    userTasks.canAccessSchedulerTask.mockReturnValue(false)
    const { dispatchRpc } = await loadDomain()
    const context = { transport: 'http' as const, ownerUid: 'foreign', workspaceId: 'space' }
    const listed = await dispatchRpc({ domain: 'scheduler', method: 'list', payload: {} }, context)
    expect(listed).toEqual({ ok: true, data: { success: true, tasks: [] } })
    for (const method of ['get', 'runNow', 'setEnabled', 'updateTask', 'deleteTask', 'listRuns', 'getRun']) {
      const result = await dispatchRpc({ domain: 'scheduler', method, payload: { id: TASK.id, taskId: TASK.id, runId: 'run-1' } }, context)
      expect(result).toEqual({ ok: true, data: { success: false, error: 'Scheduled task not found' } })
    }
    expect(scheduler.runNow).not.toHaveBeenCalled()
    expect(userTasks.updateUserSchedulerTask).not.toHaveBeenCalled()
    expect(userTasks.deleteUserSchedulerTask).not.toHaveBeenCalled()
    expect(runHistory.listSchedulerRunDetails).not.toHaveBeenCalled()
    expect(runHistory.getSchedulerRunDetail).not.toHaveBeenCalled()
  })
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    userTasks.canAccessSchedulerTask.mockReset().mockReturnValue(true)
    scheduler.list.mockReset().mockReturnValue([TASK])
    scheduler.getStatus.mockReset().mockReturnValue(TASK)
    scheduler.runNow.mockReset().mockResolvedValue({ runId: 'run-1', taskId: 'user:task-1' })
    scheduler.setEnabled.mockReset().mockReturnValue({ ...TASK, enabled: false })
    userTasks.createUserSchedulerTask.mockReset().mockResolvedValue(TASK)
    userTasks.deleteUserSchedulerTask.mockReset().mockResolvedValue(undefined)
    userTasks.isUserSchedulerTask.mockReset().mockReturnValue(true)
    userTasks.setUserSchedulerTaskEnabled.mockReset().mockResolvedValue({ ...TASK, enabled: false })
    userTasks.updateUserSchedulerTask.mockReset().mockResolvedValue(TASK)
    runHistory.getSchedulerRunDetail.mockReset().mockResolvedValue({ runId: 'run-1' })
    runHistory.listSchedulerRunDetails.mockReset().mockResolvedValue([{ runId: 'run-1' }])
    runHistory.saveSchedulerRunDetail.mockReset().mockResolvedValue(undefined)

    const { resetRpcRegistryForTests, registerRouterHandlers, schedulerRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(schedulerRouter, schedulerRpcHandlers)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('binds all nine methods — an unlisted one never reaches a handler', async () => {
    const { dispatchRpc } = await loadDomain()
    const methods = [
      'list', 'get', 'runNow', 'setEnabled',
      'createTask', 'updateTask', 'deleteTask', 'listRuns', 'getRun',
    ]

    for (const method of methods) {
      const response = await dispatchRpc({
        domain: 'scheduler',
        method,
        payload: {
          id: 'user:task-1',
          taskId: 'user:task-1',
          runId: 'run-1',
          enabled: false,
          name: 'x',
          prompt: 'y',
          agentId: 'default',
          schedule: { kind: 'interval', everyMs: 60_000 },
        },
      })
      expect(response.ok, `${method} should dispatch`).toBe(true)
    }

    await expect(dispatchRpc({ domain: 'scheduler', method: 'nope', payload: {} }))
      .resolves.toMatchObject({ ok: false })
  })

  it('list projects the scheduler snapshot as-is', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'scheduler', method: 'list', payload: {} }))
      .resolves.toEqual({ ok: true, data: { success: true, tasks: [TASK] } })
  })

  it('runNow saves a run detail whose result went through toJsonValue', async () => {
    const { dispatchRpc } = await loadDomain()
    // 用户任务不落运行详情(账本由用户任务那侧管),所以这条走内置任务分支。
    userTasks.isUserSchedulerTask.mockReturnValue(false)
    // 非 JSON 值(函数)必须在落盘前被 toJsonValue 抹平。
    scheduler.runNow.mockResolvedValue({
      runId: 'run-9',
      taskId: 'builtin:task',
      reason: 'manual',
      scheduledFor: 1,
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
      ok: true,
      result: { keep: 'me', drop: () => undefined },
    })

    const response = await dispatchRpc({
      domain: 'scheduler',
      method: 'runNow',
      payload: { id: 'builtin:task', force: true },
    })

    expect(response).toMatchObject({ ok: true, data: { success: true } })
    expect(runHistory.saveSchedulerRunDetail).toHaveBeenCalledTimes(1)
    const detail = runHistory.saveSchedulerRunDetail.mock.calls[0][0]
    expect(detail.result).toEqual({ keep: 'me' })
  })

  it('setEnabled forks on isUserSchedulerTask — the two branches never cross', async () => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({
      domain: 'scheduler',
      method: 'setEnabled',
      payload: { id: 'user:task-1', enabled: false },
    })
    expect(userTasks.setUserSchedulerTaskEnabled).toHaveBeenCalledWith('user:task-1', false)
    expect(scheduler.setEnabled).not.toHaveBeenCalled()

    userTasks.isUserSchedulerTask.mockReturnValue(false)
    await dispatchRpc({
      domain: 'scheduler',
      method: 'setEnabled',
      payload: { id: 'builtin:task', enabled: true },
    })
    expect(scheduler.setEnabled).toHaveBeenCalledWith('builtin:task', true)
    expect(userTasks.setUserSchedulerTaskEnabled).toHaveBeenCalledTimes(1)
  })

  it('deleteTask refuses a plugin task inside the projection, not by throwing', async () => {
    const { dispatchRpc } = await loadDomain()
    userTasks.isUserSchedulerTask.mockReturnValue(false)

    await expect(dispatchRpc({
      domain: 'scheduler',
      method: 'deleteTask',
      payload: { id: 'plugin:task' },
    })).resolves.toMatchObject({ ok: true, data: { success: false } })
    expect(userTasks.deleteUserSchedulerTask).not.toHaveBeenCalled()
  })

  it('a throwing dependency stays a { success:false } payload, not an ok:false envelope', async () => {
    const { dispatchRpc } = await loadDomain()
    scheduler.list.mockImplementation(() => {
      throw new Error('scheduler is down')
    })

    await expect(dispatchRpc({ domain: 'scheduler', method: 'list', payload: {} }))
      .resolves.toEqual({ ok: true, data: { success: false, error: 'scheduler is down' } })
  })

  it('listRuns prefers saved details and falls back to the snapshot recentRuns', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({
      domain: 'scheduler',
      method: 'listRuns',
      payload: { taskId: 'user:task-1', limit: 10 },
    })).resolves.toEqual({ ok: true, data: { success: true, runs: [{ runId: 'run-1' }] } })
    expect(runHistory.listSchedulerRunDetails).toHaveBeenCalledWith('user:task-1', 10)

    runHistory.listSchedulerRunDetails.mockResolvedValue([])
    scheduler.getStatus.mockReturnValue({
      ...TASK,
      recentRuns: [{ runId: 'run-2', taskId: 'user:task-1', result: undefined }],
    })

    const response = await dispatchRpc({
      domain: 'scheduler',
      method: 'listRuns',
      payload: { taskId: 'user:task-1' },
    })
    expect(response).toMatchObject({ ok: true })
    expect((response as { data: { runs: Array<{ runId?: string }> } }).data.runs[0].runId).toBe('run-2')
  })
})

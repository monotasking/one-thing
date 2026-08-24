/**
 * practice 域,端到端穿过 dispatcher(结构债 P4a)。
 *
 * 接的是被删掉的那十条 `ipcMain.handle`(`apps/electron/src/main/ipc/practice.ts`)
 * 的测试位:那些转发从来没有自己的用例,真正值得钉的是**搬家没搬丢形状** ——
 * 传输面只递不判,判定与缺省全在 `@onething/runtime/practice` 的服务函数里。所以这里
 * 逐条盯的是:
 *  - 十个方法全在 router 的白名单上(少一个 = 渲染侧那一格静默失灵);
 *  - 引擎返回的是**裸 snapshot**,由这一层包成 `{ snapshot }`(契约层的响应形状);
 *  - `stop` 的 `discard` 缺省是 `false` —— 信封化之后 payload 一定在,但键仍可缺席,
 *    漏掉那个 `?? false` 会把「正常结束」变成 `stopPractice(undefined)`;
 *  - `setConfig` 把整个请求(`{ config }`)原样递给写配置函数,不在传输面拆包。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { practiceRouter } from '@shared/ipc/practice.js'

const practice = vi.hoisted(() => ({
  startPractice: vi.fn(),
  pausePractice: vi.fn(),
  resumePractice: vi.fn(),
  stopPractice: vi.fn(),
  getPracticeState: vi.fn(),
  logPractice: vi.fn(),
  getPracticeSummary: vi.fn(),
  getRecentPracticeRecords: vi.fn(),
  readPracticeConfig: vi.fn(),
  writePracticeConfig: vi.fn(),
}))

vi.mock('@onething/runtime/practice/service.wiring', () => practice)

const IDLE = { status: 'idle' as const }
const RUNNING = { status: 'running' as const, kind: 'kegel' as const }
const CONFIG = {
  kegel: { holdSec: 10, relaxSec: 5, reps: 20, sets: 3, setRestSec: 60, sound: true },
  pomodoro: { minutes: 25, categories: ['学习'] },
}

async function loadDomain() {
  const [
    { dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests },
    { practiceRpcHandlers },
  ] = await Promise.all([
    import('../registry.js'),
    import('../domains/practice.js'),
  ])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, practiceRpcHandlers }
}

describe('practice RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    practice.startPractice.mockReset().mockResolvedValue(RUNNING)
    practice.pausePractice.mockReset().mockReturnValue({ status: 'paused' as const })
    practice.resumePractice.mockReset().mockReturnValue(RUNNING)
    practice.stopPractice.mockReset().mockReturnValue(IDLE)
    practice.getPracticeState.mockReset().mockReturnValue(RUNNING)
    practice.logPractice.mockReset().mockReturnValue({ id: 'r1', kind: 'exercise' })
    practice.getPracticeSummary.mockReset().mockResolvedValue({ granularity: 'day', buckets: [] })
    practice.getRecentPracticeRecords.mockReset().mockResolvedValue([{ id: 'r1' }])
    practice.readPracticeConfig.mockReset().mockResolvedValue(CONFIG)
    practice.writePracticeConfig.mockReset().mockResolvedValue(CONFIG)
    const { resetRpcRegistryForTests, registerRouterHandlers, practiceRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(practiceRouter, practiceRpcHandlers)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('binds all ten methods — an unlisted one never reaches a handler', async () => {
    const { dispatchRpc } = await loadDomain()
    const methods = [
      'start', 'pause', 'resume', 'stop', 'getState',
      'log', 'summary', 'recent', 'getConfig', 'setConfig',
    ]

    for (const method of methods) {
      const response = await dispatchRpc({
        domain: 'practice',
        method,
        payload: { kind: 'kegel', granularity: 'day', name: 'x', source: 'manual', exercise: {}, config: {} },
      })
      expect(response.ok, `${method} should dispatch`).toBe(true)
    }

    await expect(dispatchRpc({ domain: 'practice', method: 'nope', payload: {} }))
      .resolves.toMatchObject({ ok: false })
  })

  it('start hands the request through untouched and wraps the bare snapshot', async () => {
    const { dispatchRpc } = await loadDomain()
    const request = { kind: 'pomodoro', category: '学习', label: '第一轮' }

    await expect(dispatchRpc({ domain: 'practice', method: 'start', payload: request }))
      .resolves.toEqual({ ok: true, data: { snapshot: RUNNING } })
    expect(practice.startPractice).toHaveBeenCalledWith(request)
  })

  it('getState projects the engine snapshot as-is', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'practice', method: 'getState', payload: {} }))
      .resolves.toEqual({ ok: true, data: { snapshot: RUNNING } })
  })

  it('stop defaults discard to false — an absent key must not become undefined', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'practice', method: 'stop', payload: {} }))
      .resolves.toEqual({ ok: true, data: { snapshot: IDLE } })
    expect(practice.stopPractice).toHaveBeenCalledWith(false)

    await dispatchRpc({ domain: 'practice', method: 'stop', payload: { discard: true } })
    expect(practice.stopPractice).toHaveBeenLastCalledWith(true)
  })

  it('setConfig hands the whole request to the config writer (no transport-side unpacking)', async () => {
    const { dispatchRpc } = await loadDomain()
    const request = { config: { kegel: { holdSec: 12 } } }

    await expect(dispatchRpc({ domain: 'practice', method: 'setConfig', payload: request }))
      .resolves.toEqual({ ok: true, data: { config: CONFIG } })
    expect(practice.writePracticeConfig).toHaveBeenCalledWith(request)
  })

  it('recent leaves the days/limit defaults to the service, and wraps the record list', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'practice', method: 'recent', payload: {} }))
      .resolves.toEqual({ ok: true, data: { records: [{ id: 'r1' }] } })
    expect(practice.getRecentPracticeRecords).toHaveBeenCalledWith(undefined, undefined)

    await dispatchRpc({ domain: 'practice', method: 'recent', payload: { days: 7, limit: 10 } })
    expect(practice.getRecentPracticeRecords).toHaveBeenLastCalledWith(7, 10)
  })
})

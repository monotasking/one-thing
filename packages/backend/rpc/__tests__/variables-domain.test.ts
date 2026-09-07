/**
 * variables 域,端到端穿过 dispatcher(结构债 P4c)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/variables{,-controller}.ts`
 * 的工厂(它的 `__tests__/variables.test.ts` 只证「三条通道各挂了一个 handle」)、
 * bridge 上那三条**位置参数**的包装、以及 server 那三条 REST 路由。真正值得钉的是
 * **搬家没搬丢形状**:
 *  - 三个方法全在 router 的白名单上;
 *  - 请求从「壳自己排的位置参数」变成信封之后,`set` 递给注册表的 `SetInput`
 *    仍然是那六个键(name/value/scope/type/description/state),一个不多一个不少 ——
 *    这正是位置参数最容易错位的地方;
 *  - `delete` 把可选的 `scope` 原样递下去(缺席 = 让注册表自己挑作用域);
 *  - `VariableError` 的 `code` 必须活着穿过传输面(渲染侧按 code 决定提示)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { variablesRouter } from '@shared/ipc/variables.js'

const registry = vi.hoisted(() => ({
  list: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('@onething/runtime/variables/registry', () => ({
  getVariableRegistry: () => registry,
}))

async function loadDomain() {
  const [{ dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests }, { variablesRpcHandlers }] =
    await Promise.all([import('../registry.js'), import('../domains/variables.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, variablesRpcHandlers }
}

describe('variables RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    registry.list.mockReset().mockReturnValue([{ name: 'topic', value: 'x' }])
    registry.set.mockReset().mockResolvedValue({ name: 'topic', value: 'x' })
    registry.delete.mockReset().mockResolvedValue(undefined)

    const { resetRpcRegistryForTests, registerRouterHandlers, variablesRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(variablesRouter, variablesRpcHandlers)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('binds all three methods — an unlisted one never reaches a handler', async () => {
    const { dispatchRpc } = await loadDomain()

    for (const method of ['list', 'set', 'delete']) {
      const response = await dispatchRpc({
        domain: 'variables',
        method,
        payload: { sessionId: 'session-1', name: 'topic', value: 'x' },
      })
      expect(response.ok, `${method} should dispatch`).toBe(true)
    }

    await expect(dispatchRpc({ domain: 'variables', method: 'nope', payload: {} }))
      .resolves.toMatchObject({ ok: false })
  })

  it('list reads the registry with the session context and wraps the snapshot', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({
      domain: 'variables',
      method: 'list',
      payload: { sessionId: 'session-1' },
    })).resolves.toEqual({
      ok: true,
      data: { success: true, variables: [{ name: 'topic', value: 'x' }] },
    })
    expect(registry.list).toHaveBeenCalledWith({ sessionId: 'session-1' })
  })

  it('set unpacks the envelope into the six SetInput keys, not a positional list', async () => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({
      domain: 'variables',
      method: 'set',
      payload: {
        sessionId: 'session-1',
        name: 'topic',
        value: 'web runtime',
        scope: 'session',
        type: 'string',
        description: 'Current topic',
        state: true,
      },
    })

    expect(registry.set).toHaveBeenCalledWith(
      { sessionId: 'session-1' },
      {
        name: 'topic',
        value: 'web runtime',
        scope: 'session',
        type: 'string',
        description: 'Current topic',
        state: true,
      },
    )
  })

  it('delete passes the optional scope through — an absent one stays absent', async () => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({
      domain: 'variables',
      method: 'delete',
      payload: { sessionId: 'session-1', name: 'topic' },
    })
    expect(registry.delete).toHaveBeenCalledWith({ sessionId: 'session-1' }, 'topic', undefined)

    await dispatchRpc({
      domain: 'variables',
      method: 'delete',
      payload: { sessionId: 'session-1', name: 'topic', scope: 'global' },
    })
    expect(registry.delete).toHaveBeenLastCalledWith({ sessionId: 'session-1' }, 'topic', 'global')
  })

  it('a registry error keeps its code and stays a { success:false } payload', async () => {
    const { dispatchRpc } = await loadDomain()
    const { VariableError } = await import('@onething/runtime/variables')
    registry.set.mockRejectedValue(new VariableError('READONLY', 'workdir is read-only'))

    await expect(dispatchRpc({
      domain: 'variables',
      method: 'set',
      payload: { sessionId: 'session-1', name: 'workdir', value: '/tmp' },
    })).resolves.toEqual({
      ok: true,
      data: { success: false, error: 'workdir is read-only', code: 'READONLY' },
    })
  })
})
// Adapter fixtures explicitly belong to the local operator on both transports.
vi.mock('../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({ findMeta: () => ({}) }) }
})

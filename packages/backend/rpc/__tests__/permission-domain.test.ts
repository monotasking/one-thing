/**
 * permission 域(运行中的活询问),端到端穿过 dispatcher(结构债 P4c)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/permission.ts` 的工厂、
 * bridge 上那两条包装、server 那条正则路由的两个分支。值得钉的是:
 *  - 两个方法都在 router 的白名单上,`respond` **不在**(它是命令总线上的一条命令,
 *    多挂一条 RPC 就等于绕过通道亲和性校验);
 *  - `getPending` 读的是 `Permission.getPendingPrompts` —— 全景,含 `promptState`
 *    标注的排队 prompt。换成只给 actionable 的那批,重载后排队卡就会凭空消失;
 *  - 出错时回 `{ success:false, error }`,而不是让 dispatcher 变成 `ok:false`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { permissionRouter } from '@shared/ipc/permissions.js'

const permission = vi.hoisted(() => ({
  Permission: {
    getPendingPrompts: vi.fn(),
    clearSession: vi.fn(),
  },
}))

vi.mock('../../wiring/permission/index.js', () => permission)

const ACTIONABLE = {
  id: 'p1',
  type: 'bash',
  sessionId: 'session-1',
  messageId: 'm1',
  callId: 'call-1',
  title: 'run ls',
  metadata: {},
  createdAt: 1,
  promptState: 'actionable' as const,
}
const QUEUED = { ...ACTIONABLE, id: 'p2', callId: 'call-2', promptState: 'queued' as const }

async function loadDomain() {
  const [{ dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests }, { permissionRpcHandlers }] =
    await Promise.all([import('../registry.js'), import('../domains/permission.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, permissionRpcHandlers }
}

describe('permission RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    permission.Permission.getPendingPrompts.mockReset().mockReturnValue([ACTIONABLE, QUEUED])
    permission.Permission.clearSession.mockReset().mockReturnValue(undefined)

    const { resetRpcRegistryForTests, registerRouterHandlers, permissionRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(permissionRouter, permissionRpcHandlers)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('binds exactly the two read/clear methods — respond is deliberately absent', async () => {
    const { dispatchRpc } = await loadDomain()

    for (const method of ['getPending', 'clearSession']) {
      const response = await dispatchRpc({
        domain: 'permission',
        method,
        payload: { sessionId: 'session-1' },
      })
      expect(response.ok, `${method} should dispatch`).toBe(true)
    }

    // 应答走命令总线(`command:permission-respond`),core 在那里校验通道亲和性。
    await expect(dispatchRpc({
      domain: 'permission',
      method: 'respond',
      payload: { sessionId: 'session-1' },
    })).resolves.toMatchObject({ ok: false })
  })

  it('getPending returns the full picture, queued prompts included', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({
      domain: 'permission',
      method: 'getPending',
      payload: { sessionId: 'session-1' },
    })).resolves.toEqual({ ok: true, data: { success: true, pending: [ACTIONABLE, QUEUED] } })
    expect(permission.Permission.getPendingPrompts).toHaveBeenCalledWith('session-1')
  })

  it('clearSession clears exactly the asked-for session', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({
      domain: 'permission',
      method: 'clearSession',
      payload: { sessionId: 'session-2' },
    })).resolves.toEqual({ ok: true, data: { success: true } })
    expect(permission.Permission.clearSession).toHaveBeenCalledWith('session-2')
  })

  it('a throwing core stays a { success:false } payload, not an ok:false envelope', async () => {
    const { dispatchRpc } = await loadDomain()
    permission.Permission.getPendingPrompts.mockImplementation(() => {
      throw new Error('engine is down')
    })

    await expect(dispatchRpc({
      domain: 'permission',
      method: 'getPending',
      payload: { sessionId: 'session-1' },
    })).resolves.toEqual({ ok: true, data: { success: false, error: 'engine is down' } })
  })
})

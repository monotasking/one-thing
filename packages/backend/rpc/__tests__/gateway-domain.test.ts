/**
 * gateway 域,端到端穿过 dispatcher(结构债 P4c 第八批)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/gateway.ts` 的工厂
 * (它自己带的信封逻辑 `toResponse` / `toObjectResponse` 搬进了宿主端口)、
 * bridge 上那八条包装、server 的八条 REST 路由 + `gateway` facade adapter。
 * 值得钉的是:
 *  - 八个方法都在 router 的白名单上,**本域零推送**(全仓没有 `GATEWAY_*_CHANGED`);
 *  - **端口未注入 = 结构化降级**,不是抛错、也不是 501 —— server / CLI 拿到的
 *    就是这个;
 *  - 注入之后是**逐条转调**,请求原样递下去;
 *  - 生命周期原语抛错时折成 `{ success:false, error }`(旧工厂 `toResponse` 的
 *    行为,逐字保留)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayStatus } from '@shared/ipc/gateway.js'

async function loadDomain() {
  const [{ dispatchRpc, resetRpcRegistryForTests }, { registerGatewayRpcDomain }, ports]
    = await Promise.all([
      import('../registry.js'),
      import('../domains/gateway.js'),
      import('../../wiring/gateway/host-ports.js'),
    ])
  return { dispatchRpc, resetRpcRegistryForTests, registerGatewayRpcDomain, ports }
}

function status(overrides: Partial<GatewayStatus> = {}): GatewayStatus {
  return {
    running: false,
    starting: false,
    stopping: false,
    enabled: true,
    wechat: { enabled: true, running: false, loginStatus: 'idle', loggedIn: false },
    ...overrides,
  }
}

describe('gateway RPC domain', () => {
  let dispose: (() => void) | undefined
  let api: Awaited<ReturnType<typeof loadDomain>>

  beforeEach(async () => {
    api = await loadDomain()
    api.resetRpcRegistryForTests()
    api.ports.configureGatewayHost({})
    dispose = api.registerGatewayRpcDomain()
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    api.ports.configureGatewayHost({})
    vi.restoreAllMocks()
  })

  it('degrades structurally when no host injected the gateway lifecycle', async () => {
    for (const method of ['getStatus', 'start', 'stop', 'wechatLogout']) {
      const response = await api.dispatchRpc({ domain: 'gateway', method, payload: {} })
      if (!response.ok) throw new Error(`dispatch failed: ${response.error.message}`)
      expect(response.data).toEqual({
        success: false,
        error: api.ports.GATEWAY_HOST_UNAVAILABLE,
      })
    }
  })

  it('forwards to the injected host and wraps the raw status in the contract envelope', async () => {
    const start = vi.fn(async () => status({ running: true }))
    api.ports.configureGatewayHost({ start })

    const response = await api.dispatchRpc({
      domain: 'gateway',
      method: 'start',
      payload: { channel: 'wechat', accountId: 'default' },
    })
    if (!response.ok) throw new Error(`dispatch failed: ${response.error.message}`)
    expect(start).toHaveBeenCalledWith({ channel: 'wechat', accountId: 'default' })
    expect(response.data).toEqual({ success: true, status: status({ running: true }) })
  })

  it('reports the live status through getStatus', async () => {
    api.ports.configureGatewayHost({ getStatus: () => status() })
    const response = await api.dispatchRpc({ domain: 'gateway', method: 'getStatus', payload: {} })
    if (!response.ok) throw new Error(`dispatch failed: ${response.error.message}`)
    expect(response.data).toEqual({ success: true, status: status() })
  })

  it('carries the account back on wechatAddAccount and folds a throw into a failure', async () => {
    api.ports.configureGatewayHost({
      wechatAddAccount: async () => ({
        status: status(),
        account: { id: 'wechat-2', enabled: true, running: true, loginStatus: 'waiting-for-scan', loggedIn: false },
      }),
      wechatRemoveAccount: async () => {
        throw new Error('account is busy')
      },
    })

    const added = await api.dispatchRpc({ domain: 'gateway', method: 'wechatAddAccount', payload: {} })
    if (!added.ok) throw new Error(`dispatch failed: ${added.error.message}`)
    expect(added.data).toMatchObject({ success: true, account: { id: 'wechat-2' } })

    const removed = await api.dispatchRpc({
      domain: 'gateway',
      method: 'wechatRemoveAccount',
      payload: { accountId: 'wechat-2' },
    })
    if (!removed.ok) throw new Error(`dispatch failed: ${removed.error.message}`)
    expect(removed.data).toEqual({ success: false, error: 'account is busy' })
  })

  it('rejects a method that is not on the router allowlist', async () => {
    const response = await api.dispatchRpc({
      domain: 'gateway',
      method: 'wechatSendMessage',
      payload: {},
    })
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error('expected a rejection')
    expect(response.error.code).toBe('UNKNOWN_METHOD')
  })
})

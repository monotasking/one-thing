/**
 * oauth 域,端到端穿过 dispatcher(结构债 P4c 第七批)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/oauth.ts` 的工厂
 * (连同它的 `__tests__/oauth.test.ts`)、bridge 上那六条包装、server 的六条 REST
 * 路由与「按 owner 分表的设备流」那条 http 用例。值得钉的是:
 *  - 六个数据面方法都在 router 的白名单上,**两条推送不在**
 *    (`OAUTH_TOKEN_REFRESHED` / `OAUTH_TOKEN_EXPIRED` 走
 *    `configureOAuthEventBroadcaster` 注入端口 —— router 今天没有推送面);
 *  - 凭证写回目标(批 B6 的 spaceId / entryId / label)真的传到 authService 了
 *    —— 从前 web 壳把它收下即丢;
 *  - **`start` 在 http 上不开浏览器**:旧 server 路由从来就没递过 `openExternal`,
 *    这条分叉逐字保留;桌面(desktop 上下文)才走 shell 端口;
 *  - `refresh` 失败时把「令牌过期」经**事件源**通知出去(而不是像从前桌面那样
 *    直接调 Electron 广播),于是桌面窗口与 web 的 SSE 收到的是同一次事件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authService = vi.hoisted(() => ({
  start: vi.fn(),
  completeManualCode: vi.fn(),
  pollDeviceFlow: vi.fn(),
  refreshToken: vi.fn(),
  getStatus: vi.fn(),
  deleteToken: vi.fn(),
}))

const shell = vi.hoisted(() => ({
  openExternal: vi.fn(),
}))

const events = vi.hoisted(() => ({
  notifyOAuthTokenExpired: vi.fn(),
}))

vi.mock('../../wiring/auth/auth-service.js', () => ({ authService }))
vi.mock('../../wiring/auth/oauth-events.js', () => events)
vi.mock('@onething/runtime/shell/host-ports', () => ({ getShellHost: () => shell }))

const HTTP_CONTEXT = {
  transport: 'http' as const,
  caller: 'remote',
  sandboxRoot: '/workspace',
}

async function loadDomain() {
  const [{ dispatchRpc, resetRpcRegistryForTests }, { registerOAuthRpcDomain }] =
    await Promise.all([import('../registry.js'), import('../domains/oauth.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerOAuthRpcDomain }
}

describe('oauth RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    authService.start.mockReset().mockResolvedValue({
      success: true,
      flowKind: 'pkce-callback',
      authUrl: 'https://example.test/authorize',
      state: 'state-1',
    })
    authService.completeManualCode.mockReset().mockResolvedValue({ success: true })
    authService.pollDeviceFlow.mockReset().mockResolvedValue({ success: true, completed: true })
    authService.refreshToken.mockReset().mockResolvedValue({ success: true })
    authService.getStatus.mockReset().mockResolvedValue({
      success: true,
      providerId: 'github-copilot',
      isLoggedIn: true,
    })
    authService.deleteToken.mockReset().mockResolvedValue({ success: true })
    shell.openExternal.mockReset().mockResolvedValue({ success: true })
    events.notifyOAuthTokenExpired.mockReset()

    const { resetRpcRegistryForTests, registerOAuthRpcDomain } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerOAuthRpcDomain()
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('binds the six data methods — the two token pushes are deliberately not among them', async () => {
    const { dispatchRpc } = await loadDomain()

    for (const method of ['start', 'callback', 'devicePoll', 'refresh', 'status', 'logout']) {
      const response = await dispatchRpc({
        domain: 'oauth',
        method,
        payload: { providerId: 'github-copilot', code: 'c', state: 's' },
      })
      expect(response.ok, `${method} should dispatch`).toBe(true)
    }

    for (const method of ['subscribe', 'onTokenRefreshed', 'onTokenExpired']) {
      await expect(dispatchRpc({ domain: 'oauth', method, payload: {} }))
        .resolves.toMatchObject({ ok: false })
    }
  })

  it('start opens the browser on the desktop and never on http', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'oauth', method: 'start', payload: { providerId: 'claude-code' } }))
      .resolves.toMatchObject({ ok: true, data: { success: true, authUrl: 'https://example.test/authorize' } })
    // `openExternal` 是投影里 fire-and-forget 的一次调用,让它跑完这一轮微任务。
    await Promise.resolve()
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.test/authorize')

    shell.openExternal.mockClear()
    const remote = await dispatchRpc(
      { domain: 'oauth', method: 'start', payload: { providerId: 'claude-code' } },
      HTTP_CONTEXT,
    )
    await Promise.resolve()
    // http 上响应照常带着 authUrl 回去 —— 由调用方自己开(旧 server 路由的形状)。
    expect(remote).toMatchObject({ ok: true, data: { authUrl: 'https://example.test/authorize' } })
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('carries the credential target through to the auth service on every method', async () => {
    const { dispatchRpc } = await loadDomain()
    const target = { spaceId: 'space-1', entryId: 'entry-1', label: 'work' }

    await dispatchRpc({ domain: 'oauth', method: 'status', payload: { providerId: 'codex', ...target } })
    expect(authService.getStatus).toHaveBeenCalledWith('codex', expect.objectContaining({ spaceId: 'space-1' }))

    await dispatchRpc({
      domain: 'oauth',
      method: 'callback',
      payload: { providerId: 'codex', code: 'code-1', state: 'state-1', ...target },
    })
    expect(authService.completeManualCode).toHaveBeenCalledWith(
      'codex',
      'code-1',
      'state-1',
      expect.objectContaining({ spaceId: 'space-1' }),
    )

    await dispatchRpc({
      domain: 'oauth',
      method: 'devicePoll',
      payload: { providerId: 'github-copilot', flowId: 'flow-1', ...target },
    })
    expect(authService.pollDeviceFlow).toHaveBeenCalledWith(
      'github-copilot',
      'flow-1',
      expect.objectContaining({ spaceId: 'space-1' }),
    )

    await dispatchRpc({ domain: 'oauth', method: 'logout', payload: { providerId: 'codex', ...target } })
    expect(authService.deleteToken).toHaveBeenCalledWith('codex', expect.objectContaining({ entryId: 'entry-1' }))
  })

  it('refresh reports a thrown refresh as an expired token through the event source', async () => {
    // 投影的判据是**抛出**,不是回一个 falsy —— 逐字保留。
    authService.refreshToken.mockRejectedValue(new Error('refresh_token revoked'))

    const { dispatchRpc } = await loadDomain()
    await expect(dispatchRpc({ domain: 'oauth', method: 'refresh', payload: { providerId: 'codex' } }))
      .resolves.toMatchObject({ ok: true, data: { success: false } })
    expect(events.notifyOAuthTokenExpired).toHaveBeenCalledWith('codex', 'refresh_token revoked')
  })

  it('folds a thrown auth-service error into a structured failure, not an ok:false envelope', async () => {
    authService.getStatus.mockRejectedValue(new Error('token store unreadable'))

    const { dispatchRpc } = await loadDomain()
    const response = await dispatchRpc({ domain: 'oauth', method: 'status', payload: { providerId: 'codex' } })

    // 渲染侧那套 `response.success` 判断照旧成立;dispatcher 不因此变成 ok:false。
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error('unreachable')
    expect(response.data).toMatchObject({ success: false, isLoggedIn: false })
  })
})

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
 *  - **后端从不开浏览器**(批 1,`docs/design/provider-settings-rework-2026-09.md` §3.1):
 *    `start` 只交回 `authUrl` / `verificationUri`,壳拿到后自己开 —— 宿主有外壳也不开
 *    (React 壳注入 `shell` 之后,后端再开一次就是两扇窗);
 *  - `cancel` 把 flowId 交给 authService,答它说的「真取消了没有」;
 *  - `refresh` 失败时把「令牌过期」经**事件源**通知出去(而不是像从前桌面那样
 *    直接调 Electron 广播),于是桌面窗口与 web 的 SSE 收到的是同一次事件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { oauthRouter } from '@shared/ipc/oauth.js'

const authService = vi.hoisted(() => ({
  start: vi.fn(),
  completeManualCode: vi.fn(),
  pollDeviceFlow: vi.fn(),
  refreshToken: vi.fn(),
  getStatus: vi.fn(),
  deleteToken: vi.fn(),
  cancel: vi.fn(),
}))

const shell = vi.hoisted(() => ({
  openExternal: vi.fn(),
}))

const events = vi.hoisted(() => ({
  notifyOAuthTokenExpired: vi.fn(),
}))

/**
 * C0 R7 要观察的是「开浏览器失败有没有被吞掉」,而唯一的出口是投影层那句
 * `logger.error('[OAuth] Open external URL failed:', …)`。所以这份测试把域用的
 * 那只 logger 换成可数的:`getLogger` 与 `consolePort` 交出同一只 spy。
 */
const oauthLog = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  log: vi.fn(),
}))

vi.mock('@onething/backend/runtime/logging/configure-logging', () => ({
  getLogger: () => oauthLog,
  consolePort: () => oauthLog,
}))

vi.mock('@onething/backend/runtime/auth/process-auth-service', () => ({ getAuthService: () => authService }))
vi.mock('@onething/backend/runtime/auth/oauth-events', () => events)
let shellHostPresent = true

vi.mock('@onething/backend/runtime/shell/host-ports', () => ({
  getShellHost: () => shell,
  hasShellHost: () => shellHostPresent,
}))

const HTTP_CONTEXT = {
  transport: 'http' as const,
  caller: 'remote',
  sandboxRoot: '/workspace',
}

async function loadDomain() {
  const [{ dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests }, { oauthRpcHandlers }] =
    await Promise.all([import('../../../http-server/http-server-dispatch-table.js'), import('../auth-client-api.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, oauthRpcHandlers }
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
    authService.cancel.mockReset().mockReturnValue(true)
    shellHostPresent = true
    shell.openExternal.mockReset().mockResolvedValue({ success: true })
    events.notifyOAuthTokenExpired.mockReset()
    for (const fn of Object.values(oauthLog)) fn.mockReset()

    const { resetRpcRegistryForTests, registerRouterHandlers, oauthRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(oauthRouter, oauthRpcHandlers)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('binds the seven data methods — the two token pushes are deliberately not among them', async () => {
    const { dispatchRpc } = await loadDomain()

    for (const method of ['start', 'callback', 'devicePoll', 'refresh', 'status', 'logout', 'cancel']) {
      const response = await dispatchRpc({
        domain: 'oauth',
        method,
        payload: { providerId: 'github-copilot', code: 'c', state: 's', flowId: 'f' },
      })
      expect(response.ok, `${method} should dispatch`).toBe(true)
    }

    for (const method of ['subscribe', 'onTokenRefreshed', 'onTokenExpired']) {
      await expect(dispatchRpc({ domain: 'oauth', method, payload: {} }))
        .resolves.toMatchObject({ ok: false })
    }
  })

  it('start never opens the browser — shell or not, either transport: authUrl goes back to the caller (批 1)', async () => {
    const { dispatchRpc } = await loadDomain()

    for (const present of [true, false]) {
      shellHostPresent = present
      for (const context of [undefined, HTTP_CONTEXT]) {
        const answer = await dispatchRpc(
          { domain: 'oauth', method: 'start', payload: { providerId: 'claude-code' } },
          context,
        )
        await Promise.resolve()
        expect(answer).toMatchObject({ ok: true, data: { success: true, authUrl: 'https://example.test/authorize' } })
      }
    }
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('cancel hands the flowId to authService and reports whether a live flow was cancelled', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'oauth', method: 'cancel', payload: { flowId: 'flow-9' } }))
      .resolves.toMatchObject({ ok: true, data: { success: true, cancelled: true } })
    expect(authService.cancel).toHaveBeenCalledWith('flow-9')

    authService.cancel.mockReturnValue(false)
    await expect(dispatchRpc({ domain: 'oauth', method: 'cancel', payload: { flowId: 'gone' } }))
      .resolves.toMatchObject({ ok: true, data: { success: true, cancelled: false } })

    await expect(dispatchRpc({ domain: 'oauth', method: 'cancel', payload: {} }))
      .resolves.toMatchObject({ ok: true, data: { success: false, cancelled: false } })
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

  it('no spaceId / the default space → the default space pool, never a settings slot (批 8)', async () => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({ domain: 'oauth', method: 'start', payload: { providerId: 'codex' } })
    expect(authService.start).toHaveBeenLastCalledWith('codex', { kind: 'space', spaceId: 'default' })

    await dispatchRpc({ domain: 'oauth', method: 'logout', payload: { providerId: 'codex', spaceId: 'default', entryId: 'e2' } })
    expect(authService.deleteToken).toHaveBeenLastCalledWith('codex', { kind: 'space', spaceId: 'default', entryId: 'e2' })
  })

  it('status answers every account of that pool (accounts[]) straight from the auth service', async () => {
    const { dispatchRpc } = await loadDomain()
    const accounts = [
      { entryId: 'a', label: 'codex #1', email: 'a@x.com', planType: 'plus', isExpired: false },
      { entryId: 'b', label: 'codex #2', isExpired: true },
    ]
    authService.getStatus.mockResolvedValueOnce({ success: true, providerId: 'codex', entryId: 'a', isLoggedIn: true, accounts })
    await expect(dispatchRpc({ domain: 'oauth', method: 'status', payload: { providerId: 'codex', spaceId: 'work' } }))
      .resolves.toMatchObject({ ok: true, data: { entryId: 'a', accounts } })
    expect(authService.getStatus).toHaveBeenLastCalledWith('codex', { kind: 'space', spaceId: 'work' })
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

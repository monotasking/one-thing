/**
 * search 域,端到端穿过 dispatcher(结构债 P4 终态批 A1-b)。
 *
 * 接的是被删掉的两处的测试位:`apps/electron/src/search/ipc.ts` 里那条
 * `IPC_CHANNELS.SEARCH_QUERY` 手写 handler,与 `POST /api/search/query` 那条 REST
 * 路由背后的 facade adapter。值得钉的是:
 *  - **本机可信**这一支打的是桌面那份 `wiring/search/providers` 的 `executeSearch`,
 *    连非法 category 归一成 `'all'` 这条(旧 handler 借 `executeOnethingSearchForIpc`
 *    拿到的行为)都一字未变;
 *  - **不可信**这一支打的是 `server/search-providers.ts` 那个单槽端口(装的就是
 *    从前那条 REST 背后的同一个闭包),并且**一次都不求值桌面那份** —— 否则一个
 *    网络调用者会读到宿主机器上别人的会话;
 *  - 端口没装(CLI daemon / 单测里的不可信上下文)时是**结构化失败**,不是偷偷
 *    降级去查桌面那份。
 *
 * B2(`docs/design/backend-transport-forks-2026-09.md` §2.2)之前这两支钉的是
 * `transport`。判据换成 `isHostLocallyTrusted()` 之后,下面每条都按「声明了没有」
 * 分组:声明过 → 两种 transport 同一个答案;没声明 → http 与 B2 之前逐字相同。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcDispatchContext, RpcResponse } from '@shared/ipc/rpc.js'
import { searchRouter } from '@shared/ipc/search.js'

const IPC: RpcDispatchContext = { transport: 'ipc' }
const HTTP: RpcDispatchContext = {
  transport: 'http',
  ownerUid: 'alice',
  workspaceId: 'w1',
  sandboxRoot: '/sandbox/alice/w1',
}

const executeSearch = vi.fn(async () => [{ id: 'chat:1', type: 'chat', title: 'Alpha' }])

vi.mock('../../wiring/search/providers.js', () => ({
  executeSearch: (...args: unknown[]) => executeSearch(...(args as [])),
}))

function unwrap(response: RpcResponse): Record<string, unknown> {
  // 读 `data` 之前先看 `ok` —— 失败的信封里没有 `data`。
  if (!response.ok) throw new Error(`dispatch failed: ${response.error.message}`)
  return response.data as Record<string, unknown>
}

describe('search RPC domain', () => {
  let dispatchRpc: typeof import('../registry.js')['dispatchRpc']
  let configureServerSearchPort: typeof import('../../server/search-providers.js')['configureServerSearchPort']
  let missingError: string
  let configureHostLocalTrust: typeof import('../../server/host-trust.js')['configureHostLocalTrust']
  let resetHostLocalTrustForTests: typeof import('../../server/host-trust.js')['resetHostLocalTrustForTests']
  let dispose: (() => void) | undefined
  let restorePort: (() => void) | undefined

  beforeEach(async () => {
    const [registry, domain, port, trust] = await Promise.all([
      import('../registry.js'),
      import('../domains/search.js'),
      import('../../server/search-providers.js'),
      import('../../server/host-trust.js'),
    ])
    dispatchRpc = registry.dispatchRpc
    configureServerSearchPort = port.configureServerSearchPort
    configureHostLocalTrust = trust.configureHostLocalTrust
    resetHostLocalTrustForTests = trust.resetHostLocalTrustForTests
    // 可信是**进程级单槽**:每条用例从"未声明"起跑。
    resetHostLocalTrustForTests()
    registry.resetRpcRegistryForTests()
    dispose = registry.registerRouterHandlers(searchRouter, domain.searchRpcHandlers)
    missingError = domain.SEARCH_SERVER_RUNTIME_MISSING_ERROR
    executeSearch.mockClear()
  })

  afterEach(() => {
    restorePort?.()
    restorePort = undefined
    dispose?.()
    dispose = undefined
    resetHostLocalTrustForTests()
  })

  function query(payload: unknown, context: RpcDispatchContext) {
    return dispatchRpc({ domain: 'search', method: 'query', payload }, context)
  }

  it('locally trusted: runs the desktop providers with the request verbatim', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    await expect(query({ query: 'Alpha', category: 'chats', limit: 5 }, IPC).then(unwrap))
      .resolves.toEqual({ success: true, results: [{ id: 'chat:1', type: 'chat', title: 'Alpha' }] })
    expect(executeSearch).toHaveBeenCalledWith('Alpha', 'chats', 5)
  })

  it('locally trusted: an unknown category still normalizes to "all" (旧 handler 的行为)', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    await query({ query: 'x', category: 'nope' }, IPC)
    expect(executeSearch).toHaveBeenCalledWith('x', 'all', undefined)
  })

  it('B2: a trusted http caller gets the very same answer as ipc, and the port is never asked', async () => {
    const portQuery = vi.fn(async () => ({ success: true, results: [{ id: 'sandboxed' }] }))
    restorePort = configureServerSearchPort({ query: portQuery })
    configureHostLocalTrust({ origin: 'desktop-embedded' })

    const overHttp = unwrap(await query({ query: 'Alpha', category: 'chats', limit: 5 }, HTTP))
    const overIpc = unwrap(await query({ query: 'Alpha', category: 'chats', limit: 5 }, IPC))
    expect(overHttp).toEqual(overIpc)
    expect(portQuery).not.toHaveBeenCalled()
    expect(executeSearch).toHaveBeenCalledTimes(2)
  })

  it('untrusted http: goes to the server port with the owner context, never to the desktop providers', async () => {
    const portQuery = vi.fn(async () => ({ success: true, results: [{ id: 'sandboxed' }] }))
    restorePort = configureServerSearchPort({ query: portQuery })

    await expect(query({ query: 'Alpha', category: 'chats', limit: 5 }, HTTP).then(unwrap))
      .resolves.toEqual({ success: true, results: [{ id: 'sandboxed' }] })
    expect(portQuery).toHaveBeenCalledWith(
      { query: 'Alpha', category: 'chats', limit: 5 },
      { userId: 'alice', workspaceId: 'w1' },
    )
    expect(executeSearch).not.toHaveBeenCalled()
  })

  it('untrusted http without a server runtime: structured failure, not a silent desktop search', async () => {
    const response = await query({ query: 'Alpha', category: 'chats' }, HTTP)
    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error.message).toBe(missingError)
    expect(executeSearch).not.toHaveBeenCalled()
  })
})

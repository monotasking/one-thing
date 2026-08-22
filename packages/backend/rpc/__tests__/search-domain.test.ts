/**
 * search 域,端到端穿过 dispatcher(结构债 P4 终态批 A1-b)。
 *
 * 接的是被删掉的两处的测试位:`apps/electron/src/search/ipc.ts` 里那条
 * `IPC_CHANNELS.SEARCH_QUERY` 手写 handler,与 `POST /api/search/query` 那条 REST
 * 路由背后的 facade adapter。值得钉的是:
 *  - **ipc 分支**打的是桌面那份 `wiring/search/providers` 的 `executeSearch`,
 *    连非法 category 归一成 `'all'` 这条(旧 handler 借 `executeOnethingSearchForIpc`
 *    拿到的行为)都一字未变;
 *  - **http 分支**打的是 `server/search-providers.ts` 那个单槽端口(装的就是从前
 *    那条 REST 背后的同一个闭包),并且**一次都不求值桌面那份** —— 否则一个网络
 *    调用者会读到宿主机器上别人的会话;
 *  - 端口没装(CLI daemon / 单测里的 http 上下文)时是**结构化失败**,不是偷偷
 *    降级去查桌面那份。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcDispatchContext, RpcResponse } from '@shared/ipc/rpc.js'

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
  let dispose: (() => void) | undefined
  let restorePort: (() => void) | undefined

  beforeEach(async () => {
    const [registry, domain, port] = await Promise.all([
      import('../registry.js'),
      import('../domains/search.js'),
      import('../../server/search-providers.js'),
    ])
    dispatchRpc = registry.dispatchRpc
    configureServerSearchPort = port.configureServerSearchPort
    registry.resetRpcRegistryForTests()
    dispose = domain.registerSearchRpcDomain()
    missingError = domain.SEARCH_SERVER_RUNTIME_MISSING_ERROR
    executeSearch.mockClear()
  })

  afterEach(() => {
    restorePort?.()
    restorePort = undefined
    dispose?.()
    dispose = undefined
  })

  function query(payload: unknown, context: RpcDispatchContext) {
    return dispatchRpc({ domain: 'search', method: 'query', payload }, context)
  }

  it('ipc: runs the desktop providers with the request verbatim', async () => {
    await expect(query({ query: 'Alpha', category: 'chats', limit: 5 }, IPC).then(unwrap))
      .resolves.toEqual({ success: true, results: [{ id: 'chat:1', type: 'chat', title: 'Alpha' }] })
    expect(executeSearch).toHaveBeenCalledWith('Alpha', 'chats', 5)
  })

  it('ipc: an unknown category still normalizes to "all" (旧 handler 的行为)', async () => {
    await query({ query: 'x', category: 'nope' }, IPC)
    expect(executeSearch).toHaveBeenCalledWith('x', 'all', undefined)
  })

  it('http: goes to the server port with the owner context, never to the desktop providers', async () => {
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

  it('http without a server runtime: structured failure, not a silent desktop search', async () => {
    const response = await query({ query: 'Alpha', category: 'chats' }, HTTP)
    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error.message).toBe(missingError)
    expect(executeSearch).not.toHaveBeenCalled()
  })
})

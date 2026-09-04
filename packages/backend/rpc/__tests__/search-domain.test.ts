/**
 * search 域,端到端穿过 dispatcher(结构债 P4 终态批 A1-b)。
 *
 * 接的是被删掉的两处的测试位:`apps/electron/src/search/ipc.ts` 里那条
 * `IPC_CHANNELS.SEARCH_QUERY` 手写 handler,与 `POST /api/search/query` 那条 REST
 * 路由背后的 facade adapter。值得钉的是:
 *  - **本机可信**这一支打的是这台进程装配的那份 `SearchService`,连非法 category
 *    归一成 `'all'` 这条(旧 handler 那时借一张写死的清单拿到的行为)都一字未变 ——
 *    S5 之后判据是「注册表里有没有这个 id」,答案相同;
 *  - **不可信**这一支打的是 `server/search-providers.ts` 那个单槽端口(装的就是
 *    从前那条 REST 背后的同一个闭包),并且**一次都不求值桌面那份** —— 否则一个
 *    网络调用者会读到宿主机器上别人的会话;
 *  - 端口没装(CLI daemon / 单测里的不可信上下文)时是**结构化失败**,不是偷偷
 *    降级去查桌面那份。
 *
 * B2(`docs/design/backend-transport-forks-2026-09.md` §2.2)之前这两支钉的是
 * `transport`。判据换成 `isHostLocallyTrusted()` 之后,下面每条都按「声明了没有」
 * 分组:声明过 → 两种 transport 同一个答案;没声明 → http 与 B2 之前逐字相同。
 *
 * 检索重建 S2(`docs/design/search-index-2026-09.md` §10)之后,**可信这一支去调谁**
 * 换了:从前是旧扫描路那条 `switch(category)`,现在是同一份取材面装起来的
 * `SearchService`(进程单槽;旧路 S5 已删)。所以下面的可信用例装的是一份**真服务**(六个内置
 * 能力都在),不是一只 spy —— 「不可信那一支一次都不求值桌面那份」这条断言因此改由
 * 取材面上的 spy 来钉:适配器一次都不该被问到。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcDispatchContext, RpcResponse } from '@shared/ipc/rpc.js'
import { searchRouter } from '@shared/ipc/search.js'
import {
  createOnethingSearchService,
  type OnethingSearchProvidersAdapters,
} from '@onething/runtime/search'
import type { SearchIndexQueryFace } from '@onething/runtime/search/capabilities'

/**
 * 索引替身(检索重建 S3b)。这份文件钉的是**域**的分叉与信封,不是命中语义,
 * 所以它只需要说得出「我是个能答话的索引」——`status` 那条用例读的正是它。
 */
const CHAT_DOC = {
  docId: 1,
  capability: 'chats',
  key: '1',
  time: 1,
  facets: { sessionId: '1', spaceId: '', archived: false, time: 1 },
  fields: { title: 'Alpha' },
}

const stubIndex: SearchIndexQueryFace = {
  search: async request => (request.capability === 'chats'
    ? {
      hits: [{ docId: 1, score: 1, matched: ['alpha'], fields: ['title'] }],
      total: 1,
      docs: [CHAT_DOC],
      generation: 3,
    }
    : { hits: [], total: 0, docs: [], generation: 3 }),
  vectorSearch: async () => ({ hits: [], docs: [], generation: 0, unavailable: 'off' as const }),
  status: async () => ({
    mode: 'owner',
    docs: 12,
    pending: 2,
    refolds: 0,
    building: false,
    generation: 3,
    errors: [],
    feeds: ['ledger'],
    vector: 'off',
    vectorPending: 0,
    vectorExtension: 'missing',
  }),
}

const IPC: RpcDispatchContext = { transport: 'ipc' }
const HTTP: RpcDispatchContext = {
  transport: 'http',
  ownerUid: 'alice',
  workspaceId: 'w1',
  sandboxRoot: '/sandbox/alice/w1',
}

/** 取材面上的唯一探针:桌面那份被问到过没有。 */
const getSessionsList = vi.fn(() => [{ id: '1', name: 'Alpha', updatedAt: 1 }])

const stubAdapters: OnethingSearchProvidersAdapters = {
  getSessionsList,
  iterateSessionMessages: () => [],
  getSession: () => undefined,
  getCurrentSessionId: () => undefined,
  getSettings: () => ({ general: { dailyNotes: { enabled: false } } }),
  getVariablesStore: () => ({
    getUserNoteDir: () => undefined,
    getWorkNoteDir: () => undefined,
  }),
  listFiles: () => ({ async *[Symbol.asyncIterator]() {} }),
  listPrompts: () => [],
}

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
  let restoreService: (() => void) | undefined

  beforeEach(async () => {
    const [registry, domain, port, trust, bound] = await Promise.all([
      import('../registry.js'),
      import('../domains/search.js'),
      import('../../server/search-providers.js'),
      import('../../server/host-trust.js'),
      import('@onething/runtime/search/service-bound'),
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
    getSessionsList.mockClear()
    restoreService = bound.configureOnethingSearchService(
      createOnethingSearchService(stubAdapters, { index: stubIndex }),
    )
  })

  afterEach(() => {
    restoreService?.()
    restoreService = undefined
    restorePort?.()
    restorePort = undefined
    dispose?.()
    dispose = undefined
    resetHostLocalTrustForTests()
  })

  function query(payload: unknown, context: RpcDispatchContext) {
    return dispatchRpc({ domain: 'search', method: 'query', payload }, context)
  }

  it('locally trusted: runs the desktop capabilities and carries the target home', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    const response = unwrap(await query({ query: 'Alpha', category: 'chats', limit: 5 }, IPC))
    expect(response.success).toBe(true)
    expect(response.results).toEqual([expect.objectContaining({
      id: 'chat:1',
      type: 'chat',
      title: 'Alpha',
      sessionId: '1',
      // S0 加的那一格,S2 由能力自己填(§4.1):壳按 kind 取渲染器。
      target: { kind: 'chat', payload: { sessionId: '1' } },
    })])
    // 单类档不带分组总览(§7.2)。
    expect(response.groups).toBeUndefined()
    expect(getSessionsList).toHaveBeenCalled()
  })

  it('locally trusted: an unknown category still falls back to "all" —— 但判据是注册表', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    const response = unwrap(await query({ query: 'x', category: 'nope' }, IPC))
    // `groups` 只在全部档出现,所以它就是「归到了 all」的判据(§7.2 / §8)。
    expect(Array.isArray(response.groups)).toBe(true)
    expect((response.groups as Array<{ capability: string }>).map(group => group.capability))
      .toContain('chats')
  })

  it('B2: a trusted http caller gets the very same answer as ipc, and the port is never asked', async () => {
    const portQuery = vi.fn(async () => ({ success: true, results: [{ id: 'sandboxed' }] }))
    restorePort = configureServerSearchPort({ query: portQuery })
    configureHostLocalTrust({ origin: 'desktop-embedded' })

    const overHttp = unwrap(await query({ query: 'Alpha', category: 'chats', limit: 5 }, HTTP))
    const overIpc = unwrap(await query({ query: 'Alpha', category: 'chats', limit: 5 }, IPC))
    expect(overHttp).toEqual(overIpc)
    expect(portQuery).not.toHaveBeenCalled()
    expect(getSessionsList).toHaveBeenCalled()
  })

  it('capabilities: 问的是注册表,不是一张写死的清单(S0 那张手抄的 manifest 已删)', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    const response = unwrap(await dispatchRpc(
      { domain: 'search', method: 'capabilities', payload: {} }, IPC))
    const manifests = response.capabilities as Array<Record<string, unknown>>
    expect(manifests.map(manifest => manifest.id))
      .toEqual(['chats', 'prompts', 'daily', 'files', 'messages', 'actions'])
    // 意图前缀由能力自报(§6.1);core 与契约里都没有 `/` `>` 这两个字面量。
    expect(manifests.find(manifest => manifest.id === 'actions')?.intentPrefixes).toEqual(['/', '>'])
  })

  /**
   * `status` —— S3b 起是**真读数**。S2 那时它是三个常量;换成索引之后它读的是索引
   * 的状态,壳那条「索引更新中」于是说的是真话。反证:把 `status()` 改回常量,
   * `pending` 这一格立刻红。
   */
  it('status: 真读数,不是 S2 那三个常量', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    const response = unwrap(await dispatchRpc(
      { domain: 'search', method: 'status', payload: {} }, IPC))
    expect(response).toEqual({
      mode: 'owner', pending: 2, docs: 12,
      // S7 起 status 多三格:开关的状态 / 欠嵌的份数 / 扩展装不装得上。
      vector: 'off', vectorPending: 0, vectorExtension: 'missing',
    })
  })

  /**
   * `preview` —— S4a 起是**真件**(设计 §4.5)。这里钉的是**域**这一层:信封对不对、
   * 载荷有没有原样过去、算不出那次说的是不是原话。载荷长什么样是能力的事,由
   * `runtime/src/search/__tests__/preview.test.ts` 逐格守着。
   *
   * 反证:把 handler 改回「S4 才有」那句常量,这三条当场红。
   */
  it('preview: 真件,载荷原样过信封', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    const response = unwrap(await dispatchRpc({
      domain: 'search',
      method: 'preview',
      payload: { items: [{ capability: 'chats', id: 'chat:1', target: { kind: 'chat', payload: { sessionId: '1' } } }] },
    }, IPC))

    expect(response.success).toBe(true)
    const preview = response.preview as { kind: string; payload: { sessionId: string } }
    expect(preview.kind).toBe('session-overview')
    // `payload` 是**开放**的:域这一层不解释它,原样搬过来。
    expect(preview.payload.sessionId).toBe('1')
  })

  it('preview: 算不出说原话,不是一句通用的「预览失败」', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    const response = unwrap(await dispatchRpc({
      domain: 'search',
      method: 'preview',
      payload: { items: [{ capability: '并不存在', id: 'x' }] },
    }, IPC))

    expect(response).toEqual({ success: false, error: 'no such capability: 并不存在' })
  })

  it('invoke: 接通了,但本批没有能力声明动作 —— 恒答 no such action', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    const response = unwrap(await dispatchRpc({
      domain: 'search',
      method: 'invoke',
      payload: { capability: 'chats', actionId: 'archive', items: [] },
    }, IPC))

    expect(response).toEqual({ success: false, error: 'no such action' })
  })

  it('query 的响应上带 index 那一格:壳读它画「索引还在追账本」', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    const response = unwrap(await query({ query: 'Alpha', category: 'chats', limit: 5 }, IPC))
    // `stale` = 队列里还欠着钥匙 或 启动校对还在跑;替身答的 pending 是 2。
    expect(response.index).toEqual({ pending: 2, stale: true })
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
    expect(getSessionsList).not.toHaveBeenCalled()
  })

  it('untrusted http without a server runtime: structured failure, not a silent desktop search', async () => {
    const response = await query({ query: 'Alpha', category: 'chats' }, HTTP)
    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error.message).toBe(missingError)
    expect(getSessionsList).not.toHaveBeenCalled()
  })
})

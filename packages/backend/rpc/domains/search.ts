/**
 * search(Search Everywhere 的**数据面**)域 —— 结构债 P4 终态批 A1-b(2026-08-23)。
 *
 * 一条 `query`。它是 A1-a 判定留下的那条:处理者一行 electron 都不碰,所以它不该
 * 去宿主壳路由,该去这里。搬完之后 `IPC_CHANNELS.SEARCH_QUERY` 那条常量、
 * `apps/electron/src/search/ipc.ts` 里那条手写 handler、`POST /api/search/query`
 * 那条 REST 路由与 `RuntimeSearchAdapter.query` 一起消失。
 *
 * ## 按 `context.transport` 分叉(#19 的判例,同 files / tools / mcp)
 *
 * 两个宿主查的是**同一件事的两个口径**,不是一件事的两份实现:
 *  - `ipc`(桌面)= `wiring/search/providers` 的 `executeSearch` —— 整台机器上那份
 *    会话 / 文件 / 提示词表。逐字沿用迁移前 `apps/electron/src/search/ipc.ts`
 *    那条 handler(连 `executeOnethingSearchForIpc` 这层归一化都是同一个)。
 *  - `http`(server)= per-owner 沙箱里的同一件事。实现没搬家,还在
 *    `server/runtime.ts` 的装配闭包里;这里经 `server/search-providers.ts` 那个
 *    单槽端口调它 —— 装的就是从前 `POST /api/search/query` 背后的同一个闭包。
 *
 * server 运行时不在场(CLI daemon / 单元测试里的 http 上下文)时**结构化拒绝**,
 * 不偷偷降级去查桌面那份:那会让一个网络调用者读到宿主机器上**别人**的会话。
 *
 * `executeAction` 不在这个域里 —— 它整件事都是窗口活(关搜索窗、找主窗、送
 * actionId、聚焦),在 A1-a 的 `searchWindowRouter` 上;server 那侧的
 * `POST /api/search/actions` 也因此留着。`SEARCH_ACTION` 是推送,同理不在。
 */
import {
  executeOnethingSearchForIpc,
  type OnethingSearchRequest,
} from '@onething/runtime/search'
import { executeSearch } from '../../wiring/search/providers.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import {
  searchRouter,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
  type SearchRoutes,
} from '@shared/ipc/search.js'
import { getServerSearchPort } from '../../server/search-providers.js'
import { registerRouterHandlers, type RpcRouteHandlers } from '../registry.js'

/**
 * http 上这台进程没有 server 运行时时的那一句。
 *
 * `SearchResponse` 上没有 `error` 这一格(迁移前的 wire 形状,本批不改),所以这条
 * **抛**出去、由 `dispatchRpc` 折成 `{ ok:false, error }` —— 与迁移前那条路由的
 * `sendNotImplemented('search.query')` 同义(一个失败的答复,不是一份空结果)。
 */
export const SEARCH_SERVER_RUNTIME_MISSING_ERROR =
  'Search is not available on this host'

/** server 那侧的请求上下文 —— 由宿主铸的 dispatch context 转成(同 plugins 判例)。 */
function runtimeContext(context: RpcDispatchContext) {
  if (context.ownerUid === undefined || context.workspaceId === undefined) return undefined
  return { userId: context.ownerUid, workspaceId: context.workspaceId }
}

export const searchRpcHandlers: RpcRouteHandlers<SearchRoutes> = {
  async query(request: SearchRequest, context = DESKTOP_RPC_CONTEXT): Promise<SearchResponse> {
    if (context.transport === 'http') {
      const port = getServerSearchPort()
      if (!port) throw new Error(SEARCH_SERVER_RUNTIME_MISSING_ERROR)
      return await port.query(request, runtimeContext(context)) as SearchResponse
    }
    return executeOnethingSearchForIpc<SearchResult>({
      request: request as OnethingSearchRequest,
      executeSearch,
    })
  },
}

export function registerSearchRpcDomain(): () => void {
  return registerRouterHandlers(searchRouter, searchRpcHandlers)
}

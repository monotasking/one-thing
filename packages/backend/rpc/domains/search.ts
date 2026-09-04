/**
 * search(Search Everywhere 的**数据面**)域 —— 结构债 P4 终态批 A1-b(2026-08-23)。
 *
 * 一条 `query`。它是 A1-a 判定留下的那条:处理者一行 electron 都不碰,所以它不该
 * 去宿主壳路由,该去这里。搬完之后 `IPC_CHANNELS.SEARCH_QUERY` 那条常量、
 * `apps/electron/src/search/ipc.ts` 里那条手写 handler、`POST /api/search/query`
 * 那条 REST 路由与 `RuntimeSearchAdapter.query` 一起消失。
 *
 * ## 按**本机可信**分叉(B2;此前问的是 `context.transport`)
 *
 * 两个宿主查的是**同一件事的两个口径**,不是一件事的两份实现:
 *  - **本机可信**(桌面 IPC / 桌面内嵌 HTTP 面 / 回环 `server:start`)=
 *    `wiring/search/providers` 的 `executeSearch` —— 整台机器上那份会话 / 文件 /
 *    提示词表。逐字沿用迁移前 `apps/electron/src/search/ipc.ts` 那条 handler
 *    (连 `executeOnethingSearchForIpc` 这层归一化都是同一个)。
 *  - **不可信**(独立部署的 server)= per-owner 沙箱里的同一件事。实现没搬家,
 *    还在 `server/runtime.ts` 的装配闭包里;这里经 `server/search-providers.ts`
 *    那个单槽端口调它 —— 装的就是从前 `POST /api/search/query` 背后的同一个闭包。
 *
 * B2 之前判据是 `transport === 'http'`,于是桌面自己那只内嵌面被当成"别人的
 * 机器",Search Everywhere 在 React 壳上查的是那棵空的 per-owner 树。判据换成
 * `isHostLocallyTrusted()`(`server/host-trust.ts`)之后,本机那几只面与桌面
 * IPC 查的是同一份;独立部署的 server 逐字不变。
 *
 * 不可信而 server 运行时又不在场(CLI daemon / 单元测试)时**结构化拒绝**,
 * 不偷偷降级去查桌面那份:那会让一个网络调用者读到宿主机器上**别人**的会话。
 *
 * `executeAction` 不在这个域里 —— 它整件事都是窗口活(关搜索窗、找主窗、送
 * actionId、聚焦),在 A1-a 的 `searchWindowRouter` 上;server 那侧的
 * `POST /api/search/actions` 也因此留着。`SEARCH_ACTION` 是推送,同理不在。
 */
import type { CapabilityManifest } from '@onething/core/search'
import {
  getOnethingSearchServiceSafe,
  type OnethingSearchService,
  type SearchServiceRequest,
} from '@onething/runtime/search'
import { isHostLocallyTrusted } from '../../server/host-trust.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import type {
  SearchCapabilitiesRequest,
  SearchCapabilitiesResponse,
  SearchCapabilityManifestDto,
  SearchInvokeRequest,
  SearchInvokeResponse,
  SearchPreviewRequest,
  SearchPreviewResponse,
  SearchRequest,
  SearchResponse,
  SearchRoutes,
  SearchStatusResponse,
} from '@shared/ipc/search.js'
import { getServerSearchPort } from '../../server/search-providers.js'
import type { RpcRouteHandlers } from '../registry.js'

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

/**
 * ── 四条新路由(检索重建 S0 立形、S2 接上真件,`docs/design/search-index-2026-09.md` §8/§10)──
 *
 *  - `capabilities` —— **问注册表**:`service.capabilities(surface)`。S0 那张手抄的
 *    六份 manifest(`S0_CAPABILITY_MANIFESTS`)整段删掉了 —— 它当时的作用就是先立形,
 *    形一接上真件就该消失,不然它会变成第二张写死的清单。
 *  - `query` —— 走 `SearchService`(注册表 + 流水线)。S2 的判据是**行为零变化**:
 *    `search:parity-A` 对每一类 + `all` 拿真库跑 200 条查询,新旧 `results` 逐字节同。
 *  - `preview` / `invoke` —— 仍然结构化地说「S4 才有」。能力接口上那两格
 *    (`SearchCapability.preview` / `.invoke`)S2 一个实现都还没有。
 *  - `status` —— `service.status()`。**S3b 起是真读数**:`mode` 由索引 Worker 的
 *    宿主答(连崩两次 → `'error'`,这台机器上根本没起索引也是 `'error'`),
 *    `pending` 是队列里还欠着的钥匙数。`'reader'` 等 §5.6,`vector` 等 §15。
 *
 * ## 本机可信那条分叉一字未动(B2)
 *
 * 换的只是「可信这一支去调谁」:从前是 `wiring/search/providers` 的 `executeSearch`,
 * 现在是同一份取材面装起来的 `SearchService`。不可信那一支照旧走
 * `server/search-providers.ts` 的单槽端口(server 运行时在自己的闭包里按 owner
 * 装一份服务),端口不在场时**结构化拒绝**,不偷偷降级去查桌面那份。
 */

/** S4 之前 `preview` / `invoke` 的那一句;两条路由同一份措辞。 */
const SEARCH_NOT_IMPLEMENTED_UNTIL_S4 = 'not implemented until S4'

/** 这台进程装配过 backend 就有;没有 = 调用方问错了地方,结构化拒绝而不是空结果。 */
export const SEARCH_SERVICE_MISSING_ERROR = 'Search is not assembled on this host'

function requireSearchService(): OnethingSearchService {
  const service = getOnethingSearchServiceSafe()
  if (service === null) throw new Error(SEARCH_SERVICE_MISSING_ERROR)
  return service
}

/**
 * core 的 manifest → 线上形(§8 那两份「同形不同命」的投影)。
 * `visibility` / `schema` / `ranking` / `relax` / `retrievers` 是**不出进程**的格,
 * 所以这里逐格挑,不 spread。
 */
function manifestDto(manifest: CapabilityManifest): SearchCapabilityManifestDto {
  return {
    id: manifest.id,
    labelKey: manifest.labelKey,
    icon: manifest.icon,
    kind: manifest.kind,
    intentPrefixes: manifest.intentPrefixes,
    budget: {
      default: manifest.budget.default,
      timeoutMs: manifest.budget.timeoutMs,
      whenIntent: manifest.budget.whenIntent,
    },
    facets: manifest.facets,
    order: manifest.order,
    orderWhenIntent: manifest.orderWhenIntent,
    surfaces: manifest.surfaces,
    preview: manifest.preview,
  }
}

export const searchRpcHandlers: RpcRouteHandlers<SearchRoutes> = {
  async query(request: SearchRequest, context = DESKTOP_RPC_CONTEXT): Promise<SearchResponse> {
    if (!isHostLocallyTrusted()) {
      const port = getServerSearchPort()
      if (!port) throw new Error(SEARCH_SERVER_RUNTIME_MISSING_ERROR)
      return await port.query(request, runtimeContext(context)) as SearchResponse
    }
    const response = await requireSearchService().query(
      request as SearchServiceRequest,
      // 「谁在问」由宿主铸的 dispatch context 造,永远不从信封上读(§6.4b + RPC 判例)。
      { principal: { kind: 'user', id: context.ownerUid ?? 'local' }, spaceId: context.workspaceId ?? '' },
    )
    return response as SearchResponse
  },

  async capabilities(request: SearchCapabilitiesRequest): Promise<SearchCapabilitiesResponse> {
    // 「只要这个面上的」由 manifest 的 `surfaces` 说了算(缺席 = 全部),判据不在这里。
    return {
      success: true,
      capabilities: requireSearchService().capabilities(request?.surface).map(manifestDto),
    }
  },

  async preview(request: SearchPreviewRequest): Promise<SearchPreviewResponse> {
    void request
    return { success: false, error: SEARCH_NOT_IMPLEMENTED_UNTIL_S4 }
  },

  async invoke(request: SearchInvokeRequest): Promise<SearchInvokeResponse> {
    void request
    return { success: false, error: SEARCH_NOT_IMPLEMENTED_UNTIL_S4 }
  },

  async status(): Promise<SearchStatusResponse> {
    return await requireSearchService().status()
  },
}

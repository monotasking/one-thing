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
import {
  executeOnethingSearchForIpc,
  type OnethingSearchRequest,
} from '@onething/runtime/search'
import { executeSearch } from '../../wiring/search/providers.js'
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
  SearchResult,
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
 * ── S0 的四条新路由(检索重建,`docs/design/search-index-2026-09.md` §8/§10)────────
 *
 * 契约上先立形、后端**先给一个诚实的答复**:形立在 S0,是为了让 S2 起壳与索引都从
 * 这四条路由读,而不是各自再长一份写死的表。今天它们答的是:
 *
 *  - `capabilities` —— 从**今天那张写死的清单**(`ONETHING_SEARCH_CATEGORIES` 减掉
 *    `'all'`)生成六份最小 manifest,配额与次序逐个抄自今天 `all` 档那段代码
 *    (`runtime/src/search/search-runtime.ts` 的 `case 'all'`)。**S2 换成注册表**:
 *    那时这个函数整段删掉,改成 `registry.list().map(cap => cap.manifest)`。
 *  - `preview` / `invoke` —— 结构化地说「S4 才有」。不抛异常:壳拿到的是一个
 *    `success:false` 的答复,而不是一条红色的传输错误。
 *  - `status` —— 恒 `{ mode:'owner', pending:0, vector:'off' }`。`mode` 那一格来自
 *    §5.6 的索引持有权,09-04 用户裁「先不做」,所以 S3 之前它只有一个取值;
 *    `pending` 要等 S3 的 `LedgerFeed` 才有真数;`vector` 要等 S7。
 *
 * `query` 一字不变 —— S2 的对账门要求新旧结果逐字同。
 */

/**
 * 今天六类的最小自述。
 *
 * 每一格的出处:
 *  - `id` = 今天的 `OnethingSearchCategory`(减 `'all'`,`'all'` 不是能力、是档);
 *  - `budget.default` = 今天 `all` 档给这一类的条数;`actions` 的 `whenIntent.command`
 *    = 今天那句 `isOnethingCommandSearchQuery(query) ? 8 : 4`;
 *  - `order` / `orderWhenIntent.command` = 今天那两条拼接次序的下标;
 *  - `kind` 说的是**今天**:六类里没有一类走索引(病根就是这个),所以四类 `scan`、
 *    两类 `static`。S3 把 messages / chats / daily 翻成 `indexed`。
 *  - `budget.timeoutMs` 是 S2 起要执行的预算,**不是**对今天行为的描述 —— 今天这条
 *    路上一处超时都没有。
 *  - `icon` 取壳的图标注册表 `apps/desktop-react/src/components/icons.ts` 里已有的键。
 */
const S0_CAPABILITY_MANIFESTS: readonly SearchCapabilityManifestDto[] = Object.freeze([
  {
    id: 'chats',
    labelKey: 'search.capability.chats',
    icon: 'MessageSquare',
    kind: 'scan',
    budget: { default: 6, timeoutMs: 2000 },
    order: 1,
    orderWhenIntent: { command: 3 },
  },
  {
    id: 'prompts',
    labelKey: 'search.capability.prompts',
    icon: 'Pencil',
    kind: 'static',
    budget: { default: 6, timeoutMs: 2000 },
    order: 2,
    orderWhenIntent: { command: 2 },
  },
  {
    id: 'daily',
    labelKey: 'search.capability.daily',
    icon: 'FileText',
    kind: 'scan',
    budget: { default: 6, timeoutMs: 2000 },
    order: 3,
    orderWhenIntent: { command: 4 },
  },
  {
    id: 'files',
    labelKey: 'search.capability.files',
    icon: 'FolderTree',
    kind: 'scan',
    budget: { default: 10, timeoutMs: 2000 },
    order: 4,
    orderWhenIntent: { command: 5 },
  },
  {
    id: 'messages',
    labelKey: 'search.capability.messages',
    icon: 'MessagesSquare',
    kind: 'scan',
    budget: { default: 5, timeoutMs: 2000 },
    order: 5,
    orderWhenIntent: { command: 6 },
  },
  {
    id: 'actions',
    labelKey: 'search.capability.actions',
    icon: 'Zap',
    kind: 'static',
    intentPrefixes: ['/', '>'],
    budget: { default: 4, timeoutMs: 2000, whenIntent: { command: 8 } },
    order: 6,
    orderWhenIntent: { command: 1 },
  },
] satisfies SearchCapabilityManifestDto[])

/** S4 之前 `preview` / `invoke` 的那一句;两条路由同一份措辞。 */
const SEARCH_NOT_IMPLEMENTED_UNTIL_S4 = 'not implemented until S4'

export const searchRpcHandlers: RpcRouteHandlers<SearchRoutes> = {
  async query(request: SearchRequest, context = DESKTOP_RPC_CONTEXT): Promise<SearchResponse> {
    if (!isHostLocallyTrusted()) {
      const port = getServerSearchPort()
      if (!port) throw new Error(SEARCH_SERVER_RUNTIME_MISSING_ERROR)
      return await port.query(request, runtimeContext(context)) as SearchResponse
    }
    return executeOnethingSearchForIpc<SearchResult>({
      request: request as OnethingSearchRequest,
      executeSearch,
    })
  },

  async capabilities(request: SearchCapabilitiesRequest): Promise<SearchCapabilitiesResponse> {
    // `surfaces` 今天一条都没声明,所以「只要这个面上的」= 全给(缺席 = 全部)。
    // S2 起这里改成 `registry.list()` 再按 manifest.surfaces 过滤 —— 判据在 manifest 上,
    // 不在这个 handler 里。
    void request
    return { success: true, capabilities: [...S0_CAPABILITY_MANIFESTS] }
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
    return { mode: 'owner', pending: 0, vector: 'off' }
  },
}


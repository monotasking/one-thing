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
 *  - **本机可信**(桌面 IPC / 桌面内嵌 HTTP 面 / 回环 `server:start`)= 这台进程
 *    装配的那份 `SearchService`(注册表 + 流水线 + store 级索引)—— 整台机器上那份
 *    会话 / 文件 / 提示词表。
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
import type { CapabilityManifest, PreviewPayload } from '@onething/core/search'
import {
  NoPreviewError,
  PreviewUnavailableError,
  getOnethingSearchServiceSafe,
  type OnethingSearchService,
  type SearchPreviewItem,
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
  SearchModelResponse,
  SearchPreviewPayload,
  SearchPreviewRequest,
  SearchPreviewResponse,
  SearchRequest,
  SearchResponse,
  SearchRoutes,
  SearchStatusResponse,
  SearchStorageResponse,
} from '@shared/ipc/search.js'
import { getServerSearchPort } from '../../server/search-providers.js'
import { requestSessionOwner } from '../../session/access.js'
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
 *  - `query` —— 走 `SearchService`(注册表 + 流水线 + S3 起的索引)。S2 换路时的判据
 *    是**行为零变化**,由 `search:parity-A` 拿真库跑 200 条查询逐字节对过;那道门与
 *    `search:parity-B` 在 S5 随旧扫描路一起退役(参照物没了),守过的东西改由
 *    `runtime/src/search/__tests__/golden-snapshot.test.ts` 的严格档命中集快照守。
 *  - `preview` / `invoke` —— **S4a 起是真件**,走 `SearchService.preview / .invoke`。
 *    四个内置能力实现了 `preview`(messages / daily / files 是 lazy,chats 是 inline
 *    并随候选带在 `SearchResult.preview` 上);`invoke` 接通了但**本批没有任何能力
 *    声明动作**,所以它恒答 `no such action` —— 接通的理由是动作的落点从此在能力
 *    自己身上,加一个动作不用改这里,也不用改壳。
 *  - `status` —— `service.status()`。**S3b 起是真读数**:`mode` 由索引 Worker 的
 *    宿主答(连崩两次 → `'error'`,这台机器上根本没起索引也是 `'error'`),
 *    `pending` 是队列里还欠着的钥匙数。`'reader'` 等 §5.6,`vector` 等 §15。
 *
 * ## 本机可信那条分叉一字未动(B2)
 *
 * 换的只是「可信这一支去调谁」:S2 之前是旧扫描路那条 `switch(category)`,
 * 现在是同一份取材面装起来的 `SearchService`(S5 已删旧路)。不可信那一支照旧走
 * `server/search-providers.ts` 的单槽端口(server 运行时在自己的闭包里按 owner
 * 装一份服务),端口不在场时**结构化拒绝**,不偷偷降级去查桌面那份。
 */

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
    browse: manifest.browse,
  }
}

/**
 * core 的 `PreviewPayload` → 线上形(与 `manifestDto` 同一条判例:两份同形不同命,
 * 由这里一个纯函数投影)。
 *
 * `payload` 原样过 —— 它是**开放**的,契约层与这里都不解释它。要投影的只有
 * `actions` 那一格,因为两份的动作描述**真的不同形**:core 那份是
 * `{ id, kind, label?, danger?, payload? }`(`kind` 是「这是开还是拷还是续搜」,
 * `payload` 是续搜的那个 SearchScope),契约那份是 `{ id, labelKey, icon?, danger? }`
 * (壳要的是「拿什么键去查字典、画哪个图标」)。
 *
 * **留账(S4b 要接的口)**:`kind` 与 `payload` 这一趟**过不去** —— 契约上没有那两格。
 * 今天不可观测(本批没有任何能力声明动作,`actions` 恒缺席),但真要做「结果上的
 * 动作」时,契约得先补这两格,否则壳收到一个动作却不知道按下去该干什么。
 * 这里不偷偷把 `kind` 塞进 `id` 里凑合。
 */
function previewDto(preview: PreviewPayload): SearchPreviewPayload {
  const actions = preview.actions?.map(action => ({
    id: action.id,
    // core 那份的 `label` 是**成品文案**(能力自己写的字);契约那格叫 `labelKey`
    // 是因为壳要查字典。新代码填 `labelKey`,`label` 是旧读者的退路,再退到 id ——
    // 画一个 id 比画一个空按钮诚实。
    labelKey: action.labelKey ?? action.label ?? action.id,
    ...(action.danger === undefined ? {} : { danger: action.danger }),
    // S4a 那条留账(「`kind` 与 `payload` 这一趟过不去」)在检索面终稿 §4 补上了
    // 契约,于是这里照搬 —— 不再把 kind 塞进 id 里凑合。
    ...(action.capability === undefined ? {} : { capability: action.capability }),
    ...(action.kind === undefined ? {} : { kind: action.kind }),
    ...(action.payload === undefined ? {} : { payload: action.payload }),
    ...(action.params === undefined ? {} : { params: action.params }),
  }))
  return {
    kind: preview.kind,
    payload: preview.payload,
    ...(preview.title === undefined ? {} : { title: preview.title }),
    ...(actions === undefined ? {} : { actions }),
  }
}

/**
 * 预览失败 → 一个**码**(契约 `SearchPreviewResponse.reason`;检索面终稿 R6)。
 *
 * 只认类型不认文案:`NoPreviewError` = 这个能力自述里就没有预览(调用方问错了
 * 地方,壳画「行的放大版」);`PreviewUnavailableError` = 有预览但这一条算不出
 * (账本里没这条了 / 读不到那个文件),壳画那句字典化的「预览不可用」。
 * 认不出的错**不归码** —— 缺席 = 「这次失败还没有归到码上」,而不是硬塞一个。
 */
function previewFailureReason(error: unknown): SearchPreviewResponse['reason'] {
  if (error instanceof NoPreviewError) return 'no-preview'
  if (error instanceof PreviewUnavailableError) return 'gone'
  return undefined
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
      {
        // 「谁在问」由宿主铸的 dispatch context 造,永远不从信封上读(§6.4b + RPC 判例)。
        principal: { kind: 'user', id: requestSessionOwner(context).userId! },
        executionContext: requestSessionOwner(context),
        /*
         * **「还要不要」也由宿主说**(09-07 事故第四条修)。壳换词 / 清词时
         * abort 那一发 fetch,HTTP 面据此喊停,这条信号一路传到 `fanout` 派生的
         * 那条上,扫盘那一路收到就把它起的 `rg` 杀掉。宿主给不出观察(IPC 直调、
         * 单测)时这一格缺席,`createSearchContext` 照旧兜一条永不 abort 的 ——
         * 与从前逐字相同。
         */
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
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

  /**
   * 选中一条(或几条)时的富预览(§4.5)。S4a 起是真件。
   *
   * 这个 handler 的全部工作是**翻译 + 兜错**:请求里的 `items` 与服务层的
   * `SearchPreviewItem` 同形(两份同形不同命,与 manifest 那两份是同一条判例),
   * 基数原样交给服务层判。这里**不认识任何一个 `kind`** —— 载荷是什么形状由能力说,
   * 壳按 `kind` 从预览渲染注册表取组件。
   *
   * 算不出的那次**说原话**(§4.5 ⑤:「error(原话),列表不受影响」)。所以这里
   * 捞的是 message 而不是换一句通用的「预览失败」:用户要能看出是「账本里没这条了」
   * 还是「读不到那个文件」。
   *
   * 本机可信那条分叉这里**没有** —— 与 `capabilities` / `status` 一样,`preview`
   * 问的是这台进程装配的那份服务。不可信那一支(独立 server)今天没有服务可问,
   * `requireSearchService()` 会结构化拒绝;给它接上是 server 端口的事(同 `query`),
   * 不是在这里偷偷去查桌面那一份。
   */
  async preview(request: SearchPreviewRequest, context = DESKTOP_RPC_CONTEXT): Promise<SearchPreviewResponse> {
    try {
      const preview = await requireSearchService().preview(
        request.items as readonly SearchPreviewItem[],
        request.mode,
        // 列表上那次查询的词(检索面终稿 §4):预览与列表的高亮走同一条判据。
        request.query === undefined ? {} : { query: request.query },
        { principal: { kind: 'user', id: requestSessionOwner(context).userId! }, executionContext: requestSessionOwner(context) },
      )
      return { success: true, preview: previewDto(preview) }
    } catch (error) {
      // **原话照旧交**(§4.5 ⑤),但另外归一个**码**:壳按码画字典句(R6),
      // 原话只进日志。归码这件事只看错误的**类型**,不去匹配文案 —— 拿字符串
      // 认错误是这个仓里立过案的病(判例「别拿报错串当根因」)。
      const reason = previewFailureReason(error)
      return {
        success: false,
        error: (error as Error).message,
        ...(reason === undefined ? {} : { reason }),
      }
    }
  },

  /**
   * 结果上的后端动作(§8)。S4a **接通**,但本批没有任何一个内置能力声明动作 ——
   * 所以今天它恒答 `no such action`,而那句话来自服务层的常量,不是这里编的。
   */
  async invoke(request: SearchInvokeRequest, context = DESKTOP_RPC_CONTEXT): Promise<SearchInvokeResponse> {
    try {
      await requireSearchService().invoke(
        request.capability,
        request.actionId,
        request.items as readonly SearchPreviewItem[],
        { principal: { kind: 'user', id: requestSessionOwner(context).userId! }, executionContext: requestSessionOwner(context) },
      )
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  },

  async status(): Promise<SearchStatusResponse> {
    return await requireSearchService().status()
  },

  /**
   * ── 嵌入模型的三个动作(2026-09-17,§15.8)──────────────────────────────
   *
   * 用户裁定「把开关和下载模型拆开」:模型从此是一件**独立的东西**,有自己的状态
   * 与动作,而不是「翻开关」的副作用。三条路由的落点都在
   * `OnethingSearchService.semanticModel` —— 那里问的是这台进程手上那份索引面,
   * 与 `status` 同一份(不是第二个产地)。
   *
   * **不按本机可信分叉**(与 `status` / `capabilities` 同):`query` 那条分叉存在的
   * 理由是「不可信调用者该看 per-owner 沙箱里的那一份」,而模型是 **store 级**的一份
   * 文件 —— 沙箱里没有第二份模型可言。留账:独立部署的 server 上,一个远端调用者
   * 能按下这颗「下载」;今天它与「能读 `status`」同权,真要收紧就得先给
   * `server/search-providers.ts` 那个端口补上这三口。
   *
   * 失败不抛,答 `{ success: false, error }`:`error` 是**码**(`model-in-use` 等),
   * 后端一个中文字不拼。
   */
  async semanticModelDownload(): Promise<SearchModelResponse> {
    return await runSemanticModelOp('download')
  },

  async semanticModelCancel(): Promise<SearchModelResponse> {
    return await runSemanticModelOp('cancel')
  },

  async semanticModelRemove(): Promise<SearchModelResponse> {
    return await runSemanticModelOp('remove')
  },

  /**
   * **检索占了多少地方**(2026-09-18,用户 09-17「我要知道搜索占得空间」)。
   *
   * 落点与 `status` 同一份(`OnethingSearchService` 手上那份索引面),所以这里
   * 与它一样**不按本机可信分叉**:它只读几个数字,而库是 **store 级**的一份文件 ——
   * per-owner 沙箱里没有第二个库可言。
   *
   * 量不出来就**抛**(这台进程没有索引),由 `dispatchRpc` 折成 `{ ok:false }` ——
   * 壳据此画「没量出来」。答一堆零会把「这台机器上没有这个库」画成「它是空的」。
   */
  async storage(): Promise<SearchStorageResponse> {
    return await requireSearchService().storage()
  },
}

async function runSemanticModelOp(op: 'download' | 'cancel' | 'remove'): Promise<SearchModelResponse> {
  try {
    return { success: true, model: await requireSearchService().semanticModel(op) }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

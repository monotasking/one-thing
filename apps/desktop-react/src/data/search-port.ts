import {
  searchRouter,
  type SearchCapabilityManifestDto,
  type SearchFilters,
  type SearchItemRef,
  type SearchPreviewPayload,
  type SearchPreviewResponse,
  type SearchResponse,
  type SearchStatusResponse,
} from '@shared/ipc/search'

/**
 * 跨会话**正文检索**与 core 的客户端(`@onething/client`)之间的那一层端口 —— 与
 * `data/files-port.ts` / `data/sessions-port.ts` 同一形状、同一理由:
 * 「哪些命中画得出来、怎么去重、怎么翻页」全是纯逻辑,不该为了测它去起一台 core。
 * 真实现是下面那一个,测试用 `configureSearchPort` 换成假的。
 *
 * ── 面上有几条,以及为什么(S4b:五条全开)──────────────────────────────
 * 后端契约(`@shared/ipc/search.ts` 的 `searchRouter`)有五条路由,这里现在五条
 * 全开:`query` / `capabilities` / `status` / `preview` / `invoke` 的前四条。
 *
 * **`queryMessages` 那条窄口没了**(S4b)。它当年在的理由是「壳对消息那一路另有
 * 一层当前空间投影与去重」—— 那层投影靠的是「拿屏幕上那张会话表去筛命中」,
 * 而 S4b 之后壳这一侧**不再有自己的会话表参与检索**:空间由 `filters.spaceId`
 * 这一格结构地说,由后端按 facet 筛。于是那条窄口与通用口问的是同一件事,
 * 两条并存就是同一个问题两个产地。
 *
 * `preview` 这一批才开,判据与当年 `query` 那条逐字同源:**有没有一个壳里能落地
 * 的消费者**。今天有了 —— 预览渲染注册表(`search/preview/`),一种载荷 kind 一个
 * 渲染器。`invoke` 仍然不开:没有一个能力声明动作,开一条恒答 `no such action`
 * 的口只会让人以为壳这边漏接了什么。
 *
 * ── 签名口径:位置参数进来,信封出去 ─────────────────────────────────────
 * 与 files-port 逐字同一体例:router 收对象,端口这一层收位置参数(它是给判据层
 * 用的窄面,不是给网线用的信封),真实现负责那一次包装。
 *
 * ── 返回值:后端契约原样,不在旁边立第二份形状 ───────────────────────────
 * 交出去的就是 `SearchResponse`(连 `groups` 一起)。壳侧那一层收窄(哪些行
 * **画得出来**)在 `search/transitions.ts` 的 `resultRows` 里做一次 ——
 * 端口不替它判。
 */
export interface SearchPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /**
   * **唯一的那一条查询**(S4b)。`category` 是能力 id 或 `'all'`;
   * `'all'` 那一档的回执带 `groups`(§7.2 的分组总览),单类档带 `total` / `cursor`。
   *
   * `limit` 是**这一次要多少条**;`filters` 是**结构**传的过滤条件(§9 第五条:
   * 不拼进查询串),键由各能力的 `manifest.facets` 声明,壳与契约都不解释它们。
   *
   * 回执**原样交出去**(`SearchResponse`),不在契约旁边立第二份形状。
   * `success:false` 不翻译成异常 —— 失败与「一条都没搜到」是两件事,消费方要靠
   * 这一格把它们分开说(判据在 `search-catalog-source.ts` 的 fetcher 里)。
   */
  query(
    query: string,
    category: string,
    limit: number,
    filters?: SearchFilters,
    /**
     * **上一页的游标**,原样回传(契约 `SearchRequest.cursor`,S3 起有值)。
     *
     * 这条口从前不递它,于是壳只能靠换整把查询键(把 `limit` 做大)去「翻页」——
     * 那正是「Load more 跳回顶部」的病根(检索面终稿 落差 #26)。端口这一层只负责
     * **递**:哪一块的游标、什么时候递,是数据层的判据。
     */
    cursor?: string,
    /**
     * **撤回这一发**(09-07 事故第四条修)。换词 / 清词时数据层拉它,
     * `@onething/client` 交给 `fetch`,HTTP 面据此铸出 `RpcDispatchContext.signal`,
     * 一路传到扫盘那一路手里 —— 那正是「清了输入框,`rg` 还在 462% CPU 上跑」
     * 缺的那条线。缺席 = 这一发送出去就等到底(与从前逐字相同)。
     */
    signal?: AbortSignal,
  ): Promise<SearchResponse>
  /** 有哪些能力(tab / 图标 / 次序 / 有哪几颗过滤片全从它算)。 */
  capabilities(surface?: string): Promise<SearchCapabilityManifestDto[]>
  /** 索引在干什么(底部那两行读数)。 */
  status(): Promise<SearchStatusResponse>
  /**
   * 选中一条(或几条)时的富预览(§4.5)。**S4b 才开** —— 判据与 `query` 当年
   * 那条逐字同源:壳里有了能落地的消费者(预览渲染注册表)才开这条口。
   *
   * `success:false` 时 `error` 是**后端的原话**(§4.5 ⑤「error(原话),列表不受
   * 影响」),端口原样交出去,不换成一句通用的「预览失败」。
   */
  preview(
    items: readonly SearchItemRef[],
    mode: 'single' | 'compare' | 'batch',
    /** 列表上那次查询的词 —— 预览与列表的高亮走同一条判据(契约 `SearchPreviewRequest.query`)。 */
    query?: string,
  ): Promise<{
    success: boolean
    preview?: SearchPreviewPayload
    error?: string
    reason?: SearchPreviewResponse['reason']
  }>
}

let port: SearchPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureSearchPort(next: SearchPort | undefined): void {
  port = next
}

/**
 * 真实现是**惰性**建的,理由与 files-port 逐字相同:它要的是那个连通之后才
 * 存在的客户端,而端口被换掉的测试根本不该把连通面拖进来
 * (默认假端口装在 `src/test/setup.ts` 里)。
 */
async function realPort(): Promise<SearchPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const searchApi = client.api(searchRouter)
  return {
    ready: () => whenConnected(),
    query: async (query, category, limit, filters, cursor, signal) => {
      const response = await searchApi.query(
        {
          query,
          category,
          limit,
          // 缺席与空表是两回事:一格过滤都没有时**不发这个键**,而不是发一个 `{}`
          // —— 后端那边 `filters: {}` 与缺席同义,但线上少一格总比多一格诚实。
          ...(filters === undefined || Object.keys(filters).length === 0 ? {} : { filters }),
          // 同一条判据:没有游标就不发这个键(缺席 = 从第一页起)。
          ...(cursor === undefined ? {} : { cursor }),
        },
        // 传输级那一格与载荷分开摆(`RouteCallOptions`):撤回不是查询条件。
        signal === undefined ? undefined : { signal },
      )
      return { ...response, results: response.results ?? [] }
    },
    preview: (items, mode, query) => searchApi.preview({
      items: [...items],
      mode,
      ...(query === undefined ? {} : { query }),
    }),
    capabilities: async surface => {
      const response = await searchApi.capabilities(surface === undefined ? {} : { surface })
      return response.capabilities ?? []
    },
    status: () => searchApi.status({}),
  }
}

let pending: Promise<SearchPort> | undefined

export function searchPort(): Promise<SearchPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}

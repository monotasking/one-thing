import {
  searchRouter,
  type SearchCapabilityManifestDto,
  type SearchResult,
  type SearchStatusResponse,
} from '@shared/ipc/search'

/**
 * 跨会话**正文检索**与 core 的客户端(`@onething/client`)之间的那一层端口 —— 与
 * `data/files-port.ts` / `data/sessions-port.ts` 同一形状、同一理由:
 * 「哪些命中画得出来、怎么去重、怎么翻页」全是纯逻辑,不该为了测它去起一台 core。
 * 真实现是下面那一个,测试用 `configureSearchPort` 换成假的。
 *
 * ── 面上有几条,以及为什么(S4a 之前只有一条)──────────────────────────
 * 后端契约(`@shared/ipc/search.ts` 的 `searchRouter`)有五条路由。这里开四条:
 * `queryMessages`(窄的那一条)/ `query`(通用)/ `capabilities` / `status`。
 * `preview` 与 `invoke` **本批不开** —— 预览窗是 S4b,没有消费者的口不该先开出来。
 *
 * S4a 之前这里**只有** `queryMessages`,判据写在下面那条口上:「要开第二档时,
 * 判据是**这一档有没有一个壳里能落地的目标**,不是『契约上有』」。今天那个落地口
 * 建成了 —— 目标渲染注册表(`search/targets/`),一种 `target.kind` 一个渲染器,
 * 点了去哪儿由它说。所以判据满足,`query` 才开。
 *
 * 三条**没有**被通用口吃掉的,理由逐条:
 *
 *  · `'chats'` 这一档壳里**已经有产地**(整张 `sessions.listMeta` 在手,即时滤),
 *    再从这条口要一次就是同一件事两个产地,迟早对不上(会话标题的高亮口径、
 *    空间投影、SSE 增量全在本地那一份上);
 *  · `'files'` 同理,文件侧走的是 `files.list`(`data/files-source.ts`);
 *  · `'messages'` 走的是上面那条**窄口**:壳这边另有一层当前空间投影与去重,
 *    换成通用路是一次可感知的行为变化(见 `search/sources.ts` 那张记账表)。
 *
 * 剩下的(`prompts` / `daily` / `actions`,以及任何一个插件能力)走通用口。
 *
 * ── 签名口径:位置参数进来,信封出去 ─────────────────────────────────────
 * 与 files-port 逐字同一体例:router 收对象,端口这一层收位置参数(它是给判据层
 * 用的窄面,不是给网线用的信封),真实现负责那一次包装。
 *
 * ── 返回值:后端契约原样,不在旁边立第二份形状 ───────────────────────────
 * 交出去的就是 `SearchResult[]`。壳侧那一层收窄(哪些行**能落地**)在
 * `data/message-search-source.ts` 里做一次,理由写在那儿 —— 端口不替它判。
 */
export interface SearchPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /**
   * 跨会话搜消息正文。`limit` 是**这一次要多少条**:分页靠它递增
   * (后端这一条没有游标、也不下发总数 —— 判据与代价写在
   * `search/transitions.ts` 的「分页」一节)。
   *
   * `success:false` 时 `results` 是空表 —— 端口不把它翻译成异常:失败与空是
   * 两件事,而消费方要靠这一格把它们分开说(见 message-search-source 的 fetcher)。
   */
  queryMessages(query: string, limit: number): Promise<{ success: boolean; results: SearchResult[] }>
  /**
   * **通用的那一档**(S4a):壳没有自带产地的能力走它(`prompts` / `daily` /
   * `actions`,以及将来任何一个插件能力)。
   *
   * 上面 `queryMessages` 那条口的注释说「只开 messages 那一档,要开第二档时判据是
   * 『这一档有没有一个壳里能落地的目标』」—— **今天有了**:目标渲染注册表
   * (`search/targets/`)就是那个落地口,一种 kind 一个渲染器,点了去哪儿由它说。
   * 所以判据满足了,这条口才开;它不是绕过那条判据,是那条判据的结论。
   *
   * `queryMessages` 没有被它吃掉:那一路壳这边另有一层「当前空间投影」与去重
   * (见 `message-search-source.ts` 的 `toHits` 与 `transitions.ts` 的 `coversPreview`),
   * 换成通用路会是一次可感知的行为变化。两条口并存是**记账**,不是重复。
   */
  query(query: string, category: string, limit: number): Promise<{ success: boolean; results: SearchResult[]; total?: number; cursor?: string; relaxed?: number; index?: { pending: number; stale: boolean } }>
  /** 有哪些能力(tab / 图标 / 次序全从它算)。 */
  capabilities(surface?: string): Promise<SearchCapabilityManifestDto[]>
  /** 索引在干什么(底部那两行读数)。 */
  status(): Promise<SearchStatusResponse>
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
    queryMessages: async (query, limit) => {
      const response = await searchApi.query({ query, category: 'messages', limit })
      return { success: response.success, results: response.results ?? [] }
    },
    query: async (query, category, limit) => {
      const response = await searchApi.query({ query, category, limit })
      return { ...response, results: response.results ?? [] }
    },
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

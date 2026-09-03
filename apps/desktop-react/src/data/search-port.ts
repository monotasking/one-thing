import { searchRouter, type SearchResult } from '@shared/ipc/search'

/**
 * 跨会话**正文检索**与 core 的客户端(`@onething/client`)之间的那一层端口 —— 与
 * `data/files-port.ts` / `data/sessions-port.ts` 同一形状、同一理由:
 * 「哪些命中画得出来、怎么去重、怎么翻页」全是纯逻辑,不该为了测它去起一台 core。
 * 真实现是下面那一个,测试用 `configureSearchPort` 换成假的。
 *
 * ── 面上只有一条,而且是窄的那一条 ────────────────────────────────────────
 * 后端契约(`@shared/ipc/search.ts` 的 `searchRouter`)只有一个 `query`,
 * 收 `{query, category, limit}`。这里**只开 `category: 'messages'` 那一档**,
 * 而且把它写成方法名 —— 不是图省事,是划边界:
 *
 *  · `'chats'` 这一档壳里**已经有产地**(整张 `sessions.listMeta` 在手,即时滤),
 *    再从这条口要一次就是同一件事两个产地,迟早对不上(会话标题的高亮口径、
 *    空间投影、SSE 增量全在本地那一份上);
 *  · `'files'` 同理,文件侧走的是 `files.list`(`data/files-source.ts`);
 *  · `'actions'` / `'prompts'` / `'daily'` 是**旧搜索窗**的产品面,新壳没有它们
 *    对应的落点(点了没地方去),开出来就是画一行按不动的结果;
 *  · `'all'` 是上面几档的拼盘,而且每一档的 limit 由后端写死(消息那一档只有 5),
 *    拿它当正文检索面就是把翻页交给一个不认识翻页的口。
 *
 * 要开第二档时,判据是「这一档有没有一个壳里**能落地**的目标」,不是「契约上有」。
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
  }
}

let pending: Promise<SearchPort> | undefined

export function searchPort(): Promise<SearchPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}

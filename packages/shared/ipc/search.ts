/**
 * Search Everywhere — shared types
 */
import { defineRouter } from './router.js'

/**
 * 能力 id 或 `'all'`(检索重建 S0,`docs/design/search-index-2026-09.md` §8)。
 *
 * 从前这里是 `OnethingSearchCategory` 那个**字面量联合** —— 联邦骨架下「能搜的
 * 东西」是注册表里的一行,契约层不该替它枚举:加一类不许改契约。所以类型放宽成
 * `string`,校验交给 registry(S2)。
 *
 * **S5(2026-09-05)起契约层连那张清单都不再转发**:`SEARCH_CATEGORIES` /
 * `isSearchCategory` 两个再导出随旧扫描路一起删了。「这个档认不认」的唯一产地是
 * `SearchService.query` 问注册表(`registry.has(id)`,不认识的归 `'all'`);
 * 壳要画哪几个 tab 问 `search.capabilities` 那条路由,不问一张常量表。
 */
export type SearchCategory = string

/**
 * 过滤片是**结构**传的,不是拼进查询串的(§9)。
 *
 * 键**开放**:每个键由某个能力的 `manifest.facets` 声明(spaceId / role / archived /
 * includeReasoning / touchedFile …),core 与契约都不解释它们,只按键透传。今天一个
 * 结构字段都还没有,所以这里只有索引签名 —— S2 起各能力自己声明。
 */
export interface SearchFilters {
  [key: string]: unknown
}

export interface SearchRequest {
  query: string
  /** 能力 id 或 `'all'`;不再是字面量联合(S0)。 */
  category: string
  limit?: number
  /** 不透明分页游标:上一页 `SearchResponse.cursor` 原样回传(S3 起有值)。 */
  cursor?: string
  filters?: SearchFilters
}

export interface SearchResult {
  id: string
  /**
   * 'plugin' 是搜索供给方(M2)贡献的结果。宿主据此按 provider label(`group`)
   * 分组渲染,点击只回到插件自己的 action(actionId 带 `plugin-search:` 前缀)——
   * 插件结果拿不到 sessionId / messageId / filePath,不能伪装成内置结果。
   */
  type: 'chat' | 'message' | 'action' | 'file' | 'daily' | 'prompt' | 'plugin'
  title: string
  subtitle?: string
  detail?: string
  sessionId?: string
  messageId?: string
  actionId?: string
  filePath?: string
  timestamp?: number
  shortcut?: string
  matchRanges?: Array<{ start: number; end: number }>
  /** 分组标签(M2 插件结果 = provider label)—— 让插件结果来源可辨。 */
  group?: string
  /** 宿主枚举图标名(M2 插件结果),不是 URL/SVG。 */
  icon?: string
  /**
   * 去哪儿(S0 加,§4.1 的 `Candidate.target`)——**开放**:形由能力定义,壳按
   * `kind` 从目标渲染注册表取组件。旧的 `sessionId` / `messageId` / `filePath`
   * 照旧填,所以 S4 之前的壳与 CLI 不改也能用。
   */
  target?: { kind: string; payload: unknown }
  /** 键由产它的能力 `manifest.facets` 声明;宿主不解释(S0 加)。 */
  facets?: Record<string, unknown>
  /**
   * **随候选带的预览**(S4a 加;§4.5 ①的 `mode: 'inline'`)。
   *
   * 只有自述里说了 `preview: { mode: 'inline' }` 的能力才会填这一格(今天是 `chats`)。
   * `lazy` 的能力这一格恒缺席 —— 壳选中之后走 `search.preview` 路由取。
   * 形与 `SearchPreviewPayload` 同,`kind` 一样是**开放**的:壳按它从预览渲染
   * 注册表取组件,契约层不解释。
   */
  preview?: SearchPreviewPayload
  /**
   * **这条摘要是从哪一段原文开的窗**(检索面终稿 §4;`apps/desktop-react/docs/search-panel-2026-09.md`)。
   *
   * `title` / `subtitle` 上的那串字往往只是正文的一扇窗。壳要画「…」、要「跳到原文」
   * 就得知道窗口在原文里的起点与两端截没截 —— 这三格就是 core 的 `Snippet` 已经
   * 算出来、从前没往外交的那三格。**缺席 = 那串字就是全文**(短标题、命令名、
   * 文件名),不是「不知道」。
   *
   * `matchRanges` 永远相对**屏上那串字**(窗口内坐标),不是原文坐标 —— 这一格
   * 不改变那条规矩,它只是让壳能补省略号并说得出「省掉的是哪一头」。
   */
  snippet?: { offset: number; truncatedStart: boolean; truncatedEnd: boolean }
  /**
   * **这条是哪一路召回的**(S7 的语义徽;缺席 = 不知道 / 这一类只有一路)。
   *
   * 壳按它在右列画一枚「语义」小徽 —— 说实话,不装成字面命中。判据在产它的能力
   * 那一侧(哪条召回器造的这枚候选),契约层只是搬运。
   */
  source?: 'lexical' | 'vector'
}

export interface SearchResponse {
  success: boolean
  /** 既有形一字不动:单类 = 本页;全部 = 各组拼接(保旧壳)。 */
  results: SearchResult[]
  /** 这一档一共多少条(不是本页条数)。缺席 = 不知道,壳就不许画「加载更多」。 */
  total?: number
  /** 有下一页时的不透明游标;缺席 = 到底了。 */
  cursor?: string
  /** 零命中后放宽了几级(0 = 没放宽);壳据此画「已放宽」行。 */
  relaxed?: 0 | 1 | 2 | 3
  /** 索引还在追账本吗(§5)。 */
  index?: { pending: number; stale: boolean }
  /**
   * **整发失败**的结构化说法(检索面终稿 §4)。`success:false` 只说了「没成」,
   * 说不出「为什么」;壳按这一格查字典画一句人话,**原话只进日志**。
   *
   * 与 `groups[].error` 是两件事:那一格说的是「某一类没搜成,别的类照旧」。
   */
  error?: string
  /**
   * **页级动作**(检索面终稿 §0 ③:「动作不是结果」)。
   *
   * 「新建提示词 “jira”」「新建今天的日记」这些从前混在 `results` 里冒充命中 ——
   * 占配额、计入 `total`、被当成一条搜到的东西。它们现在由能力自报在这一格上:
   * **不在 `results` 里、不计入任何 `total`**,壳把它们画在清单末尾的分隔线下。
   *
   * 缺席 = 这一次没有动作可做。旧壳不读这一格,于是它看见的只是「少了一行假结果」。
   */
  actions?: SearchActionDescriptor[]
  /**
   * **这一页只扫到一半**(09-07 事故第三条修)。
   *
   * 一路去枚举外部资源的能力(今天是 `files`)有预算;预算到点时它交**已经扫到的
   * 那些**并标这一格,而不是整发作废。壳据此在块尾画「已扫描的部分 · 未扫完」。
   * 缺席 = 这一页是完整的;旧壳不读它,看见的就是一页正常结果。
   */
  partial?: boolean
  /** `category: 'all'` 时的分组总览(§7.2);单类档缺席。 */
  groups?: Array<{
    capability: string
    label: string
    total?: number
    results: SearchResult[]
    error?: string
    /**
     * **这一块的下一页**(检索面终稿 §0 ②「每块自己原地续页」)。
     *
     * 全部档从前把各能力答的 `page.cursor` 整个丢掉,于是「加载更多」只能靠换整把
     * 查询键重发 —— 那正是「Load more 跳回顶部」的病根。这一格原样回传给
     * `SearchRequest.cursor` + 这一块的 `category`,就是那一块的第二页。
     *
     * 缺席 = 这一块取尽了。
     */
    cursor?: string
    /** 这一块零命中后放宽了几级(0 = 没放宽);壳按块画「已放宽」。 */
    relaxed?: 0 | 1 | 2 | 3
    /** 这一块自报的动作(同 `SearchResponse.actions`,只是归属到块)。 */
    actions?: SearchActionDescriptor[]
    /**
     * **这一块这一次没问**(09-07 事故第二条修)。
     *
     * 不挑那一档不等去外部枚举的那几路(自述 `kind: 'scan'`)——真机上一次
     * 「all」搜索因为文件那一路扎进 18GB 目录而**整发不回**,一个结果都没有。
     * 现在那一路在这一档里当场答一句「没问」,别的块照常上屏;调用方随即对这一档
     * 发一发单类请求把它补上(单类档照常真跑,那时用户要的就是它)。
     *
     * `results` 恒空、`total` 恒 0 —— 它们说的不是「一条都没有」而是「还没问」,
     * 这一格就是把这两件事分开的那一格。缺席 = 这一块问过了(旧壳看见的仍然是
     * 一个空组,与从前某一类零命中时逐字相同)。
     */
    deferred?: boolean
    /** 这一块只扫到一半(同 `SearchResponse.partial`,只是归属到块)。 */
    partial?: boolean
  }>
}

export interface SearchWindowSplitIntent {
  type: 'split-panel'
  panelId: string
}

export type SearchWindowIntent = SearchWindowSplitIntent

export interface SearchWindowOpenOptions {
  intent?: SearchWindowIntent
}

export interface SearchWindowShownPayload {
  intent?: SearchWindowIntent | null
}

/** Anchor rect reported by the main window renderer (CSS px, viewport-relative). */
export interface SearchWindowAnchor {
  x: number
  y: number
  width: number
  height: number
}

export interface SearchWindowGuideState {
  visible: boolean
  centerX: boolean
  defaultTop: boolean
  defaultHeight: boolean
  defaultBounds: boolean
}

/**
 * Search Everywhere 的**窗口面**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 四条走**宿主壳路由**(`shell:invoke`):开关搜索窗、报锚点矩形、以及「执行一条
 * 结果动作」—— 最后这条看着像数据面,其实整件事都是窗口活:关掉搜索窗、找到主窗、
 * 把 actionId 送进去、再把主窗聚焦。
 *
 * 查询**不在这张表上**,是刻意的:它的处理者一行 electron 都不 import(本机是
 * 进程里那份 `SearchService`,server 是同一件事的 per-owner 沙箱版),按判据它是
 * **数据面**。A1-b(2026-08-23)把它迁进了 `rpc:invoke` 的 backend `search` 域
 * (见本文件下方的 `searchRouter`),`SEARCH_QUERY` 那条常量随之删除。
 */
export interface SearchWindowResponse {
  success: boolean
}

export interface SearchWindowSetAnchorRequest {
  anchor: SearchWindowAnchor | null
}

export interface SearchExecuteActionRequest {
  actionId: string
}

export interface SearchExecuteActionResponse {
  success: boolean
  /** server 侧会把 `create-daily-note:` 解析成 `open-file:` 后回传。 */
  actionId?: string
  error?: string
}

export type SearchWindowRoutes = {
  toggle: { input: SearchWindowOpenOptions; output: SearchWindowResponse }
  close: { input: Record<string, never>; output: SearchWindowResponse }
  setAnchor: { input: SearchWindowSetAnchorRequest; output: SearchWindowResponse }
  executeAction: { input: SearchExecuteActionRequest; output: SearchExecuteActionResponse }
}

export const searchWindowRouter = defineRouter<SearchWindowRoutes>('search-window', [
  'toggle',
  'close',
  'setAnchor',
  'executeAction',
])

/**
 * Search Everywhere 的**数据面**(结构债 P4 终态批 A1-b,2026-08-23)。
 *
 * 五条路由(S0 立形、S2·S3·S4a 接上真件),走的是**装配层**的 `rpc:invoke` 而不是
 * 上面那张宿主壳表 —— 处理者一行 electron 都不碰。`query` 按**本机可信**分叉
 * (B2;此前问的是 `context.transport`):
 *  - 本机可信(桌面 IPC / 桌面内嵌 HTTP 面 / 回环 `server:start`)= 这台进程装配的
 *    那份 `SearchService`,整台机器的一份会话 / 文件 / 提示词表 + store 级索引;
 *  - 不可信(独立部署的 server)= per-owner 沙箱里的同一件事
 *    (`server/search-providers.ts` 那个单槽端口,装的就是从前
 *    `POST /api/search/query` 背后的同一个闭包)。
 *
 * `SEARCH_ACTION` 是推送、`executeAction` 是窗口活(在 `searchWindowRouter` 上),
 * 两者都不在这里。
 */
export type SearchRoutes = {
  query: { input: SearchRequest; output: SearchResponse }
  capabilities: { input: SearchCapabilitiesRequest; output: SearchCapabilitiesResponse }
  preview: { input: SearchPreviewRequest; output: SearchPreviewResponse }
  invoke: { input: SearchInvokeRequest; output: SearchInvokeResponse }
  status: { input: SearchStatusRequest; output: SearchStatusResponse }
  /**
   * 嵌入模型的三个动作(2026-09-17;契约只加)。
   *
   * 它们与 `settings.saveSettings` 里那格开关**是两件事** —— 那正是用户当天的裁定
   * (「把开关和下载模型拆开,另外下载模型要能够知道进度」)。在这之前翻一下开关
   * 就等于开始下 112.8 MB,屏上只有一句「正在下载模型…」,没有进度也取消不了。
   *
   * **`download` 不等下完就答**(冷下 191 秒,一条 HTTP 往返等不了),回执里是
   * 起了这一发之后那一刻的模型状态;进度由 `status` 那一发的 `model` 那一格读。
   */
  semanticModelDownload: { input: SearchModelRequest; output: SearchModelResponse }
  semanticModelCancel: { input: SearchModelRequest; output: SearchModelResponse }
  semanticModelRemove: { input: SearchModelRequest; output: SearchModelResponse }
}

export const searchRouter = defineRouter<SearchRoutes>('search', [
  'query',
  'capabilities',
  'preview',
  'invoke',
  'status',
  'semanticModelDownload',
  'semanticModelCancel',
  'semanticModelRemove',
])

/* ───────────────────────── 能力自述 · 预览 · 动作 · 索引状态(S0)─────────────────────────
 *
 * 检索重建 S0(`docs/design/search-index-2026-09.md` §8):契约**只加不改**,四条新
 * 路由此刻都还是骨架——`capabilities` 从今天那张写死的清单答,`preview` / `invoke`
 * 结构化地说「S4 才有」,`status` 说「我是写者、没积压、向量关着」。加它们的理由是
 * **形先定死**:壳的 tab / 图标 / 分组次序、预览窗、后端动作、「索引更新中」那一行
 * 从 S2 起就该从这四条路由读,而不是各自再长一份写死的表。
 */

/**
 * 一个能力对外说的全部话(§4.1b 的 `CapabilityManifest` 的**线上形**)。
 *
 * 这里刻意**不 import core** —— S1 会在 `packages/core/search/capability.ts` 建一份
 * 同形的 `CapabilityManifest`,契约层与内核层各持一份是故意的:contract 是 wire 的
 * 形(要能过 JSON),core 那份还带 `visibility` / `schema` 这些**不出进程**的格。
 * 两份同形不同命,S1 落地时由能力侧一个纯函数投影过来。
 */
export interface SearchCapabilityManifestDto {
  /** 能力 id;也是 `SearchRequest.category` 的取值。 */
  id: string
  /** 文案键(壳翻译);不是已翻好的字面量。 */
  labelKey: string
  /** 宿主枚举图标名,不是 URL / SVG(同 `SearchResult.icon` 口径)。 */
  icon: string
  kind: 'indexed' | 'scan' | 'static' | 'remote'
  /** 意图前缀:`actions` 是 `['/', '>']`,将来的 symbols 是 `['#', '@']`。 */
  intentPrefixes?: string[]
  budget: {
    /** `all` 档给这一类的缺省配额。 */
    default: number
    timeoutMs: number
    /** 按意图改配额:`{ command: 8 }`。 */
    whenIntent?: Record<string, number>
  }
  /** 这一类认哪些过滤键(`SearchFilters` 的键就从这里来)。 */
  facets?: Array<{ key: string; type: 'enum' | 'range' | 'boolean'; values?: string[] }>
  /** `all` 档分组的缺省次序(小的在前)。 */
  order: number
  /** 按意图重排:`{ command: 0 }`。 */
  orderWhenIntent?: Record<string, number>
  /** 只在哪些消费面参与('palette' / 'composer-mention' / 'cli' / 'agent-tool' …);缺席 = 全部。 */
  surfaces?: string[]
  /** 预览怎么取(§4.5 ①):inline 随候选带,lazy 选中再走 `search.preview`;缺席 = 没有预览。 */
  preview?: { mode: 'inline' | 'lazy' }
  /**
   * **空词时这一类有浏览态**(S4b)。壳的「所有」档在**零词元**时不发
   * `category: 'all'`(那是分组总览,按设计不分页),而是问**声明了这一格**的
   * 那些能力,各一组、每组全量可翻页 —— 也就是 09-01 用户裁定的那张旧浏览态。
   *
   * 它是一格**自述**,所以壳里不必出现任何能力 id:今天只有 `chats` 声明它。
   * 缺席 = 空词时这一类没有东西可列。
   */
  browse?: boolean
}

export interface SearchCapabilitiesRequest {
  /** 只要这个消费面上参与的能力;缺席 = 全部。 */
  surface?: string
}

export interface SearchCapabilitiesResponse {
  success: boolean
  /** 注册顺序 = 缺省展示顺序(§4.3)。 */
  capabilities: SearchCapabilityManifestDto[]
  error?: string
}

/** 预览 / 动作请求里指一条结果:能力 + 它自己那套 id(§4.5 ③)。 */
export interface SearchItemRef {
  capability: string
  id: string
  target?: { kind: string; payload: unknown }
}

/** 预览的载荷:媒介**开放**,壳按 `kind` 从预览渲染注册表取组件(§4.5 ②)。 */
export interface SearchPreviewPayload {
  kind: string
  payload: unknown
  title?: string
  actions?: SearchActionDescriptor[]
}

/**
 * 能力自报的一个后端动作;`danger` 的壳先二段确认(§8 `invoke`)。
 *
 * 四格新加的都是可选(检索面终稿 §4),补上的正是 S4a 留账里那两格「过不去」的东西:
 *
 *  - `capability` —— 按下去要 `search.invoke` 谁。页级动作不挂在某一条结果上,
 *    没有这一格壳就问不出该找谁(预览上的动作从 `SearchItemRef` 里知道,所以缺席)。
 *  - `kind` —— 「这是开还是新建还是续搜」。**开放**,壳按 kind 从动作渲染表取图标
 *    与落地方式;契约层不枚举。
 *  - `payload` —— `kind` 那一类自己的载荷(续搜的 SearchScope、新建的目标路径…)。
 *  - `params` —— `labelKey` 的插值格。「新建提示词 “jira”」里的 `jira` 依赖**当前
 *    这次查询**,所以句子不能在后端拼好(R12:后端只交数据,句子由壳按键查出)。
 */
export interface SearchActionDescriptor {
  id: string
  labelKey: string
  icon?: string
  danger?: boolean
  capability?: string
  kind?: string
  payload?: unknown
  params?: Record<string, string | number>
}

export interface SearchPreviewRequest {
  items: SearchItemRef[]
  /** 基数是请求的一部分(§4.5 ③);缺席按 `single`。 */
  mode?: 'single' | 'compare' | 'batch'
  /**
   * **列表上那次查询的词**(检索面终稿 §4)。
   *
   * 预览里的高亮必须与列表行是**同一个产地**:壳自己再 `indexOf` 一遍就是第二套
   * 「什么算命中」。递上来,能力用与摘要逐字同一条 `snippetOf` 链算出 `ranges`。
   * 缺席 = 不要高亮(从预览面板直接打开的那一路)。
   */
  query?: string
}

export interface SearchPreviewResponse {
  success: boolean
  preview?: SearchPreviewPayload
  error?: string
  /**
   * **为什么没有预览**(检索面终稿 R6:壳只画字典句,后端原话只进日志)。
   *
   * | 码 | 意思 |
   * | --- | --- |
   * | `no-preview` | 这个能力自述里就没说有预览 —— 调用方问错了地方 |
   * | `gone` | 指的那条东西已经不在了(账本压缩过、会话删了) |
   * | `unreadable` | 在,但读不到(权限 / IO) |
   * | `malformed` | 读到了,但不是能画的形 |
   *
   * 缺席 = 这次失败还没有归到码上(`error` 里那句原话是唯一线索)。
   */
  reason?: 'no-preview' | 'gone' | 'unreadable' | 'malformed'
}

export interface SearchInvokeRequest {
  capability: string
  actionId: string
  items: SearchItemRef[]
}

export interface SearchInvokeResponse {
  success: boolean
  error?: string
}

export type SearchStatusRequest = Record<string, never>

/**
 * 索引在干什么(§15.5 的形;壳的「索引更新中」行与 gate 都读它)。
 *
 * `mode` 是**索引持有权**那一格(§5.6):`owner` = 这台进程在折账本,`reader` = 别人
 * 在折、我开只读句柄。拍点庚 09-04 裁「先不做」,所以 S3 之前它恒 `'owner'`。
 */
export interface SearchStatusResponse {
  mode: 'owner' | 'reader' | 'error'
  owner?: { host: string; pid: number }
  /** 还有多少条没折进索引。 */
  pending: number
  /**
   * 索引里现在有多少份文档(S3c 加;契约只加不改)。
   *
   * 加它是因为「索引建完了没有」在外面**问不出来**:`pending` 只说此刻队列空不空,
   * 而冷建那一段里队列会反复空掉又填上,盯着它会在一个**只折了一半**的索引上答
   * 「建完了」——`search:parity-B` 就是这么被咬到的(等 `pending === 0` 之后开始对账,
   * 跑到一半同一条查询多答出两条来)。文档数是**单调**的,「涨到不再涨」是外面能拿到
   * 的唯一诚实判据。壳也要它:「索引更新中」那行想说「已收录 N 条」得有这个数。
   *
   * 索引问不出来(没有索引 / 崩了)时缺席 —— 缺席 = 不知道,不是 0。
   */
  docs?: number
  /** 语义召回(S7,§15)的状态;`'off'` = 开关关着 / 装不上扩展 / 自己关回去了。 */
  vector?: 'off' | 'downloading' | 'embedding' | 'ready'
  /**
   * 还有几份文档没嵌进去(S7)。与 `pending` 是同一种诚实的两半:那一格数的是
   * 「还没折进倒排的会话」,这一格数的是「还没嵌进向量的文档」。
   */
  vectorPending?: number
  /**
   * **这份产物装得上 sqlite-vec 扩展吗**(S7)—— 与「开关开没开」是两件事。
   *
   * 它存在的理由只有一个:`gate:packaged` 要在**开关关着的默认档**上证明
   * `electron-builder.yml` 里 `asarUnpack` 那一行没漏。等用户去设置里打开才发现
   * 装不上就晚了。装配时探一次(一个 `:memory:` 库,不碰真库),此后是常量。
   */
  vectorExtension?: 'loadable' | 'missing'
  /**
   * **语义召回为什么关回去了** —— 一句话,给设置页的状态行用(2026-09-17;契约只加)。
   *
   * 缺席有两种意思,都不是「没出错」:开关就没开过,或者这一条起来之后没关过。
   * 屏幕上只在「开着 + `vector === 'off'`」那一态读它;在那之前设置页写的是
   * 「没跑起来。原因在日志里」,而真机上 Worker 的日志从来没有落过地 —— 那句话是假的,
   * 这一格与 `worker-logging.ts` 那半边一起把它变成真话。
   *
   * 产地在 Worker 里(`runtime/search/index/vector-writer.ts` 的
   * `describeEmbedderFailure`):**原话**,200 字封顶,后端一个中文字都不拼。
   * **它是诊断串,不是 UI 文案** —— 壳按 `vectorErrorKind` 查一句人话,再把这一格
   * 括在后面(`{reason}`)。
   */
  vectorError?: string
  /**
   * 那句原因属于**哪一类**(2026-09-17 R12;契约只加,与 `vectorError` 同生同灭)。
   *
   * 这一格存在的理由:第一版让后端拼了「下载模型失败(检查网络代理):」——那是后端替
   * 壳写文案,英文界面上会出现一句中文。现在后端只答码,句子由壳按 i18n 键查出。
   *
   * `network` 下载不通(改代理)/ `runtime` 本机装不出推理运行时 / `model` 模型文件
   * 不完整 / `unknown` 不认识 —— 不认识时壳**只说原话**,不猜。判据表(错误链里真的
   * 出现过哪几个字)在产地那个文件里,这里不复制。
   */
  vectorErrorKind?: 'network' | 'runtime' | 'model' | 'unknown'
  /**
   * **嵌入模型这件东西自己的状态**(2026-09-17;契约只加)。
   *
   * 与 `vector` 那一格是两件事,这正是用户那句裁定的形:`vector` 说「语义召回此刻
   * 在干什么」(开关开着才有意义),这一格说「这台机器上有没有那份模型、下到哪儿
   * 了」——**开关关着的时候它照样要说得出话**,因为设置页那颗「下载」就是在开关
   * 关着的时候按的。
   *
   * 缺席 = **还不知道**,不是「没下载」。两种情形:这台宿主管不了模型(没有索引 /
   * 这条嵌入器没有可下的模型),或者后端**正在试装**盘上那堆没有清单的文件
   * (2026-09-17 认领,§15.8b —— 几秒之后它会变成 `ready` 或 `absent`)。
   * 壳两种都读成 unknown「检查中…」,一颗钮都不画。
   */
  model?: SearchSemanticModelStatus
}

/** 三个动作的入参:一格都不要(模型是哪个由后端的设置说了算,不由调用方点名)。 */
export type SearchModelRequest = Record<string, never>

/**
 * 嵌入模型此刻的样子(§15.8)。
 *
 * 四个态的意思各不相同,屏幕上的画法也各不相同:
 * `absent` 没下(画「未下载 · 约 113 MB」+ 下载钮)/ `downloading` 正在下(画进度条
 * + 取消)/ `ready` 下全了(画「已下载 · 真数」+ 删除)/ `failed` 那一发败了
 * (画人话 + 原话 + 重试)。
 */
export interface SearchSemanticModelStatus {
  /** 嵌入器注册 id。**是数据不是文案** —— 换一门语言它不变,所以壳不把它送进字典。 */
  id: string
  state: 'absent' | 'downloading' | 'ready' | 'failed'
  /** 已经下了多少字节(`ready` 时 = 磁盘上的真数)。 */
  loadedBytes?: number
  /**
   * 一共多少字节。三态三个意思:`downloading` = 已知 `Content-Length` 的和(**单调
   * 不减**,认识一个新文件就长一截);`ready` = 磁盘上的真数;`absent` = 嵌入器自述的
   * **估计值**(屏上那句「约 113 MB」)。缺席 = 不知道。
   */
  totalBytes?: number
  /**
   * 那一发**失败**的原因分类 + 原话 —— 与 `vectorErrorKind` / `vectorError` 同一张
   * 判据表(`vector-writer.ts` 的 `describeEmbedderFailure`),所以壳查的是同一族
   * i18n 键。**取消不留这两格**:人自己按的那一下不是错。
   */
  errorKind?: 'network' | 'runtime' | 'model' | 'unknown'
  error?: string
}

/**
 * 三个动作的回执:**动作之后那一刻的模型状态**。
 *
 * `success: false` 时 `error` 是一个**码**(`model-in-use` / `model-not-downloadable` /
 * 「这台宿主管不了模型」),不是给人看的句子 —— 后端一个中文字都不拼(R12 那条)。
 * 壳今天不画它:那几种失败在屏幕上都已经被「钮禁着」挡在前面了,这一格是结构上的
 * 第二道。
 */
export interface SearchModelResponse {
  success: boolean
  error?: string
  model?: SearchSemanticModelStatus
}

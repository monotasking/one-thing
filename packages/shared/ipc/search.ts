/**
 * Search Everywhere — shared types
 */
import { defineRouter } from './router.js'

export {
  ONETHING_SEARCH_CATEGORIES as SEARCH_CATEGORIES,
  isOnethingSearchCategory as isSearchCategory,
} from '@onething/runtime/search/protocol'

/**
 * 能力 id 或 `'all'`(检索重建 S0,`docs/design/search-index-2026-09.md` §8)。
 *
 * 从前这里是 `OnethingSearchCategory` 那个**字面量联合** —— 联邦骨架下「能搜的
 * 东西」是注册表里的一行,契约层不该替它枚举:加一类不许改契约。所以类型放宽成
 * `string`,校验交给 registry(S2)。
 *
 * `SEARCH_CATEGORIES` / `isSearchCategory` 两个**值**照旧从 runtime 再导出,答的
 * 仍是今天那张写死的清单。
 *
 * S2(2026-09-04)之后**它们在产品代码里已经没有消费者**:「这个档认不认」由
 * `SearchService.query` 问注册表(`registry.has(id)`,不认识的归 `'all'`,与
 * `normalizeOnethingSearchCategory` 逐字同义),而那张清单只剩旧扫描路
 * (`executeOnethingSearchForIpc`)自己在读。两个再导出留到 S5 与旧路一起删 ——
 * 这一期不动它们,是因为契约层这条再导出正是边界检查器
 * (`checkRuntimeOwnsSearchIpcOperations`)钉住的那一条:清单必须由 runtime 拥有、
 * 由契约层原样转发,契约层不许自己长一份。
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
  /** `category: 'all'` 时的分组总览(§7.2);单类档缺席。 */
  groups?: Array<{
    capability: string
    label: string
    total?: number
    results: SearchResult[]
    error?: string
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
 * 查询**不在这张表上**,是刻意的:它的处理者一行 electron 都不 import(桌面是
 * `wiring/search/providers` 的 `executeSearch`,server 是同一件事的 per-owner
 * 沙箱版),按判据它是**数据面**。A1-b(2026-08-23)把它迁进了 `rpc:invoke` 的
 * backend `search` 域(见本文件下方的 `searchRouter`),`SEARCH_QUERY` 那条常量
 * 随之删除。
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
 * 只有一条 `query`,走的是**装配层**的 `rpc:invoke` 而不是上面那张宿主壳表 ——
 * 处理者一行 electron 都不碰。它是继 files / tools / mcp 之后又一个
 * **按 `context.transport` 分叉**的域:
 *  - `ipc`(桌面)= `wiring/search/providers` 的 `executeSearch`,整台机器的一份
 *    会话 / 文件 / 提示词表,逐字沿用迁移前 `apps/electron/src/search/ipc.ts` 那条
 *    手写 handler;
 *  - `http`(server)= per-owner 沙箱里的同一件事(`server/search-providers.ts`
 *    那个单槽端口,装的就是从前 `POST /api/search/query` 背后的同一个闭包)。
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
}

export const searchRouter = defineRouter<SearchRoutes>('search', [
  'query',
  'capabilities',
  'preview',
  'invoke',
  'status',
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

/** 能力自报的一个后端动作;`danger` 的壳先二段确认(§8 `invoke`)。 */
export interface SearchActionDescriptor {
  id: string
  labelKey: string
  icon?: string
  danger?: boolean
}

export interface SearchPreviewRequest {
  items: SearchItemRef[]
  /** 基数是请求的一部分(§4.5 ③);缺席按 `single`。 */
  mode?: 'single' | 'compare' | 'batch'
}

export interface SearchPreviewResponse {
  success: boolean
  preview?: SearchPreviewPayload
  error?: string
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
  /** 语义召回(S7)的状态;`'off'` = 没开。 */
  vector?: 'off' | 'downloading' | 'embedding' | 'ready'
}

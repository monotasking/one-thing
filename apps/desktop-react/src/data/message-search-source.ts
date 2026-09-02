import type { SearchResult } from '@shared/ipc/search'
import { createQueryFamily, useQuery } from './kernel'
import type { QuerySnapshot } from './kernel'
import { searchPort } from './search-port'
import type { MessageHit } from '../search/types'

/**
 * 检索面的**第三个产地**:跨会话消息正文(09-02,用户报障「搜索有问题,
 * 有些 message 搜索不到」)。
 *
 * 会话侧(标题 / 预览 / 章节)是本地滤 —— 整张 listMeta 在手,零延迟;
 * 文件侧(`files.list`)是一次按名字的查询;这一路是**一次按内容的查询**:
 * 后端 `search` 域的 `category:'messages'`,逐会话读消息的 `content` 做 indexOf,
 * 回执带 `sessionId` / `messageId` / `matchRanges` 与一段截断片段。
 *
 * 从前 `search/transitions.ts` 文件头写着一句「后端没有跨会话内容检索面」——
 * **那句话在写下的时候就不对**:`packages/shared/ipc/search.ts` 的 `searchRouter`
 * 一直在,`packages/onething-runtime/src/search/providers.ts` 的 `searchMessages`
 * 也一直在。缺的从来不是后端,是壳这一侧没有接。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(状态先行,09-01 用户令)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── 一、生命周期 ─────────────────────────────────────────────────────────
 * | 时机 | 这里发生什么 |
 * | --- | --- |
 * | 挂载 | **什么都不发**。这是一族 query,格是被问出来的:检索面板敲进第一个词、去抖窗口到点,才 `get(key).ensure()` 建出第一格。空词一格都不建。 |
 * | 首载 | 那一格 `phase === 'initial'` 且 `inflight` 为真。屏幕上这一路一行都没有 —— 面板照旧画会话侧与文件侧那两路,**不为它清屏**(律②)。 |
 * | 换宿主 | **不存在**。数据源没有落点形态(不进舞台 / 浮窗 / 架子);面板换形态时它一格都不动,面板重挂之后 `useQuery` 重新订上同一格,答案原样在。 |
 * | 换空间 | **不作废,也不重发**。理由见下面「空间与删除」一节:命中是全机器的,而「这一条看不看得见」由投影层那张会话表说了算 —— 换空间只是换那张表。 |
 * | 卸载 | 面板收起 = `useQuery` 退订。格留着(那正是缓存),在飞的那一发跑完照旧落地。整族的退役只有两口:`resetMessageSearch()`(测试)与 HMR dispose。 |
 *
 * ── 二、UI 生命状态 ──────────────────────────────────────────────────────
 * | 状态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | empty(没给词) | 词为空 | 这一路不出行 —— 浏览态没有正文行(「全库消息」不是一张能浏览的表) |
 * | loading(首载) | `phase==='initial' && inflight` | 这一路无行;底部读数走 `moreState` 的 pending 那一格(「已显示 N 条」,不许诺还有更多) |
 * | 重拉(翻页 / 换词) | `phase==='ready' && inflight` | **旧命中留在屏上**(律②),不清屏、不画骨架 |
 * | ready | `phase==='ready' && !inflight` | 命中成行;取尽判据 = 回来的条数 < 要的条数 |
 * | error | `snapshot.error` 在 | 面板上那一行「消息没搜成」+ 后端原话,**与旧命中并陈**(律②:失败不抹掉上一次的答案) |
 * | 超量 | 后端按 limit 截断且**不下发总数** | 只说「加载更多」,不猜一个数(判据表见 `search/transitions.ts` 的 moreState) |
 *
 * ── 三、UI 交互状态 ──────────────────────────────────────────────────────
 * 这块是数据源,**自己一个控件都不画**。它交给面板的读数只有三格
 * (命中 / 在飞 / 失败原话),分别落在:命中行、底部那条 item 的 loading 与 more
 * 两态、失败那一行。rest / hover / focus / active 全部长在行上
 * (`ui/ButtonBase` + `ui/a11y/list-selection`),这里一格都不管;
 * disabled **一处都没有** —— 检索框永不禁用,上一发还在飞的时候照样能接着打字。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── 为什么是 kernel 的一族 query,而不是 files-source 那样的手写四件套 ────
 * `data/files-source.ts` 的文件检索刻意**没有**建族,理由写在它的拍板三:
 * 「键随击键无限长」。那条顾虑是真的,但它的解法是**给键面封顶**,不是退回手写:
 * 手写那一份要自己维护 `searchToken` / `searchQuery` / `searchLimit` 三格,
 * 而律②「失败不清命中」在那边是一段带 `sameQuestion` 判断的手写代码 ——
 * 在 kernel 里那是**性质**(`error` 与 `data` 天然共存,refetch 期间 data 永不清)。
 *
 * 所以这里吃原语,再加一条封顶(见下面的 `remember`):键面恒 ≤ `CACHE_KEYS`,
 * 而「同一个词回来了」不再发一次请求 —— 删掉一个字母又打回去是常态。
 *
 * ── 键是「词 + limit」两格,拼法是 JSON ──────────────────────────────────
 * 后端没有游标:翻页 = 带一个更大的 limit 从头重查。所以 limit 是**问题的一部分**,
 * 不是同一个问题的一次刷新 —— 20 条那份答案不能拿来回答 40 条那个问题
 * (它会被判成「取尽了」)。
 *
 * 两格怎么拼成一个键:`JSON.stringify([query, limit])`,拆回来 `JSON.parse`。
 * **不选一个分隔符** —— 词是用户打进去的任意文本,任何一个分隔符都可能出现在里面,
 * 于是「拆键」就成了一条要挑边界情况的判据。JSON 那一对函数已经把这件事办完了,
 * 而且它与 `SearchPanel` 里那条取数副作用的主语(`JSON.stringify([query, cwd])`)
 * 是同一个体例 —— 同一件事在这台壳里只有一种拼法。
 *
 * ── 空间与删除:靠投影,不靠作废 ─────────────────────────────────────────
 * 后端那条 `executeSearch`(桌面 ipc 档)搜的是**这台机器上的全部会话**,不带
 * 空间参数;而检索面板画的是**当前空间**那一份(`sessions-source` 的屏幕投影)。
 * 于是「这条命中看不看得见」的判据只有一个:**它的会话在不在屏幕那份表里** ——
 * 这一刀在 `search/transitions.ts` 的 `messageRows` 里切,不在这里。
 *
 * 这么分工同时把「会话被删了怎么办」一并答了:删掉的会话当场从投影里消失
 * (`onSessionLifecycle` 那一路),它的命中也就跟着不出行 —— 不需要第二套作废
 * 簿记去追。一份缓存 + 一道投影,好过一份缓存 + 一张「哪些键该丢」的名单。
 */

/** 缓存最多留几个键。够覆盖「删一个字母再打回去」与前后几页,不至于攒成一本账。 */
const CACHE_KEYS = 24

/**
 * 键 = 问题本身。词与 limit 两格都进,拼法理由见文件头。
 *
 * **导出**是因为这一族的寻址方式是它的公开面:要 `patch` / `invalidate` /
 * `drop` 具体某一页的人(测试里的种子、将来某条「这一页作废」的通路)必须
 * 说得出那一格叫什么。让每个调用方自己拼一遍才是那种会漂开的第二份产地。
 */
export function messageSearchKey(query: string, limit: number): string {
  return JSON.stringify([query.trim(), limit])
}

/** 内部沿用同一只函数 —— 键的拼法只有一个产地。 */
const cacheKey = messageSearchKey

/**
 * 这一族的键面封顶:记下刚问过的键,超出就把最老的那一格**丢掉**(不是标脏)。
 *
 * 用 `drop` 而不是 `invalidate`,判据与 kernel 那段注释逐字相同:标脏说的是
 * 「答案旧了,再问」,丢格说的是「这个键不值得再留着」。这里是后者 ——
 * 半小时前打的那个词不该占着内存等一个永远不会来的重问。
 */
const recent: string[] = []

function remember(key: string): void {
  const at = recent.indexOf(key)
  if (at >= 0) recent.splice(at, 1)
  recent.push(key)
  while (recent.length > CACHE_KEYS) {
    const oldest = recent.shift()
    if (oldest !== undefined) messageSearchQuery.drop(oldest)
  }
}

/**
 * 一次查询的答案。`limit` 原样带回来 —— 「取尽了没有」的唯一判据是
 * **回来的条数 < 要的条数**(后端不下发总数),消费方要这两个数才判得出来。
 */
export interface MessageSearchAnswer {
  hits: readonly MessageHit[]
  /** 产生这批命中的那一次要了多少条。 */
  limit: number
}

/**
 * 后端 `SearchResult` → 壳里的 `MessageHit` 的**唯一一处收窄**。
 *
 * 契约上 `sessionId` / `messageId` 都是可选的(那张表要同时装得下 action /
 * prompt / file 那几种命中),而这一路的行**必须能落地**:点它要进那条会话、
 * 滚到那条消息。缺了任一格的行画出来就是一行按不动的东西 —— 所以在这里丢掉,
 * 而不是让每个消费方各判一次 `if (!hit.sessionId)`。
 *
 * `type !== 'message'` 同理:这条口只要了 `category:'messages'`,回来别的类型
 * 说明后端那一侧变了 —— 那不是这里该猜着用的东西。
 */
function toHits(results: readonly SearchResult[]): MessageHit[] {
  const hits: MessageHit[] = []
  for (const raw of results) {
    if (raw.type !== 'message') continue
    const sessionId = raw.sessionId ?? ''
    const messageId = raw.messageId ?? ''
    const text = raw.title ?? ''
    if (!sessionId || !messageId || !text) continue
    hits.push({
      id: raw.id || `msg:${sessionId}:${messageId}`,
      sessionId,
      messageId,
      text,
      /*
       * 高亮切片**用后端给的这一份**,不在壳里再 indexOf 一遍:两个产地各说一次
       * 「什么算命中」迟早漂移(后端的 `normalizeQuery` 会剥掉开头的 `>` 与 `/`,
       * 本地那一遍不会 —— 于是同一个词两边切出来的片能对不上)。
       * 后端没给就是空表 = 这一行不高亮,而不是退回本地再算一次。
       */
      ranges: raw.matchRanges ?? [],
    })
  }
  return hits
}

/** 拆键。坏键(手搓 / 老缓存)当作「没有这个问题」,不抛 —— 抛会把整面拖红。 */
function parseKey(key: string): { query: string; limit: number } {
  try {
    const parsed: unknown = JSON.parse(key)
    if (!Array.isArray(parsed)) return { query: '', limit: 0 }
    const [query, limit] = parsed as [unknown, unknown]
    if (typeof query !== 'string' || typeof limit !== 'number') return { query: '', limit: 0 }
    return { query, limit }
  } catch {
    return { query: '', limit: 0 }
  }
}

/**
 * 取数那一半。`ctx.key` 就是那对 `[词, limit]`,拆回来发一次。
 *
 * `success:false` **抛**出去而不是回一份空命中:失败与「一条都没搜到」是两件事,
 * 合成一个空表就等于把一次失败说成一次空结果(与文件侧 `search.filesFailed`
 * 那一行同一条判据)。抛出去之后它落在 `snapshot.error` 上,与 `data` 共存。
 */
export const messageSearchQuery = createQueryFamily<MessageSearchAnswer>(
  'search.messages',
  async (ctx) => {
    const { query, limit } = parseKey(ctx.key)
    if (!query || limit <= 0) return { hits: [], limit: 0 }
    const port = await searchPort()
    await port.ready()
    const response = await port.queryMessages(query, limit)
    if (!response.success) throw new Error('message search failed')
    return { hits: toHits(response.results), limit }
  },
)

/**
 * 「问一次这个词的第 n 页」。**幂等**:同一个键问过就什么都不做(`ensure` 的语义),
 * 所以面板那条去抖副作用每次重跑都可以无脑调它。
 *
 * 空词当场早退,一格都不建 —— 「全库消息」不是一张能浏览的表(与文件侧
 * 「最近打开的文件没有产地」同一条纪律:没有产地就不伪造一张)。
 */
export function ensureMessageSearch(query: string, limit: number): Promise<void> {
  const q = query.trim()
  if (!q || limit <= 0) return Promise.resolve()
  const key = cacheKey(q, limit)
  remember(key)
  return messageSearchQuery.get(key).ensure()
}

/** 「同一页再问一次」——「重试」那一下的落点(用户明确要求重来)。 */
export function refetchMessageSearch(query: string, limit: number): Promise<void> {
  const q = query.trim()
  if (!q || limit <= 0) return Promise.resolve()
  const key = cacheKey(q, limit)
  remember(key)
  return messageSearchQuery.get(key).refetch()
}

/** 测试与 HMR 用:整族回到出厂,键面一并清空。 */
export function resetMessageSearch(): void {
  messageSearchQuery.reset()
  recent.length = 0
}

/**
 * 组件侧的读法。**建格但不发请求** —— `get(key)` 只是拿到那一格的把手,
 * 发不发由 `ensureMessageSearch` 说了算(它长在面板那条带去抖的副作用上)。
 *
 * 空词时订的是空串那一格:它永远没人问过,于是快照恒定是出厂那一份
 * (`data === undefined`、`phase === 'initial'`、`inflight === false`)——
 * 面板据此什么都不画,而不必在这里分一条支路。
 */
export function useMessageSearch(query: string, limit: number): QuerySnapshot<MessageSearchAnswer> {
  const q = query.trim()
  return useQuery(messageSearchQuery.get(q && limit > 0 ? cacheKey(q, limit) : ''))
}

/**
 * 模块级副作用的退役口(09-01 立法)。这个模块在模块作用域里留着一族 query
 * 与那本键面账 —— 它们的寿命就是「这个模块实例」,热更时必须退役,
 * 否则新旧两份缓存同时活着各自应答。
 *
 * 退役**复用这个模块已有的那一口拆卸**(`resetMessageSearch()`),不写第二套。
 * 它自身幂等;生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetMessageSearch()
  })
}

import type {
  ProjectedToolCall,
  ResearchActivity,
  ResearchEpisodeModel,
  ResearchQueryGroup,
  ResearchSource,
  ToolStepModel,
} from '../model/segments'
import { presentToolStep } from '../assemble/present'
import { argString, toolDetails } from '../tools/result'
import { toolTone } from '../tools/status'
import { domainOf, isSearchCall } from '../tools/web-family'

/**
 * 检索段的**折叠**(§5.3):一串 web 族调用 → 一份 episode。
 *
 * 纯函数、零 React,与 `assemble/present.ts` 的组折叠同一层。四件套(流中态行 /
 * 收起行 / 展开清单 / 消息尾来源条)全部读这一份产物 —— 「一份事实,四处呈现」。
 *
 * ── 事实从哪来(2026-08-30 真 store 勘察) ───────────────────────────────
 * `web_search` / `web_open` 的结局里那份 `metadata`(经 `toolDetails` 认领,规范形
 * 里叫 `details`)是**结构化**的,不需要从输出正文里刨:
 *
 *   { mode?, phase, provider, query, queries?, resultCount, pageCount,
 *     searches: [{ id, query, resultCount, results: [...] }],
 *     results: [{ id, searchId, query, rank, title, url, snippet, … }],
 *     pages:   [{ id, resultId, url, title, excerpt, description, status, error, … }] }
 *
 * 449 个会话里 98 个带 web 调用、389 次调用采样下来只有两种形态:上面这份完整形,
 * 和一份更老的 `{ provider, query, resultCount, results:[{title,url,snippet}] }`
 * (24 次,没有 `searches`、结果没有 id)。两种都认,认不出就退到**参数**里的
 * `query` / `url` —— 那一格连失败的调用都有,所以「搜了什么」永远说得出来。
 *
 * ── 一条纪律:读不到就是读不到 ────────────────────────────────────────────
 * 与 `tools/result.ts` 同一条。标题、摘录、域名任何一格取不到就缺席,不编。
 */

/** 折出一段检索。`calls` 是 ② 归组认定的那一串(至少一次)。 */
export function presentResearchEpisode(
  calls: readonly ProjectedToolCall[],
): ResearchEpisodeModel {
  const groups: ResearchQueryGroup[] = []
  const steps: ToolStepModel[] = []
  const sources: ResearchSource[] = []
  // 段内按 URL 去重:同一个页面被两次搜索都搜到、又被打开一次,屏幕上仍然是**一条**。
  // 去重发生在整段而不是组内,这样收起行的「N 个来源」与清单上看得见的行数逐条相等
  // —— 两个数不一致是最容易被当成 bug 的那种不一致。代价:一条被两个查询词都搜到的
  // 来源只挂在**先搜到它**的那一组下面。
  const byUrl = new Map<string, ResearchSource>()

  let failed = 0
  let durationTotal: number | undefined
  let running = false
  let active: ResearchActivity | undefined

  for (const call of calls) {
    steps.push(presentToolStep(call))
    const tone = toolTone(call.status)
    if (tone === 'bad') failed += 1
    if (tone === 'busy') {
      running = true
      // 「最后一条活动的调用」—— 后来的覆盖先前的,所以直接赋值。
      active = activityOf(call)
    }
    if (call.durationMs !== undefined) durationTotal = (durationTotal ?? 0) + call.durationMs

    if (isSearchCall(call)) collectSearch(call, groups, byUrl, sources)
    else collectOpen(call, groups, byUrl, sources)
  }

  const queries = groups
    .map((group) => group.query)
    .filter((query): query is string => query !== undefined)

  return {
    groups,
    sources,
    queries,
    steps,
    // 「打开 M 个页面」数的是**真读到正文**的那些:一次打开失败(反爬 / 无正文)不算
    // 打开了一个页面,尽管那次调用确实发生过。
    openedCount: sources.filter((source) => source.openStatus === 'ok').length,
    failed,
    ...(durationTotal !== undefined ? { durationMs: durationTotal } : {}),
    running,
    ...(active ? { active } : {}),
  }
}

/** 按 callId 取回那一次调用的行 + 事实(来源行的抽屉用)。 */
export function researchStep(
  episode: ResearchEpisodeModel,
  callId: string | undefined,
): ToolStepModel | undefined {
  if (!callId) return undefined
  return episode.steps.find((step) => step.row.callId === callId)
}

/**
 * 来源行该打开哪一次调用的抽屉:**打开它的那次优先**。
 *
 * 人点一条来源是想看「这一页上有什么」,而不是「哪次搜索捎带出了它」——
 * 没被打开过时才退回引入它的那次搜索。
 */
export function sourceStep(
  episode: ResearchEpisodeModel,
  source: ResearchSource,
): ToolStepModel | undefined {
  return researchStep(episode, source.openCallId) ?? researchStep(episode, source.callId)
}

/**
 * 图标堆叠里那几枚:按来源序去重的域名 —— 同一个站的两页只占一枚脸。
 *
 * 收起行与消息尾来源条都读它,所以它是一个纯函数而不是各自的一段 `map`:
 * 两处画出来的那一小撮脸必须逐枚相同。
 */
export function stackDomains(sources: readonly ResearchSource[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const source of sources) {
    if (seen.has(source.domain)) continue
    seen.add(source.domain)
    out.push(source.domain)
  }
  return out
}

// ── 采集 ─────────────────────────────────────────────────────────────────

function collectSearch(
  call: ProjectedToolCall,
  groups: ResearchQueryGroup[],
  byUrl: Map<string, ResearchSource>,
  sources: ResearchSource[],
): void {
  const meta = toolDetails(call)
  const searches = recordArray(meta?.searches)

  if (searches.length > 0) {
    // 完整形:一次 `web_search` 可以带多条查询词(模型同时搜中英两版是常态),
    // 每条自成一组 —— 定稿的清单就是按查询词分的。
    searches.forEach((search, index) => {
      const group = pushGroup(groups, {
        id: `${call.id}#s${index}`,
        query: str(search.query) ?? fallbackQuery(call, meta),
        callId: call.id,
      })
      for (const result of recordArray(search.results)) {
        addResult(group, byUrl, sources, call, result)
      }
    })
    return
  }

  // 老形态(没有 `searches`)与失败的调用走同一条:一组,查询词退到参数里那一格。
  // 失败时来源列表是空的,但**那一组仍然要在**:「搜了 X,没搜着」是事实,
  // 把整组抹掉会让人以为模型压根没搜。
  const group = pushGroup(groups, {
    id: `${call.id}#s0`,
    query: fallbackQuery(call, meta),
    callId: call.id,
  })
  for (const result of recordArray(meta?.results)) {
    addResult(group, byUrl, sources, call, result)
  }
}

function collectOpen(
  call: ProjectedToolCall,
  groups: ResearchQueryGroup[],
  byUrl: Map<string, ResearchSource>,
  sources: ResearchSource[],
): void {
  const meta = toolDetails(call)
  const page = recordArray(meta?.pages)[0]
  const result = recordArray(meta?.results)[0]

  const url = argString(call, 'url') ?? str(page?.url) ?? str(result?.url) ?? str(meta?.query)
  if (!url) return

  // 归入**最后一组**:一次打开是紧跟着某次搜索发生的,它读的就是那一组里的某条结果。
  // 一次都还没搜过 → 未署名组(见 model/segments.ts 的说明)。
  const group = groups[groups.length - 1] ?? unshiftUnattributed(groups)
  const source = addSource(group, byUrl, sources, {
    url,
    callId: call.id,
    title: argString(call, 'title') ?? str(page?.title) ?? str(result?.title),
    excerpt: plainText(str(page?.excerpt) ?? str(page?.description) ?? str(result?.snippet)),
  })

  source.opened = true
  source.openCallId = call.id
  const openStatus = openStatusOf(call, page)
  if (openStatus) source.openStatus = openStatus
  // 搜索先给的标题往往是列表页的短名,打开之后拿到的是真标题 —— 后到的更好就换上。
  const openedTitle = argString(call, 'title') ?? str(page?.title)
  if (openedTitle) source.title = openedTitle
  const openedExcerpt = plainText(str(page?.excerpt) ?? str(page?.description))
  if (openedExcerpt) source.excerpt = openedExcerpt
}

/**
 * 打开的结局 —— **还没收场就是缺席**。
 *
 * 三条,顺序有意义:
 *  1. 调用自己失败 / 取消 → failed;
 *  2. 调用成功、页面那一格却写着 `failed` 或带着 `error` → 也是 failed。这是**真实
 *     存在**的形态(勘察里 `status:'failed'` + `error:'No readable text found on the
 *     page.'` 那一条):工具报告「我跑完了」,页面报告「没读到东西」。屏幕上要说的
 *     是后者;
 *  3. 只有真收场且没出事才是 ok。运行中(以及认不出的状态)一律缺席 —— 一次正在
 *     抓的页面还不是「打开了一个页面」,把它计进流中态那句「打开 M 个页面」会让
 *     那个数在页面真读完之前就先跳一格。
 */
function openStatusOf(
  call: ProjectedToolCall,
  page: Record<string, unknown> | undefined,
): 'ok' | 'failed' | undefined {
  const tone = toolTone(call.status)
  if (tone === 'bad') return 'failed'
  if (page && (page.status === 'failed' || typeof page.error === 'string')) return 'failed'
  return tone === 'ok' ? 'ok' : undefined
}

function addResult(
  group: ResearchQueryGroup,
  byUrl: Map<string, ResearchSource>,
  sources: ResearchSource[],
  call: ProjectedToolCall,
  result: Record<string, unknown>,
): void {
  const url = str(result.url)
  if (!url) return
  addSource(group, byUrl, sources, {
    url,
    callId: call.id,
    title: str(result.title),
    excerpt: plainText(str(result.snippet)),
  })
}

interface SourceInit {
  url: string
  callId: string
  title?: string
  excerpt?: string
}

function addSource(
  group: ResearchQueryGroup,
  byUrl: Map<string, ResearchSource>,
  sources: ResearchSource[],
  init: SourceInit,
): ResearchSource {
  const existing = byUrl.get(init.url)
  if (existing) {
    if (!existing.title && init.title) existing.title = init.title
    if (!existing.excerpt && init.excerpt) existing.excerpt = init.excerpt
    return existing
  }
  const source: ResearchSource = {
    id: `${init.callId}#${sources.length}`,
    url: init.url,
    domain: domainOf(init.url) ?? init.url,
    callId: init.callId,
    opened: false,
    ...(init.title ? { title: init.title } : {}),
    ...(init.excerpt ? { excerpt: init.excerpt } : {}),
  }
  byUrl.set(init.url, source)
  sources.push(source)
  group.sources.push(source)
  return source
}

function pushGroup(
  groups: ResearchQueryGroup[],
  init: { id: string; query?: string; callId: string },
): ResearchQueryGroup {
  const group: ResearchQueryGroup = {
    id: init.id,
    callId: init.callId,
    sources: [],
    ...(init.query ? { query: init.query } : {}),
  }
  groups.push(group)
  return group
}

/** 未署名组永远在最前:它记的那件事(还没搜就开)发生在所有搜索之前。 */
function unshiftUnattributed(groups: ResearchQueryGroup[]): ResearchQueryGroup {
  const group: ResearchQueryGroup = { id: 'unattributed', sources: [] }
  groups.unshift(group)
  return group
}

function activityOf(call: ProjectedToolCall): ResearchActivity {
  if (isSearchCall(call)) {
    const query = argString(call, 'query') ?? str(toolDetails(call)?.query)
    return { kind: 'search', ...(query ? { query } : {}) }
  }
  const url = argString(call, 'url')
  const domain = domainOf(url)
  const title = argString(call, 'title')
  return { kind: 'open', ...(domain ? { domain } : {}), ...(title ? { title } : {}) }
}

/** 查询词退路:metadata 的 `query` → 参数里的 `query`。两处都没有就没有。 */
function fallbackQuery(
  call: ProjectedToolCall,
  meta: Record<string, unknown> | undefined,
): string | undefined {
  return str(meta?.query) ?? argString(call, 'query')
}

// ── 小工具 ───────────────────────────────────────────────────────────────

/**
 * 摘录**剥标签**:搜索引擎把命中词包在 `<strong>` 里回来(勘察里逐条如此),
 * 原样摆到屏幕上就是一串尖括号 —— 而把它当 HTML 渲染更不行(那是外部文本)。
 * 所以剥成纯文字,再把五个基本实体还原。
 */
export function plainText(value: string | undefined): string | undefined {
  if (!value) return undefined
  const text = value
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  return text || undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  )
}

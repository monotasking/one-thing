import type {
  ProjectedToolCall,
  ResearchActivity,
  ResearchEpisodeModel,
  ResearchQueryGroup,
  ResearchSource,
  ResearchStep,
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
  const trail: ResearchStep[] = []
  // 段内按 URL 去重:同一个页面被两次搜索都搜到、又被打开一次,屏幕上仍然是**一条**。
  // 去重发生在整段而不是组内,这样收起行的「N 个来源」与清单上看得见的行数逐条相等
  // —— 两个数不一致是最容易被当成 bug 的那种不一致。代价:一条被两个查询词都搜到的
  // 来源只挂在**先搜到它**的那一组下面。
  const byUrl = new Map<string, ResearchSource>()

  let failed = 0
  let failedSearches = 0
  let durationTotal: number | undefined
  let running = false
  let active: ResearchActivity | undefined

  for (const call of calls) {
    steps.push(presentToolStep(call))
    const tone = toolTone(call.status)
    if (tone === 'bad') {
      failed += 1
      if (isSearchCall(call)) failedSearches += 1
    }
    if (tone === 'busy') {
      running = true
      // 「最后一条活动的调用」—— 后来的覆盖先前的,所以直接赋值。
      active = activityOf(call)
    }
    if (call.durationMs !== undefined) durationTotal = (durationTotal ?? 0) + call.durationMs

    if (isSearchCall(call)) collectSearch(call, groups, byUrl, sources, trail)
    else collectOpen(call, groups, byUrl, sources, trail)
  }

  const queries = groups
    .map((group) => group.query)
    .filter((query): query is string => query !== undefined)

  return {
    groups,
    sources,
    queries,
    steps,
    trail,
    // 「细读 M 篇」数的是**真读到正文**的那些:一次打开失败(反爬 / 无正文)不算
    // 打开了一个页面,尽管那次调用确实发生过。
    openedCount: sources.filter((source) => source.openStatus === 'ok').length,
    failed,
    failedSearches,
    unreadCount: sources.filter((source) => source.openStatus === 'failed').length,
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
  trail: ResearchStep[],
): void {
  const meta = toolDetails(call)
  const searches = recordArray(meta?.searches)
  const status = stepStatus(call)

  if (searches.length > 0) {
    // 完整形:一次 `web_search` 可以带多条查询词(模型同时搜中英两版是常态),
    // 每条自成一组 —— 定稿的清单就是按查询词分的。
    searches.forEach((search, index) => {
      const group = pushGroup(groups, {
        id: `${call.id}#s${index}`,
        query: str(search.query) ?? fallbackQuery(call, meta),
        callId: call.id,
      })
      const results = recordArray(search.results)
      for (const result of results) {
        addResult(group, byUrl, sources, call, result)
      }
      trail.push(searchStep(group, status, num(search.resultCount) ?? results.length))
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
  const results = recordArray(meta?.results)
  for (const result of results) {
    addResult(group, byUrl, sources, call, result)
  }
  // 还在跑的搜索没有结果数可说;失败的也不说(「0 条」会被读成「搜到了,是空的」)。
  trail.push(
    searchStep(group, status, status === 'ok' ? (num(meta?.resultCount) ?? results.length) : undefined),
  )
}

function searchStep(
  group: ResearchQueryGroup,
  status: ResearchStep['status'],
  resultCount: number | undefined,
): ResearchStep {
  return {
    id: group.id,
    kind: 'search',
    status,
    ...(group.query ? { query: group.query } : {}),
    ...(status === 'ok' && resultCount !== undefined ? { resultCount } : {}),
  }
}

/** 一次调用的结局,折成步骤单的三态。认不出的状态按「还在跑」说 —— 不替它下结论。 */
function stepStatus(call: ProjectedToolCall): ResearchStep['status'] {
  const tone = toolTone(call.status)
  return tone === 'bad' ? 'failed' : tone === 'ok' ? 'ok' : 'running'
}

function collectOpen(
  call: ProjectedToolCall,
  groups: ResearchQueryGroup[],
  byUrl: Map<string, ResearchSource>,
  sources: ResearchSource[],
  trail: ResearchStep[],
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
    ...markedText(str(page?.excerpt) ?? str(page?.description) ?? str(result?.snippet)),
  })

  source.opened = true
  source.openCallId = call.id
  const openStatus = openStatusOf(call, page)
  if (openStatus) source.openStatus = openStatus
  // 搜索先给的标题往往是列表页的短名,打开之后拿到的是真标题 —— 后到的更好就换上。
  const openedTitle = argString(call, 'title') ?? str(page?.title)
  if (openedTitle) source.title = openedTitle
  const opened = markedText(str(page?.excerpt) ?? str(page?.description))
  if (opened.excerpt) {
    source.excerpt = opened.excerpt
    if (opened.excerptMarks) source.excerptMarks = opened.excerptMarks
    else delete source.excerptMarks
  }

  trail.push({
    id: `${call.id}#open`,
    kind: 'open',
    // 阅读这一步的结局就是页面的结局 —— 调用成功而页面没读到,这一步是失败的。
    status: openStatus ?? 'running',
    domain: source.domain,
    ...(source.title ? { title: source.title } : {}),
  })
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
    ...markedText(str(result.snippet)),
  })
}

interface SourceInit {
  url: string
  callId: string
  title?: string
  excerpt?: string
  excerptMarks?: ReadonlyArray<readonly [number, number]>
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
    if (!existing.excerpt && init.excerpt) {
      existing.excerpt = init.excerpt
      if (init.excerptMarks) existing.excerptMarks = init.excerptMarks
    }
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
    ...(init.excerpt && init.excerptMarks ? { excerptMarks: init.excerptMarks } : {}),
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
  return markedText(value).excerpt
}

/**
 * 剥标签,同时**记下命中词在哪**(`plainText` 是它只要文字的那一半)。
 *
 * 高亮标签(`<b>` / `<strong>` / `<em>` / `<mark>`)之间的文字记成一段 `[起, 止)`;
 * 别的标签照旧剥掉。空白折叠与首尾修剪在**逐段**上做,所以下标落在最终那串文字上,
 * 不会因为折掉一串空格而错位。
 */
export function markedText(value: string | undefined): {
  excerpt?: string
  excerptMarks?: ReadonlyArray<readonly [number, number]>
} {
  if (!value) return {}
  const parts: { text: string; hit: boolean }[] = []
  let depth = 0
  for (const token of value.split(/(<[^>]*>)/)) {
    if (token.startsWith('<') && token.endsWith('>')) {
      const tag = /^<\s*(\/?)\s*(b|strong|em|mark)\b/i.exec(token)
      if (tag) depth = Math.max(0, depth + (tag[1] ? -1 : 1))
      continue
    }
    if (token) parts.push({ text: decodeEntities(token), hit: depth > 0 })
  }

  let text = ''
  const marks: [number, number][] = []
  for (const part of parts) {
    let chunk = part.text.replace(/\s+/g, ' ')
    // 段与段交界处的两个空格折成一个;开头的空白整个丢掉。
    if (chunk.startsWith(' ') && (text === '' || text.endsWith(' '))) chunk = chunk.slice(1)
    if (!chunk) continue
    if (part.hit) {
      const lead = chunk.length - chunk.trimStart().length
      const core = chunk.trim()
      if (core) {
        const start = text.length + lead
        const last = marks[marks.length - 1]
        // 紧挨着的两段命中并成一段 —— 屏幕上本来就是一整块粗体。
        if (last && last[1] === start) last[1] = start + core.length
        else marks.push([start, start + core.length])
      }
    }
    text += chunk
  }
  const trimmed = text.trimEnd()
  if (!trimmed) return {}
  const kept = marks
    .map(([start, end]) => [start, Math.min(end, trimmed.length)] as [number, number])
    .filter(([start, end]) => end > start)
  return { excerpt: trimmed, ...(kept.length > 0 ? { excerptMarks: kept } : {}) }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
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

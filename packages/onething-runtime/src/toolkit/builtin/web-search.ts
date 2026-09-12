/**
 * R3a 移植 —— `web_search`。§4 的 `NetworkTool` 一族。
 *
 * 描述、参数、输出格式、metadata 形状逐字沿用旧
 * `tools/builtin/web-search/index.ts`;搜索与抓页全部复用旧的纯模块
 * (`providers/*`、`page-fetch.ts`),这里一行都不重写。
 *
 * 三处与旧实现的差别,都在注释里就近说明:
 *  - `ctx.updateResult?.()` → `emit({ type: 'partial' })`;
 *  - `ctx.metadata()` → `emit({ type: 'annotate' })`;
 *  - 抓页的信号走 `ctx.abort`(family 的 `networkScope`),不再直接递
 *    `ctx.abortSignal`。
 */

import { z } from 'zod'
import { toJsonObject } from '@onething/core'
import type { Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import type { SearchProvider, SearchResponse } from '../../tools/builtin/web-search/providers/types.js'
import {
  fetchSearchPages,
  type FetchedSearchPage,
  type FetchFn,
  type SearchPageRequest,
} from '../../tools/builtin/web-search/page-fetch.js'
import { defineInput } from '../contract.js'
import { NetworkTool } from '../families/network.js'
import { wrapUntrustedText } from '../untrusted-text.js'

export interface WebSearchToolAdapters {
  providers?: Record<string, SearchProvider>
  getFetch?: () => FetchFn
}

function getConfiguredProvider(providers: Record<string, SearchProvider>): SearchProvider | null {
  for (const provider of Object.values(providers)) {
    if (provider.isConfigured()) return provider
  }
  return null
}

export const WebSearchInputSchema = z.object({
  query: z.string().min(1).describe('The main search query'),
  queries: z.array(z.string().min(1)).max(4).optional().describe('Optional additional related search queries to run in the same web search'),
  count: z.number().int().min(1).max(10).optional().describe('Number of results to return per query (1-10, default: 5)'),
  freshness: z.enum(['day', 'week', 'month', 'year']).optional().describe('Filter results by time'),
  country: z.string().min(2).max(2).optional().describe('Country code for search localization (default: US)'),
  language: z.string().min(2).max(8).optional().describe('Search language code, such as en or zh'),
  fetchPages: z.boolean().optional().describe('Also fetch and extract readable text from top result pages (default: false; usually prefer web_open for selected sources)'),
  maxPages: z.number().int().min(0).max(6).optional().describe('Maximum number of result pages to fetch across all queries (0-6, default: 3)'),
})

export const WEB_SEARCH_DESCRIPTION = `Search the web for real-time information: current events, facts that change over time (prices, weather, scores), recent releases and anything past your training data. Runs one or several related queries in a call and returns candidate sources (title, URL, snippet); then call web_open on the pages worth reading. Set fetchPages only when you want top-page text extracted in the same call.`

const WebSearchContract = defineInput(WebSearchInputSchema)

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>

interface WebSearchResultItem {
  id: string
  searchId: string
  query: string
  rank: number
  title: string
  url: string
  snippet: string
  publishedDate?: string
  source?: string
  language?: string
  extraSnippets?: string[]
  pageId?: string
}

interface WebSearchRun {
  id: string
  query: string
  resultCount: number
  results: WebSearchResultItem[]
}

interface WebSearchMetadata {
  phase?: 'searching' | 'fetching_pages' | 'ready'
  query: string
  queries?: string[]
  provider: string
  resultCount: number
  pageCount?: number
  fetchedPageCount?: number
  searches?: WebSearchRun[]
  results?: Array<{
    id?: string
    searchId?: string
    query?: string
    rank?: number
    title: string
    url: string
    snippet: string
    pageId?: string
  }>
  pages?: FetchedSearchPage[]
}

const MAX_QUERIES = 4
const DEFAULT_RESULT_COUNT = 5
const DEFAULT_MAX_PAGES = 3
const PAGE_AI_TEXT_CHARS = 2_800

export class WebSearchTool extends NetworkTool<WebSearchInput> {
  private readonly adapters: WebSearchToolAdapters

  readonly spec: ToolSpec = {
    id: 'web_search',
    title: 'Web Search',
    description: WEB_SEARCH_DESCRIPTION,
    input: WebSearchContract.schema,
    effects: ['net_fetch'],
    presentation: { kind: 'search', shell: 'default' },
    concurrency: 'parallel',
  }

  constructor(adapters: WebSearchToolAdapters = {}) {
    super()
    this.adapters = adapters
  }

  /**
   * 资源是这次要发出去的那几条 query,不是 URL —— 搜索的 URL 在 plan 阶段还不
   * 存在(provider 现拼)。写一条编造的 endpoint 进审计比写真实的 query 更没用。
   */
  protected resourcesFor(input: WebSearchInput): string[] {
    return normalizeQueries(input.query, input.queries)
  }

  protected async perform(input: WebSearchInput, ctx: RunContext): Promise<Result> {
    const {
      query,
      count = DEFAULT_RESULT_COUNT,
      freshness,
      country,
      language,
      fetchPages = false,
      maxPages = DEFAULT_MAX_PAGES,
    } = input

    const providers = this.adapters.providers ?? {}
    const provider = getConfiguredProvider(providers)
    if (!provider) {
      throw new Error('No web search provider configured. Please add a Brave Search API key in Settings → Tools → Web Search.')
    }

    const queries = normalizeQueries(query, input.queries)
    const requestedCount = Math.min(count, 10)
    const pageLimit = fetchPages ? Math.min(maxPages, 6) : 0
    const searches: WebSearchRun[] = []
    const allResults: WebSearchResultItem[] = []
    const pages: FetchedSearchPage[] = []

    /**
     * `ratio` 只在**抓页**那一段给得出来(分母是这次要抓几页,分子是抓完几页)。
     * 搜索那一段没有分母 —— 一次 provider 请求要多久没人知道,编一个比例是说谎,
     * 所以那几条进度只有 `message`(C2-b)。
     */
    const emitProgress = (
      phase: WebSearchMetadata['phase'],
      text: string,
      ratio?: number,
    ) => {
      const metadata = buildMetadata({
        phase,
        query,
        queries,
        provider: provider.id,
        searches,
        results: allResults,
        pages,
      })
      ctx.emit({
        type: 'partial',
        result: { content: [{ type: 'text', text }], details: toJsonObject(metadata) },
      })
      // C2-b:同一句话再走一次活流 —— `partial` 是给模型与账本投影的结果,
      // 这一条是给屏幕上那一行工具卡的读数,两者不是一回事。
      ctx.emit({
        type: 'progress',
        message: text,
        ...(ratio !== undefined ? { ratio } : {}),
      })
    }

    emitProgress('searching', `Searching the web for "${queries.join('" and "')}"...`)

    ctx.emit({
      type: 'annotate',
      title: `Searching: ${query}`,
      details: toJsonObject({
        phase: 'searching',
        query,
        queries,
        provider: provider.id,
        resultCount: 0,
      }),
    })

    for (const [queryIndex, currentQuery] of queries.entries()) {
      const response: SearchResponse = await provider.search(currentQuery, {
        count: requestedCount,
        country,
        language,
        freshness,
      })
      const searchId = `s${queryIndex + 1}`
      const results = response.results.map((result, resultIndex): WebSearchResultItem => ({
        id: `${searchId}-r${resultIndex + 1}`,
        searchId,
        query: currentQuery,
        rank: resultIndex + 1,
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        publishedDate: result.publishedDate,
        source: result.source,
        language: result.language,
        extraSnippets: result.extraSnippets,
      }))
      searches.push({ id: searchId, query: currentQuery, resultCount: results.length, results })
      allResults.push(...results)
      emitProgress(
        'searching',
        `Found ${allResults.length} search results across ${searches.length} ${searches.length === 1 ? 'query' : 'queries'}...`,
      )
    }

    if (pageLimit > 0 && allResults.length > 0) {
      const pageRequests = buildPageRequests(searches, pageLimit)
      emitProgress('fetching_pages', `Fetching ${pageRequests.length} result ${pageRequests.length === 1 ? 'page' : 'pages'}...`)
      await fetchSearchPages(pageRequests, {
        // 取消归本次调用的作用域;抓页自己那只表照旧在 page-fetch 里。
        signal: this.networkScope(ctx).signal,
        fetchFn: this.adapters.getFetch?.(),
        onPage: (page) => {
          pages.push(page)
          const result = allResults.find(item => item.id === page.resultId)
          if (result) result.pageId = page.id
          emitProgress(
            'fetching_pages',
            `Fetched ${pages.filter(item => item.status === 'ready').length}/${pageRequests.length} readable result pages...`,
            pageRequests.length > 0 ? pages.length / pageRequests.length : undefined,
          )
        },
      })
    }

    const resultMetadata = buildMetadata({
      phase: 'ready',
      query,
      queries,
      provider: provider.id,
      searches,
      results: allResults,
      pages,
    })

    const output = formatSearchOutput({
      query,
      queries,
      providerName: provider.name,
      searches,
      pages,
    })

    ctx.emit({
      type: 'partial',
      result: {
        content: [{ type: 'text', text: output }],
        details: toJsonObject({ phase: 'ready', ...resultMetadata }),
      },
    })

    const title = `Found ${allResults.length} results and ${resultMetadata.fetchedPageCount || 0} pages for: ${query}`
    ctx.emit({ type: 'annotate', title, details: toJsonObject(resultMetadata) })

    return { content: [{ type: 'text', text: output }], details: toJsonObject(resultMetadata) }
  }
}

export function createWebSearchTool(adapters: WebSearchToolAdapters = {}): WebSearchTool {
  return new WebSearchTool(adapters)
}

// ── 以下全部逐字沿用旧实现 ────────────────────────────────────────────────

function normalizeQueries(query: string, additional: string[] | undefined): string[] {
  const seen = new Set<string>()
  const queries: string[] = []

  for (const value of [query, ...(additional || [])]) {
    const normalized = value.trim().replace(/\s+/g, ' ')
    const key = normalized.toLowerCase()
    if (!normalized || seen.has(key)) continue
    seen.add(key)
    queries.push(normalized)
    if (queries.length >= MAX_QUERIES) break
  }

  return queries.length > 0 ? queries : [query.trim()]
}

function buildPageRequests(searches: WebSearchRun[], maxPages: number): SearchPageRequest[] {
  const requests: SearchPageRequest[] = []
  const seenUrls = new Set<string>()

  for (const search of searches) {
    for (const result of search.results) {
      const urlKey = normalizeUrlKey(result.url)
      if (!urlKey || seenUrls.has(urlKey)) continue
      seenUrls.add(urlKey)
      const pageId = `p${requests.length + 1}`
      result.pageId = pageId
      requests.push({
        id: pageId,
        resultId: result.id,
        searchId: search.id,
        query: search.query,
        title: result.title,
        url: result.url,
        snippet: result.snippet,
      })
      if (requests.length >= maxPages) return requests
    }
  }

  return requests
}

function normalizeUrlKey(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return value.trim()
  }
}

function buildMetadata(input: {
  phase: WebSearchMetadata['phase']
  query: string
  queries: string[]
  provider: string
  searches: WebSearchRun[]
  results: WebSearchResultItem[]
  pages: FetchedSearchPage[]
}): WebSearchMetadata {
  return {
    phase: input.phase,
    query: input.query,
    queries: input.queries,
    provider: input.provider,
    resultCount: input.results.length,
    pageCount: input.pages.length,
    fetchedPageCount: input.pages.filter(page => page.status === 'ready').length,
    searches: input.searches,
    results: input.results.map(result => ({
      id: result.id,
      searchId: result.searchId,
      query: result.query,
      rank: result.rank,
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      pageId: result.pageId,
    })),
    pages: input.pages,
  }
}

/**
 * §9-3(`apps/desktop-react/docs/terminal-browser-2026-09.md`)—— 搜索结果里
 * **每一个字都是别人写的**:标题、URL、摘要来自搜索引擎与被索引的那些站点,
 * `fetchPages` 打开时还会带上整段页面正文。所以整块结果经 `wrapUntrustedText`
 * 包一次,与 `web_open` **同一只函数、同一种标记**(模型要认的标记只许有一种)。
 *
 * **包一次,不是每条包一次**:这一族输出是一张给模型扫的清单,十条结果十对定界符
 * 会把清单撑成噪音,而那十条的信任级是同一档 —— 一个信封说得清。头两行(搜了什么、
 * 用的哪个引擎)留在信封**外面**:那是这台机器自己说的话,把它也圈进「不可信」里,
 * 等于连「我搜的是这个词」都不敢信了。
 *
 * `maxChars` 用包法的缺省:每页正文已经被 `truncateForAI(PAGE_AI_TEXT_CHARS)`
 * 截过一刀,这里那一刀是「整块加起来别失控」的第二道。
 */
function formatSearchOutput(input: {
  query: string
  queries: string[]
  providerName: string
  searches: WebSearchRun[]
  pages: FetchedSearchPage[]
}): string {
  const header: string[] = [
    `Search results for "${input.query}" (via ${input.providerName})`,
  ]

  if (input.queries.length > 1) {
    header.push(`Queries searched: ${input.queries.join(' | ')}`)
  }

  const lines: string[] = []
  const pagesByResultId = new Map(input.pages.map(page => [page.resultId, page]))

  for (const search of input.searches) {
    lines.push('', `## Search: ${search.query}`)
    for (const result of search.results) {
      const page = pagesByResultId.get(result.id)
      lines.push(
        `[${search.id}.${result.rank}] ${result.title}`,
        `URL: ${result.url}`,
        `Snippet: ${formatSnippet(result)}`,
      )
      if (result.publishedDate) lines.push(`Published: ${result.publishedDate}`)
      if (page?.status === 'ready' && page.text) {
        lines.push(
          `Page title: ${page.title}`,
          `Page excerpt: ${truncateForAI(page.text, PAGE_AI_TEXT_CHARS)}`,
        )
      } else if (page?.error) {
        lines.push(`Page fetch: ${page.status} (${page.error})`)
      }
      lines.push('')
    }
  }

  const body = lines.join('\n').trim()
  if (!body) return header.join('\n')
  return `${header.join('\n')}\n\n${wrapUntrustedText(body, { source: input.providerName })}`
}

function formatSnippet(result: WebSearchResultItem): string {
  const snippets = [result.snippet, ...(result.extraSnippets || [])]
    .map(item => item?.trim())
    .filter(Boolean)
  return snippets.join(' ')
}

function truncateForAI(text: string, maxChars: number): string {
  const normalized = text.trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars).trimEnd()}...`
}

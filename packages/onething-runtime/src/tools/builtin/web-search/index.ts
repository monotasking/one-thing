/**
 * Built-in Tool: Web Search
 *
 * Search the web for real-time information.
 * Supports multiple search providers (Brave, etc.)
 */

import { z } from 'zod'
import { toJsonObject } from '@onething/core'
import { Tool } from '../../tool.js'
import type { SearchProvider, SearchResponse } from './providers/types.js'
import {
  fetchSearchPages,
  type FetchedSearchPage,
  type FetchFn,
  type SearchPageRequest,
} from './page-fetch.js'

export interface WebSearchToolAdapters {
  providers?: Record<string, SearchProvider>
  getFetch?: () => FetchFn
}

// Get the first configured provider
function getConfiguredProvider(providers: Record<string, SearchProvider>): SearchProvider | null {
  for (const provider of Object.values(providers)) {
    if (provider.isConfigured()) {
      return provider
    }
  }
  return null
}

// Parameter schema
const WebSearchParameters = z.object({
  query: z.string().min(1).describe('The main search query'),
  queries: z.array(z.string().min(1)).max(4).optional().describe('Optional additional related search queries to run in the same web search'),
  count: z.number().int().min(1).max(10).optional().describe('Number of results to return per query (1-10, default: 5)'),
  freshness: z.enum(['day', 'week', 'month', 'year']).optional().describe('Filter results by time'),
  country: z.string().min(2).max(2).optional().describe('Country code for search localization (default: US)'),
  language: z.string().min(2).max(8).optional().describe('Search language code, such as en or zh'),
  fetchPages: z.boolean().optional().describe('Also fetch and extract readable text from top result pages (default: false; usually prefer web_open for selected sources)'),
  maxPages: z.number().int().min(0).max(6).optional().describe('Maximum number of result pages to fetch across all queries (0-6, default: 3)'),
})

// Metadata for UI display
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

export function createWebSearchTool(
  adapters: WebSearchToolAdapters = {},
): Tool.Info<typeof WebSearchParameters, WebSearchMetadata> {
  const providers = adapters.providers ?? {}

  return Tool.define<typeof WebSearchParameters, WebSearchMetadata>('web_search', {
    name: 'Web Search',
    description: `Search the web for real-time information: current events, facts that change over time (prices, weather, scores), recent releases and anything past your training data. Runs one or several related queries in a call and returns candidate sources (title, URL, snippet); then call web_open on the pages worth reading. Set fetchPages only when you want top-page text extracted in the same call.`,

    category: 'builtin',
    enabled: true,
    autoExecute: true,
    permissionGuard: 'safe',
    executionMode: 'parallel',
    renderKind: 'search',

    parameters: WebSearchParameters,

    async execute(args, ctx) {
      const {
        query,
        count = DEFAULT_RESULT_COUNT,
        freshness,
        country,
        language,
        fetchPages = false,
        maxPages = DEFAULT_MAX_PAGES,
      } = args

      // Get configured provider
      const provider = getConfiguredProvider(providers)
    
      if (!provider) {
        throw new Error('No web search provider configured. Please add a Brave Search API key in Settings → Tools → Web Search.')
      }

      const queries = normalizeQueries(query, args.queries)
      const requestedCount = Math.min(count, 10)
      const pageLimit = fetchPages ? Math.min(maxPages, 6) : 0
      const searches: WebSearchRun[] = []
      const allResults: WebSearchResultItem[] = []
      const pages: FetchedSearchPage[] = []

      const emitProgress = (phase: WebSearchMetadata['phase'], text: string) => {
        const metadata = buildMetadata({
          phase,
          query,
          queries,
          provider: provider.id,
          searches,
          results: allResults,
          pages,
        })
        ctx.updateResult?.({
          content: [{ type: 'text', text }],
          details: toJsonObject(metadata),
        })
      }

      emitProgress('searching', `Searching the web for "${queries.join('" and "')}"...`)

      // Update metadata with initial state
      ctx.metadata({
        title: `Searching: ${query}`,
        metadata: {
          phase: 'searching',
          query,
          queries,
          provider: provider.id,
          resultCount: 0,
        },
      })

      // Perform search
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
        searches.push({
          id: searchId,
          query: currentQuery,
          resultCount: results.length,
          results,
        })
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
          signal: ctx.abortSignal,
          fetchFn: adapters.getFetch?.(),
          onPage: (page) => {
            pages.push(page)
            const result = allResults.find(item => item.id === page.resultId)
            if (result) result.pageId = page.id
            emitProgress(
              'fetching_pages',
              `Fetched ${pages.filter(item => item.status === 'ready').length}/${pageRequests.length} readable result pages...`,
            )
          },
        })
      }

      // Format results for AI
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

      ctx.updateResult?.({
        content: [{ type: 'text', text: output }],
        details: toJsonObject({ phase: 'ready', ...resultMetadata }),
      })

      // Update metadata with results
      ctx.metadata({
        title: `Found ${allResults.length} results and ${resultMetadata.fetchedPageCount || 0} pages for: ${query}`,
        metadata: toJsonObject(resultMetadata),
      })

      return {
        title: `Found ${allResults.length} results and ${resultMetadata.fetchedPageCount || 0} pages for: ${query}`,
        output,
        metadata: resultMetadata,
      }
    },
  })
}

export const WebSearchTool = createWebSearchTool()

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

function formatSearchOutput(input: {
  query: string
  queries: string[]
  providerName: string
  searches: WebSearchRun[]
  pages: FetchedSearchPage[]
}): string {
  const lines: string[] = [
    `Search results for "${input.query}" (via ${input.providerName})`,
  ]

  if (input.queries.length > 1) {
    lines.push(`Queries searched: ${input.queries.join(' | ')}`)
  }

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

  return lines.join('\n').trim()
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

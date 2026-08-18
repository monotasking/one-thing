/**
 * R3a 移植 —— `web_open`。§4 的 `NetworkTool` 一族。
 *
 * 描述、参数、输出格式、metadata 形状逐字沿用旧
 * `tools/builtin/web-search/open.ts`;抓页复用 `page-fetch.ts` 的
 * `fetchSearchPage`,一行不重写。
 */

import { z } from 'zod'
import { toJsonObject } from '@onething/core'
import type { Preview, Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import {
  fetchSearchPage,
  type FetchedSearchPage,
  type FetchFn,
} from '../../tools/builtin/web-search/page-fetch.js'
import { defineInput } from '../contract.js'
import { NetworkTool } from '../families/network.js'

export interface WebOpenToolAdapters {
  getFetch?: () => FetchFn
}

export const WebOpenInputSchema = z.object({
  url: z.string().url().describe('The HTTP or HTTPS URL to open and read'),
  title: z.string().optional().describe('Optional known page title from search results'),
  query: z.string().optional().describe('Optional search query or reason for opening this page'),
  snippet: z.string().optional().describe('Optional search-result snippet for this page'),
  maxChars: z.number().int().min(1000).max(30000).optional().describe('Maximum readable characters to return from the page (default: 12000)'),
})

export const WEB_OPEN_DESCRIPTION = `Open a web page and extract readable text from it.

Use this after web_search identifies a promising source, or when the user gives
a direct URL that should be read. This is the "open result" step in a
ChatGPT-style web search workflow.`

const WebOpenContract = defineInput(WebOpenInputSchema)

export type WebOpenInput = z.infer<typeof WebOpenInputSchema>

interface WebOpenResultEntry {
  id: string
  searchId: string
  query: string
  rank: number
  title: string
  url: string
  snippet: string
  pageId: string
}

interface WebOpenMetadata {
  mode: 'open'
  phase: 'opening' | 'ready'
  query: string
  provider: 'direct'
  resultCount: number
  pageCount: number
  fetchedPageCount: number
  searches: Array<{ id: string; query: string; resultCount: number; results: WebOpenResultEntry[] }>
  results: WebOpenResultEntry[]
  pages: FetchedSearchPage[]
}

const OPEN_SEARCH_ID = 'open'
const OPEN_RESULT_ID = 'open-r1'
const OPEN_PAGE_ID = 'p1'

export class WebOpenTool extends NetworkTool<WebOpenInput> {
  private readonly adapters: WebOpenToolAdapters

  readonly spec: ToolSpec = {
    id: 'web_open',
    title: 'Web Open',
    description: WEB_OPEN_DESCRIPTION,
    input: WebOpenContract.schema,
    effects: ['net_fetch'],
    presentation: { kind: 'search', shell: 'default' },
    concurrency: 'parallel',
  }

  constructor(adapters: WebOpenToolAdapters = {}) {
    super()
    this.adapters = adapters
  }

  protected resourcesFor(input: WebOpenInput): string[] {
    return [input.url]
  }

  protected previewFor(input: WebOpenInput): Preview {
    return { title: `Open page: ${input.url}`, metadata: { url: input.url } }
  }

  protected async perform(input: WebOpenInput, ctx: RunContext): Promise<Result> {
    const query = input.query?.trim() || input.url
    const title = input.title?.trim() || input.url
    const snippet = input.snippet?.trim() || ''

    const openingMetadata = buildOpenMetadata({
      phase: 'opening',
      query,
      page: null,
      title,
      url: input.url,
      snippet,
    })

    ctx.emit({
      type: 'partial',
      result: {
        content: [{ type: 'text', text: `Opening ${input.url}...` }],
        details: toJsonObject(openingMetadata),
      },
    })
    ctx.emit({ type: 'annotate', title: `Opening: ${title}`, details: toJsonObject(openingMetadata) })

    const page = await fetchSearchPage({
      id: OPEN_PAGE_ID,
      resultId: OPEN_RESULT_ID,
      searchId: OPEN_SEARCH_ID,
      query,
      title,
      url: input.url,
      snippet,
    }, {
      signal: this.networkScope(ctx).signal,
      maxTextChars: input.maxChars,
      fetchFn: this.adapters.getFetch?.(),
    })

    const metadata = buildOpenMetadata({
      phase: 'ready',
      query,
      page,
      title: page.title || title,
      url: page.finalUrl || page.url,
      snippet: page.excerpt || page.description || snippet,
    })
    const output = formatOpenOutput(page)
    const resultTitle = page.status === 'ready' ? `Opened: ${page.title}` : `Could not open: ${title}`

    ctx.emit({
      type: 'partial',
      result: { content: [{ type: 'text', text: output }], details: toJsonObject(metadata) },
    })
    ctx.emit({ type: 'annotate', title: resultTitle, details: toJsonObject(metadata) })

    return { content: [{ type: 'text', text: output }], details: toJsonObject(metadata) }
  }
}

export function createWebOpenTool(adapters: WebOpenToolAdapters = {}): WebOpenTool {
  return new WebOpenTool(adapters)
}

// ── 以下逐字沿用旧实现 ────────────────────────────────────────────────────

function buildOpenMetadata(input: {
  phase: WebOpenMetadata['phase']
  query: string
  page: FetchedSearchPage | null
  title: string
  url: string
  snippet: string
}): WebOpenMetadata {
  const page = input.page
  const result: WebOpenResultEntry = {
    id: OPEN_RESULT_ID,
    searchId: OPEN_SEARCH_ID,
    query: input.query,
    rank: 1,
    title: page?.title || input.title,
    url: page?.finalUrl || input.url,
    snippet: page?.excerpt || input.snippet,
    pageId: OPEN_PAGE_ID,
  }

  return {
    mode: 'open',
    phase: input.phase,
    query: input.query,
    provider: 'direct',
    resultCount: 1,
    pageCount: page ? 1 : 0,
    fetchedPageCount: page?.status === 'ready' ? 1 : 0,
    searches: [{ id: OPEN_SEARCH_ID, query: input.query, resultCount: 1, results: [result] }],
    results: [result],
    pages: page ? [page] : [],
  }
}

function formatOpenOutput(page: FetchedSearchPage): string {
  if (page.status !== 'ready' || !page.text) {
    return [
      `Could not read page: ${page.title || page.url}`,
      `URL: ${page.finalUrl || page.url}`,
      page.error ? `Error: ${page.error}` : '',
    ].filter(Boolean).join('\n')
  }

  return [
    `Opened page: ${page.title}`,
    `URL: ${page.finalUrl || page.url}`,
    page.description ? `Description: ${page.description}` : '',
    '',
    page.text,
  ].filter(line => line !== '').join('\n')
}

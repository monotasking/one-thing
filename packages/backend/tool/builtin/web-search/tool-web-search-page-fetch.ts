const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 1_500_000
const DEFAULT_MAX_TEXT_CHARS = 12_000
const DEFAULT_CONCURRENCY = 3

export type FetchFn = typeof globalThis.fetch

export interface SearchPageRequest {
  id: string
  resultId: string
  searchId: string
  query: string
  title: string
  url: string
  snippet: string
}

export interface FetchedSearchPage {
  id: string
  resultId: string
  searchId: string
  query: string
  title: string
  url: string
  finalUrl?: string
  snippet: string
  status: 'ready' | 'failed' | 'skipped'
  statusCode?: number
  contentType?: string
  description?: string
  text?: string
  excerpt?: string
  charCount?: number
  wordCount?: number
  truncated?: boolean
  fetchMs?: number
  error?: string
}

export interface FetchSearchPagesOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  maxTextChars?: number
  concurrency?: number
  fetchFn?: FetchFn
  onPage?: (page: FetchedSearchPage) => void
}

interface ReadResponseTextResult {
  text: string
  truncated: boolean
}

interface ExtractedPageText {
  title: string
  description: string
  text: string
}

export async function fetchSearchPages(
  requests: SearchPageRequest[],
  options: FetchSearchPagesOptions = {},
): Promise<FetchedSearchPage[]> {
  const fetchFn = options.fetchFn ?? getDefaultFetch()
  const concurrency = clampInt(options.concurrency ?? DEFAULT_CONCURRENCY, 1, 6)
  const results = new Array<FetchedSearchPage>(requests.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < requests.length) {
      const index = nextIndex
      nextIndex += 1
      const page = await fetchSearchPage(requests[index], {
        ...options,
        fetchFn,
      })
      results[index] = page
      options.onPage?.(page)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, () => worker()))
  return results.filter(Boolean)
}

export async function fetchSearchPage(
  request: SearchPageRequest,
  options: FetchSearchPagesOptions = {},
): Promise<FetchedSearchPage> {
  const start = Date.now()
  const basePage = {
    id: request.id,
    resultId: request.resultId,
    searchId: request.searchId,
    query: request.query,
    title: request.title,
    url: request.url,
    snippet: request.snippet,
  }

  if (!isHttpUrl(request.url)) {
    return {
      ...basePage,
      status: 'skipped',
      fetchMs: Date.now() - start,
      error: 'Only HTTP and HTTPS pages can be fetched.',
    }
  }

  const timeout = createAbortTimeout(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const fetchFn = options.fetchFn ?? getDefaultFetch()
    const response = await fetchFn(request.url, {
      redirect: 'follow',
      signal: timeout.signal,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        'User-Agent': 'onething-web-search/1.0',
      },
    })

    const contentType = response.headers.get('content-type') || ''
    if (!response.ok) {
      return {
        ...basePage,
        status: 'failed',
        statusCode: response.status,
        contentType,
        finalUrl: response.url || request.url,
        fetchMs: Date.now() - start,
        error: `HTTP ${response.status}`,
      }
    }

    if (!isReadableContentType(contentType)) {
      return {
        ...basePage,
        status: 'skipped',
        statusCode: response.status,
        contentType,
        finalUrl: response.url || request.url,
        fetchMs: Date.now() - start,
        error: contentType ? `Unsupported content type: ${contentType}` : 'Unsupported content type.',
      }
    }

    const raw = await readResponseText(response, options.maxBytes ?? DEFAULT_MAX_BYTES)
    const extracted = extractReadablePage(raw.text, response.url || request.url)
    const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
    const text = limitText(extracted.text, maxTextChars)
    const wasTextTruncated = extracted.text.length > text.length

    return {
      ...basePage,
      status: text ? 'ready' : 'failed',
      statusCode: response.status,
      contentType,
      finalUrl: response.url || request.url,
      title: extracted.title || request.title,
      description: extracted.description,
      text,
      excerpt: makeExcerpt(text || extracted.description || request.snippet),
      charCount: text.length,
      wordCount: countWords(text),
      truncated: raw.truncated || wasTextTruncated,
      fetchMs: Date.now() - start,
      error: text ? undefined : 'No readable text found on the page.',
    }
  } catch (error) {
    return {
      ...basePage,
      status: 'failed',
      fetchMs: Date.now() - start,
      error: timeout.timedOut
        ? 'Timed out while fetching the page.'
        : error instanceof Error ? error.message : 'Failed to fetch page.',
    }
  } finally {
    timeout.cleanup()
  }
}

export function extractReadablePage(html: string, pageUrl = ''): ExtractedPageText {
  const title = cleanInlineText(
    findMetaContent(html, ['og:title', 'twitter:title']) ||
    firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i) ||
    '',
  )
  const description = cleanInlineText(findMetaContent(html, [
    'description',
    'og:description',
    'twitter:description',
  ]))

  const bodyHtml = firstMatch(html, /<body\b[^>]*>([\s\S]*?)<\/body>/i) || html
  const mainHtml =
    firstMatch(bodyHtml, /<main\b[^>]*>([\s\S]*?)<\/main>/i) ||
    firstMatch(bodyHtml, /<article\b[^>]*>([\s\S]*?)<\/article>/i) ||
    bodyHtml

  const text = htmlToText(mainHtml)
  return {
    title: title || inferTitleFromUrl(pageUrl),
    description,
    text,
  }
}

function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')

  const withBreaks = withoutNoise
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|main|aside|header|footer|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')

  return normalizeText(decodeHtmlEntities(withBreaks))
}

function normalizeText(value: string): string {
  const lines = value
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .split('\n')
    .map(line => line.replace(/[ ]{2,}/g, ' ').trim())
    .filter(line => line.length > 0)

  const deduped: string[] = []
  for (const line of lines) {
    if (line === deduped[deduped.length - 1]) continue
    deduped.push(line)
  }

  return deduped.join('\n').trim()
}

function findMetaContent(html: string, names: string[]): string {
  const wanted = new Set(names.map(name => name.toLowerCase()))
  const metaTags = html.match(/<meta\b[^>]*>/gi) || []

  for (const tag of metaTags) {
    const name = readAttr(tag, 'name') || readAttr(tag, 'property') || readAttr(tag, 'itemprop')
    if (!name || !wanted.has(name.toLowerCase())) continue
    const content = readAttr(tag, 'content')
    if (content) return content
  }

  return ''
}

function readAttr(tag: string, attr: string): string {
  const pattern = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>=]+))`, 'i')
  const match = tag.match(pattern)
  return decodeHtmlEntities(match?.[1] || match?.[2] || match?.[3] || '')
}

function firstMatch(value: string, pattern: RegExp): string {
  return value.match(pattern)?.[1] || ''
}

function cleanInlineText(value: string): string {
  return normalizeText(decodeHtmlEntities(value)).replace(/\n+/g, ' ').trim()
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '...',
    laquo: '"',
    ldquo: '"',
    lsquo: "'",
    lt: '<',
    mdash: '-',
    nbsp: ' ',
    ndash: '-',
    quot: '"',
    raquo: '"',
    rdquo: '"',
    rsquo: "'",
  }

  return value
    .replace(/&#(\d+);/g, (_match, code) => {
      const point = Number(code)
      return Number.isFinite(point) ? String.fromCodePoint(point) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const point = parseInt(code, 16)
      return Number.isFinite(point) ? String.fromCodePoint(point) : ''
    })
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match)
}

async function readResponseText(response: Response, maxBytes: number): Promise<ReadResponseTextResult> {
  const body = response.body
  if (!body) {
    const text = await response.text()
    return {
      text: text.slice(0, maxBytes),
      truncated: text.length > maxBytes,
    }
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let truncated = false

  while (received < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue

    const remaining = maxBytes - received
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining))
      received += remaining
      truncated = true
      await reader.cancel()
      break
    }

    chunks.push(value)
    received += value.byteLength
  }

  if (received >= maxBytes) {
    truncated = true
    await reader.cancel().catch(() => {})
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return {
    text: new TextDecoder().decode(merged),
    truncated,
  }
}

function isReadableContentType(contentType: string): boolean {
  if (!contentType) return true
  const normalized = contentType.toLowerCase()
  return normalized.includes('text/html') ||
    normalized.includes('application/xhtml+xml') ||
    normalized.includes('text/plain')
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function createAbortTimeout(parentSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const abortFromParent = () => controller.abort()

  if (parentSignal?.aborted) {
    controller.abort()
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut
    },
    cleanup() {
      clearTimeout(timeout)
      parentSignal?.removeEventListener('abort', abortFromParent)
    },
  }
}

function inferTitleFromUrl(value: string): string {
  try {
    const url = new URL(value)
    return url.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function makeExcerpt(text: string, maxChars = 420): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars).trimEnd()}...`
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars).trimEnd()
}

function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}]+/gu)
  return matches?.length || 0
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function getDefaultFetch(): FetchFn {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('No fetch implementation is available for web page fetching.')
  }
  return globalThis.fetch.bind(globalThis) as FetchFn
}

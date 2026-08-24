/**
 * Brave Search Provider
 * 
 * Uses Brave Search API for web search.
 * API docs: https://brave.com/search/api/
 */

import type { SearchProvider, SearchOptions, SearchResponse, SearchResult } from './types.js'
import {
  toJsonObject,
  type JsonObject,
  type JsonObjectProperty,
} from '@onething/core'
import type { FetchFn } from '../page-fetch.js'

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search'
const RATE_LIMIT_SAFETY_MS = 100
const MAX_RATE_LIMIT_RETRIES = 2
const BRAVE_SEARCH_LANGUAGES = new Set([
  'ar', 'eu', 'bn', 'bg', 'ca', 'zh-hans', 'zh-hant', 'hr', 'cs', 'da', 'nl',
  'en', 'en-gb', 'et', 'fi', 'fr', 'gl', 'de', 'el', 'gu', 'he', 'hi', 'hu',
  'is', 'it', 'jp', 'kn', 'ko', 'lv', 'lt', 'ms', 'ml', 'mr', 'nb', 'pl',
  'pt-br', 'pt-pt', 'pa', 'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'sv', 'ta',
  'te', 'th', 'tr', 'uk', 'vi',
])
const BRAVE_LANGUAGE_ALIASES: Record<string, string> = {
  ja: 'jp',
  no: 'nb',
  pt: 'pt-br',
  zh: 'zh-hans',
  'zh-cn': 'zh-hans',
  'zh-sg': 'zh-hans',
  'zh-hans-cn': 'zh-hans',
  'zh-hans-sg': 'zh-hans',
  'zh-hk': 'zh-hant',
  'zh-mo': 'zh-hant',
  'zh-tw': 'zh-hant',
  'zh-hant-hk': 'zh-hant',
  'zh-hant-mo': 'zh-hant',
  'zh-hant-tw': 'zh-hant',
}

interface RateLimitSnapshot {
  perSecondLimit?: number
  perSecondRemaining?: number
  perSecondResetMs?: number
}

interface BraveRequestResult {
  response: Response
  bodyText?: string
}

export interface BraveSearchProviderAdapters {
  getApiKey(): string | undefined
  getFetch?: () => FetchFn
}

let requestQueue: Promise<void> = Promise.resolve()
let nextAllowedRequestAt = 0
let learnedMinIntervalMs = 0

export class BraveSearchProvider implements SearchProvider {
  name = 'Brave Search'
  id = 'brave'

  constructor(private readonly adapters: BraveSearchProviderAdapters) {}

  isConfigured(): boolean {
    const apiKey = this.adapters.getApiKey()
    return !!apiKey && apiKey.length > 0
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const apiKey = this.adapters.getApiKey()

    if (!apiKey) {
      throw new Error('Brave Search API key not configured. Please add it in Settings → Tools → Web Search.')
    }

    const { count = 5, country = 'US', language, freshness } = options

    const params = new URLSearchParams({
      q: query,
      count: String(Math.min(count, 20)),  // Brave max is 20
      country,
    })

    const searchLanguage = normalizeBraveSearchLanguage(language)
    if (searchLanguage) {
      params.set('search_lang', searchLanguage)
    }

    if (freshness) {
      params.set('freshness', freshness)
    }

    const fetchFn = this.adapters.getFetch?.() ?? getDefaultFetch()
    const { response, bodyText } = await withBraveRequestQueue(() =>
      requestWithRateLimitRetry(() => fetchFn(`${BRAVE_API_URL}?${params}`, {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey,
        },
      })),
    )

    if (!response.ok) {
      const error = bodyText ?? await response.text()
      throw new Error(`Brave Search API error: ${response.status} - ${error}`)
    }

    const data = toJsonObject(await response.json())
    const web = toJsonObject(data.web)
    const rawResults = Array.isArray(web.results) ? web.results : []
    
    const results: SearchResult[] = rawResults.map((item) => {
      const result = toJsonObject(item)
      const profile = toJsonObject(result.profile)
      return {
        title: stringValue(result.title),
        url: stringValue(result.url),
        snippet: stringValue(result.description),
        publishedDate: stringValue(result.age),
        source: stringValue(profile.name),
        language: stringValue(result.language),
        extraSnippets: stringArrayValue(result.extra_snippets),
      }
    })

    return {
      query,
      results,
      totalResults: numberValue(web.total),
      provider: this.id,
    }
  }
}

export function createBraveSearchProvider(adapters: BraveSearchProviderAdapters): BraveSearchProvider {
  return new BraveSearchProvider(adapters)
}

const braveSearchProviderAdapters: BraveSearchProviderAdapters = {
  getApiKey: () => undefined,
};
export const braveProvider = createBraveSearchProvider(braveSearchProviderAdapters)

async function withBraveRequestQueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = requestQueue.catch(() => {})
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  requestQueue = previous.then(() => current)

  await previous
  try {
    return await task()
  } finally {
    release()
  }
}

async function requestWithRateLimitRetry(fetchRequest: () => Promise<Response>): Promise<BraveRequestResult> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    await waitForRateLimitWindow()
    const response = await fetchRequest()
    updateRateLimitFromHeaders(response.headers)

    if (response.status !== 429) {
      return { response }
    }

    const bodyText = await response.text()
    updateRateLimitFromErrorBody(bodyText)

    if (attempt >= MAX_RATE_LIMIT_RETRIES) {
      return { response, bodyText }
    }

    await sleep(rateLimitRetryDelayMs(response.headers, bodyText, attempt))
  }

  throw new Error('Unexpected Brave Search retry state')
}

async function waitForRateLimitWindow(): Promise<void> {
  const delayMs = nextAllowedRequestAt - Date.now()
  if (delayMs > 0) {
    await sleep(delayMs)
  }
}

function updateRateLimitFromHeaders(headers: Headers): void {
  const snapshot = parseRateLimitHeaders(headers)
  if (!snapshot) return

  const now = Date.now()
  if (snapshot.perSecondLimit && snapshot.perSecondLimit > 0) {
    learnedMinIntervalMs = Math.ceil(1000 / snapshot.perSecondLimit) + RATE_LIMIT_SAFETY_MS
  }

  const resetMs = snapshot.perSecondRemaining !== undefined && snapshot.perSecondRemaining < 1
    ? snapshot.perSecondResetMs ?? learnedMinIntervalMs
    : 0
  const delayMs = Math.max(learnedMinIntervalMs, resetMs)
  if (delayMs > 0) {
    nextAllowedRequestAt = Math.max(nextAllowedRequestAt, now + delayMs)
  }
}

function updateRateLimitFromErrorBody(bodyText: string): void {
  let data: JsonObject = {}
  try {
    data = toJsonObject(JSON.parse(bodyText))
  } catch {
    return
  }

  const error = toJsonObject(data.error)
  const meta = toJsonObject(error.meta)
  const rateLimit = Number(meta.rate_limit)
  if (!Number.isFinite(rateLimit) || rateLimit <= 0) return

  learnedMinIntervalMs = Math.ceil(1000 / rateLimit) + RATE_LIMIT_SAFETY_MS
  nextAllowedRequestAt = Math.max(nextAllowedRequestAt, Date.now() + learnedMinIntervalMs)
}

function stringValue(value: JsonObjectProperty): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: JsonObjectProperty): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArrayValue(value: JsonObjectProperty): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length > 0 ? strings : undefined
}

function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot | null {
  const limits = parseNumberList(headers.get('X-RateLimit-Limit'))
  const remaining = parseNumberList(headers.get('X-RateLimit-Remaining'))
  const resets = parseNumberList(headers.get('X-RateLimit-Reset'))
  const windows = parsePolicyWindows(headers.get('X-RateLimit-Policy'))

  if (limits.length === 0 && remaining.length === 0 && resets.length === 0) return null

  const perSecondIndex = windows.findIndex(window => window === 1)
  const index = perSecondIndex >= 0 ? perSecondIndex : 0
  const resetSeconds = resets[index]

  return {
    perSecondLimit: limits[index],
    perSecondRemaining: remaining[index],
    perSecondResetMs: Number.isFinite(resetSeconds) ? Math.ceil(resetSeconds * 1000) + RATE_LIMIT_SAFETY_MS : undefined,
  }
}

function parseNumberList(value: string | null): number[] {
  if (!value) return []
  return value
    .split(',')
    .map(part => Number(part.trim()))
    .filter(number => Number.isFinite(number))
}

function parsePolicyWindows(value: string | null): number[] {
  if (!value) return []
  return value
    .split(',')
    .map((part) => {
      const match = part.match(/(?:^|;)\s*w=(\d+(?:\.\d+)?)\s*(?:;|$)/i)
      return match ? Number(match[1]) : Number.NaN
    })
    .filter(number => Number.isFinite(number))
}

function rateLimitRetryDelayMs(headers: Headers, bodyText: string, attempt: number): number {
  const retryAfterMs = parseRetryAfterMs(headers.get('Retry-After'))
  const resetMs = parseRateLimitHeaders(headers)?.perSecondResetMs
  const bodyDelayMs = rateLimitDelayFromErrorBody(bodyText)
  const fallbackMs = (2 ** attempt) * 1000 + RATE_LIMIT_SAFETY_MS
  return Math.max(retryAfterMs, resetMs ?? 0, bodyDelayMs, fallbackMs)
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000) + RATE_LIMIT_SAFETY_MS
  const timestamp = Date.parse(value)
  if (!Number.isNaN(timestamp)) return Math.max(0, timestamp - Date.now()) + RATE_LIMIT_SAFETY_MS
  return 0
}

function rateLimitDelayFromErrorBody(bodyText: string): number {
  try {
    const data = JSON.parse(bodyText)
    const rateLimit = Number(data?.error?.meta?.rate_limit)
    if (Number.isFinite(rateLimit) && rateLimit > 0) {
      return Math.ceil(1000 / rateLimit) + RATE_LIMIT_SAFETY_MS
    }
  } catch {
    // Ignore malformed error bodies.
  }
  return 0
}

function normalizeBraveSearchLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined

  const normalized = language.trim().toLowerCase().replace(/_/g, '-')
  const mapped = BRAVE_LANGUAGE_ALIASES[normalized] ?? normalized
  return BRAVE_SEARCH_LANGUAGES.has(mapped) ? mapped : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

export function __resetBraveRateLimiterForTests(): void {
  requestQueue = Promise.resolve()
  nextAllowedRequestAt = 0
  learnedMinIntervalMs = 0
}

function getDefaultFetch(): FetchFn {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('No fetch implementation is available for Brave Search.')
  }
  return globalThis.fetch.bind(globalThis) as FetchFn
}

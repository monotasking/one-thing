/**
 * Web Search Provider Types
 */

export interface SearchResult {
  title: string
  url: string
  snippet: string
  publishedDate?: string
  source?: string
  language?: string
  extraSnippets?: string[]
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
  totalResults?: number
  provider: string
}

export interface SearchProvider {
  name: string
  id: string
  search(query: string, options?: SearchOptions): Promise<SearchResponse>
  isConfigured(): boolean
}

export interface SearchOptions {
  count?: number        // Number of results (default: 5)
  country?: string      // Country code (e.g., 'US', 'CN')
  language?: string     // Language code (e.g., 'en', 'zh')
  freshness?: string    // Time filter (e.g., 'day', 'week', 'month')
}

import {
  configureOnethingSearchProviders,
  createDailyNote as createRuntimeDailyNote,
  executeSearch as executeRuntimeSearch,
  type OnethingSearchCategory,
} from '@onething/runtime/search'
import type { SearchResult } from '@shared/ipc/search.js'
import { createAppSearchProvidersAdapters } from './adapters.js'
import { appendPluginSearchResults } from './plugin-search-registry.js'

export { invokePluginSearchAction, PLUGIN_SEARCH_ACTION_PREFIX } from './plugin-search-registry.js'

let searchProvidersConfigured = false

/** Explicit assembly step; also self-ensured by this module's wrappers. */
export function configureAppSearchProviders(): void {
  if (searchProvidersConfigured) return
  searchProvidersConfigured = true
  configureOnethingSearchProviders(createAppSearchProvidersAdapters())
}

export function createDailyNote(filePath: string): Promise<string> {
  configureAppSearchProviders()
  return createRuntimeDailyNote(filePath)
}

export async function executeSearch(
  query: string,
  category: OnethingSearchCategory,
  limit = 20,
): Promise<SearchResult[]> {
  configureAppSearchProviders()
  const builtin = await executeRuntimeSearch(query, category, limit) as SearchResult[]
  // 插件供给方(M2)的并入门控在 registry；facade 保持极薄。
  return appendPluginSearchResults(builtin, query, category, limit)
}

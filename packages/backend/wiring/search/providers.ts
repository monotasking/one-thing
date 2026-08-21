import {
  configureOnethingSearchProviders,
  createDailyNote as createRuntimeDailyNote,
  executeSearch as executeRuntimeSearch,
  type OnethingSearchCategory,
} from '@onething/runtime/search'
import type { SearchResult } from '@shared/ipc/search.js'
import { listPrompts } from '@onething/runtime/prompts/store-bound'
import { getCurrentSessionId } from '../../stores/app-state.js'
import { getConnectedDirectoriesForSession } from '../../stores/connected-directories.js'
import { getSession, getSessionsList } from '../../stores/sessions.js'
import { sessionReads } from '../../session/reads.js'
import { getSettings } from '../../stores/settings.js'
import { listFiles } from '../../utils/ripgrep.js'
import { getVariablesStore } from '@onething/runtime/variables/store-bound'
import { appendPluginSearchResults } from './plugin-search-registry.js'

export { invokePluginSearchAction, PLUGIN_SEARCH_ACTION_PREFIX } from './plugin-search-registry.js'

let searchProvidersConfigured = false

/** Explicit assembly step; also self-ensured by this module's wrappers. */
export function configureAppSearchProviders(): void {
  if (searchProvidersConfigured) return
  searchProvidersConfigured = true
  configureOnethingSearchProviders({
    getSessionsList,
    // 全库消息搜索:raw 语义(不进 LRU、不 sanitize、不回写),P0.2 区 ②。
    iterateSessionMessages: (sessionId: string) => sessionReads.iterateMessagesRaw(sessionId),
    getSession,
    getCurrentSessionId,
    getSettings,
    getVariablesStore,
    // 搜索窗没有请求级会话号:当前会话是这里能拿到的最诚实的空间语境(批 B2)。
    getConnectedDirectories: () => getConnectedDirectoriesForSession(getCurrentSessionId()),
    listFiles,
    listPrompts,
  })
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

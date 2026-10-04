/**
 * `web_search` / `web_open` 两只工具的适配器工厂(D191,从 `toolkit-adapters.ts` 拆出)。
 *
 * 它们只依赖设置(Brave 的 key、受代理与策略管着的 fetch)与 tool 的检索服务商,本来就不引上层功能,
 * 所以留在 toolkit,并作为目录的缺省适配器(`toolkit-tier-catalogs.ts` 的 `resolve`)。
 * 内容与旧 `app/tools/builtin/*.ts` 里那几行**逐字相同**。
 */
import {
  createBraveSearchProvider,
  type BraveSearchProviderAdapters,
  type SearchProvider,
} from '@onething/backend/tool'
import { createRequiredAppFetch, getSettings } from '@onething/backend/settings'
import type { WebOpenToolAdapters } from './builtin/toolkit-builtin-web-open.js'
import type { WebSearchToolAdapters } from './builtin/toolkit-builtin-web-search.js'

const createWebSearchFetch = () => createRequiredAppFetch({ policy: 'webSearch' })

export function webSearchAdapters(): WebSearchToolAdapters {
  const braveSearchProviderAdapters: BraveSearchProviderAdapters = {
    getApiKey: () => getSettings().tools?.webSearch?.braveApiKey,
    getFetch: createWebSearchFetch,
  };
  const providers: Record<string, SearchProvider> = {
    brave: createBraveSearchProvider(braveSearchProviderAdapters),
  }
  return { providers, getFetch: createWebSearchFetch }
}

export function webOpenAdapters(): WebOpenToolAdapters {
  return { getFetch: createWebSearchFetch }
}

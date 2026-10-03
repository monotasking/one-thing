/**
 * 远端型基座(插件等进程外来源)。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 第四行
 *
 * 调出去、限时、不分页。限时**不在这里包一层** —— fanout 已经按 manifest.budget
 * 派生好 AbortSignal 传进来了(§6.4 ②),这里只把它交给调用方,并在它已经取消时
 * 一步都不走。
 */

import type {
  Candidate,
  PageRequest,
  SearchContext,
  SearchPage,
  SearchQuery,
} from '../candidate.js'
import type { CapabilityManifest, SearchCapability } from '../capability.js'

export interface RemoteCapabilityOptions {
  manifest: CapabilityManifest
  call(query: SearchQuery, ctx: SearchContext, limit: number): Promise<readonly Candidate[]>
  supports?(query: SearchQuery): boolean
  now?: () => number
}

export function remoteCapability(options: RemoteCapabilityOptions): SearchCapability {
  const manifest = options.manifest
  const now = options.now ?? (() => Date.now())

  return {
    manifest,
    supports: options.supports ?? (query => query.raw.trim().length > 0),

    async search(query: SearchQuery, page: PageRequest, ctx: SearchContext): Promise<SearchPage> {
      const startedAt = now()
      if (ctx.signal.aborted) return { items: [], took: 0 }

      const items = await options.call(query, ctx, page.limit)
      return {
        items: items.slice(0, Math.max(0, page.limit)),
        took: now() - startedAt,
      }
    },
  }
}

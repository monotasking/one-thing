/**
 * 每日笔记检索能力。
 *
 * 设计:docs/design/search-index-2026-09.md §10 S2 行。
 *
 * `supports` 这一格是**唯一一处**旧路的取舍必须由 manifest 自己说的:今天 `all` 档
 * 那句 `includeDaily = Boolean(normalizeOnethingSearchQuery(query))` —— 空词的 `all`
 * 不问每日笔记,而空词的**单类**档要问(它会答「新建今天的日记」那条快捷项)。
 * 在联邦骨架里这正是 `supports(query)` 的定义:`all` 档由 fanout 按它筛,单类档
 * 由调用方点名、不过筛(`selectCapabilities`)。**旧路那个 if 于是消失,不是搬家。**
 */

import type { CapabilityManifest, SearchCapability } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { createOnethingSearchRuntimeAdapters } from '../providers.js'
import { normalizeOnethingSearchQuery } from '../search-runtime.js'
import { legacyScanCapability } from './legacy.js'

/** 这一类的目标形:一篇笔记文件;`actionId` 在「今天还没建」那条上才有。 */
export interface DailyTarget {
  kind: 'daily'
  payload: { filePath: string; actionId?: string }
}

export const dailySearchManifest: CapabilityManifest = {
  id: 'daily',
  labelKey: 'search.capability.daily',
  icon: 'FileText',
  kind: 'scan',
  // 扫描型这一期不设超时(`0` = core `deriveSignal` 只在 `timeoutMs > 0` 时才装计时器):
  // 旧扫描路一道刹车也没有,钉一个真预算会让慢盘 / 大店从「出结果」变成「没搜成」——
  // S2 的判据是行为零变化,不许多一道刹车。S3 换成索引型之后再钉真预算。
  budget: { default: 6, timeoutMs: 0 },
  order: 3,
  orderWhenIntent: { actions: 4 },
  relax: false,
}

export function createDailySearchCapability(
  adapters: OnethingSearchProvidersAdapters,
): SearchCapability {
  const legacy = createOnethingSearchRuntimeAdapters(adapters)
  return legacyScanCapability({
    manifest: dailySearchManifest,
    run: (query, limit) => legacy.searchDailyNotes(query, limit),
    supports: query => normalizeOnethingSearchQuery(query.raw).length > 0,
    target: result => ({
      kind: 'daily',
      payload: { filePath: result.filePath ?? '', actionId: result.actionId },
    } satisfies DailyTarget),
  })
}

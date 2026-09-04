/**
 * 文件名检索能力(按名扫,不看内容 —— 文件内容源是 S8,§13)。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 第二行 / §10 S2 行。
 */

import type { CapabilityManifest, SearchCapability } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { createOnethingSearchRuntimeAdapters } from '../providers.js'
import { legacyScanCapability } from './legacy.js'

/** 这一类的目标形。 */
export interface FileTarget {
  kind: 'file'
  payload: { filePath: string }
}

export const filesSearchManifest: CapabilityManifest = {
  id: 'files',
  labelKey: 'search.capability.files',
  icon: 'FolderTree',
  kind: 'scan',
  // 扫描型这一期不设超时(`0` = core `deriveSignal` 只在 `timeoutMs > 0` 时才装计时器):
  // 旧扫描路一道刹车也没有,钉一个真预算会让慢盘 / 大店从「出结果」变成「没搜成」——
  // S2 的判据是行为零变化,不许多一道刹车。S3 换成索引型之后再钉真预算。
  budget: { default: 10, timeoutMs: 0 },
  order: 4,
  orderWhenIntent: { actions: 5 },
  relax: false,
}

export function createFilesSearchCapability(
  adapters: OnethingSearchProvidersAdapters,
): SearchCapability {
  const legacy = createOnethingSearchRuntimeAdapters(adapters)
  return legacyScanCapability({
    manifest: filesSearchManifest,
    run: (query, limit) => legacy.searchFiles(query, limit),
    // 空词旧路答 `[]`;恒真是为了让 `all` 档的分组里有这一格(同 messages)。
    supports: () => true,
    target: result => ({ kind: 'file', payload: { filePath: result.filePath ?? '' } } satisfies FileTarget),
  })
}

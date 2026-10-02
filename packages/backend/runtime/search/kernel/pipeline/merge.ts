/**
 * merge:单类是恒等,全部档是「按组摆」。
 *
 * 设计:docs/design/search-index-2026-09.md §6.5 / §7.2
 *
 * **不跨类混排**:各路 score 不是一个量纲(BM25 与静态打分与文件名匹配比不了),
 * 混排出来的次序说不出理由。要混排就得给每路做置信度换算 —— 那是**换 merge 的实现**
 * (接口在这儿),不是在这里加 if。
 */

import type { GroupResult } from '../candidate.js'
import type { CapabilityManifest } from '../capability.js'
import { capabilityOrder } from '../capability.js'

export type Merge = (groups: readonly GroupResult[]) => GroupResult[]

/** 单类档:一路进一路出。 */
export const identityMerge: Merge = groups => [...groups]

/**
 * 全部档:按各 manifest 的 order 升序(命中意图时用 orderWhenIntent)。
 * 今天两种写死的次序就是六个 manifest 各两格数字,可感知行为逐字保留。
 */
export function createGroupMerge(
  manifests: readonly CapabilityManifest[],
  intent: string,
): Merge {
  const rank = new Map<string, number>()
  manifests.forEach((manifest, index) => {
    // 没声明 order 的按注册序垫底,不是随机。
    rank.set(manifest.id, capabilityOrder(manifest, intent) * 1000 + index)
  })
  return groups => [...groups].sort((a, b) =>
    (rank.get(a.capability) ?? Number.MAX_SAFE_INTEGER)
    - (rank.get(b.capability) ?? Number.MAX_SAFE_INTEGER))
}

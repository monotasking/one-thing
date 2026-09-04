/**
 * 会话(标题 / 预览)检索能力。
 *
 * 设计:docs/design/search-index-2026-09.md §4(能力模型)/ §10 S2 行。
 *
 * **id 是 `chats` 不是 `sessions`**:S5 之前 id 就是今天的 `SearchCategory` 取值,
 * 壳与 CLI 都认它;改名是 S5 的事,不是 S2 的。文件名照落位表叫 `sessions.ts`。
 *
 * S2 里它是 `scan` 基座 + 今天那只 `searchChats`(逐字,含「归档跳过」这条已知病 ——
 * 拍点丙要的「搜得到带徽」是 S3 的事)。S3 把它换成 `indexedCapability`。
 */

import type { CapabilityManifest, SearchCapability } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { createOnethingSearchRuntimeAdapters } from '../providers.js'
import { legacyScanCapability } from './legacy.js'

/** 这一类的目标形。壳按 `kind` 从目标渲染注册表取组件(§4.1)。 */
export interface ChatTarget {
  kind: 'chat'
  payload: { sessionId: string }
}

export const chatsSearchManifest: CapabilityManifest = {
  id: 'chats',
  labelKey: 'search.capability.chats',
  icon: 'MessageSquare',
  kind: 'scan',
  // 扫描型这一期不设超时(`0` = core `deriveSignal` 只在 `timeoutMs > 0` 时才装计时器):
  // 旧扫描路一道刹车也没有,钉一个真预算会让慢盘 / 大店从「出结果」变成「没搜成」——
  // S2 的判据是行为零变化,不许多一道刹车。S3 换成索引型之后再钉真预算。
  budget: { default: 6, timeoutMs: 0 },
  order: 1,
  orderWhenIntent: { actions: 3 },
  // scan 型的匹配语义自带模糊,再放宽没有意义(§6.2 末句)。
  relax: false,
}

export function createChatsSearchCapability(
  adapters: OnethingSearchProvidersAdapters,
): SearchCapability {
  const legacy = createOnethingSearchRuntimeAdapters(adapters)
  return legacyScanCapability({
    manifest: chatsSearchManifest,
    run: (query, limit) => legacy.searchChats(query, limit),
    // 空词也答:今天 `all` 档对这一类是无条件调用的(空词 = 最近的几间会话)。
    supports: () => true,
    target: result => ({ kind: 'chat', payload: { sessionId: result.sessionId ?? '' } } satisfies ChatTarget),
  })
}

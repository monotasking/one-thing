/**
 * 消息检索能力。
 *
 * 设计:docs/design/search-index-2026-09.md §10 S2 行 ——「**消息那一路暂仍是旧扫描**」。
 *
 * 所以这一期它是 `scan` 基座 + 今天那只 `searchMessages`(每次 `iterateMessagesRaw`
 * 全库读盘 + 小写 `indexOf`,limit 断在会话循环外层)。病根一个都没治,治它是 S3
 * (账本投影 + FTS5),这一期只把它搬进能力的形。
 */

import type { CapabilityManifest, SearchCapability } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { createOnethingSearchRuntimeAdapters } from '../providers.js'
import { legacyScanCapability } from './legacy.js'

/** 这一类的目标形(§4.1;壳的 `locate-message` 落点吃它)。 */
export interface MessageTarget {
  kind: 'message'
  payload: { sessionId: string; messageId: string }
}

export const messagesSearchManifest: CapabilityManifest = {
  id: 'messages',
  labelKey: 'search.capability.messages',
  icon: 'MessagesSquare',
  kind: 'scan',
  // 扫描型这一期不设超时(`0` = core `deriveSignal` 只在 `timeoutMs > 0` 时才装计时器):
  // 这只 `searchMessages` 是全库扫,真店实测 1.6s,而旧扫描路一道刹车也没有;钉 2000
  // 会让慢盘 / 大店从「出结果」变成「没搜成」—— S2 的判据是行为零变化,不许多一道
  // 刹车。S3 换成索引型(账本投影 + FTS5)之后再钉真预算。
  budget: { default: 5, timeoutMs: 0 },
  order: 5,
  orderWhenIntent: { actions: 6 },
  relax: false,
}

export function createMessagesSearchCapability(
  adapters: OnethingSearchProvidersAdapters,
): SearchCapability {
  const legacy = createOnethingSearchRuntimeAdapters(adapters)
  return legacyScanCapability({
    manifest: messagesSearchManifest,
    run: (query, limit) => legacy.searchMessages(query, limit),
    // 空词旧路答 `[]`,所以答不答都一样;恒真是为了让 `all` 档的分组里有这一格
    // (壳能看见「消息:0 条」而不是「消息这一类不见了」)。
    supports: () => true,
    target: result => ({
      kind: 'message',
      payload: { sessionId: result.sessionId ?? '', messageId: result.messageId ?? '' },
    } satisfies MessageTarget),
  })
}

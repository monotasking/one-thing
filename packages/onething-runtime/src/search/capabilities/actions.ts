/**
 * 命令(action)检索能力 —— 静态型。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 第三行 / §6.1(意图)/ §7.1(预算)。
 *
 * 这一份能力身上挂着**两条法的落点**,S2 的反证也都指着它:
 *
 *  - **意图前缀不再写在 core 里**:今天 `isOnethingCommandSearchQuery(query)` 那句
 *    `startsWith('/') || startsWith('>')` 在 `search-runtime.ts` 里,是 core 侧的
 *    能力字面量。搬成 `intentPrefixes: ['/', '>']` 之后,`parse` 遍历注册表判意图,
 *    **意图名 = 能力 id**(§4.4 表 / §6.1),所以下面两处按意图分档的键是 `actions`。
 *    (S0 那张临时清单里写的是 `command`,那时还没有「意图名 = 能力 id」这条实现;
 *    S2 按 core 的实现纠正,见交卷报告「与设计的出入」。)
 *  - **预算不再是常量表**:今天 `all` 档那句 `isOnethingCommandSearchQuery(query) ? 8 : 4`
 *    变成 `budget.whenIntent`,`budgetPolicy` 只是读表(§7.1)。**反证**:把
 *    `whenIntent` 换回常量 → 「command 意图 actions 8 条」用例红。
 */

import type { CapabilityManifest, SearchCapability } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { createOnethingSearchRuntimeAdapters } from '../providers.js'
import { legacyStaticCapability } from './legacy.js'

/** 这一类的目标形。 */
export interface ActionTarget {
  kind: 'action'
  payload: { actionId: string }
}

export const actionsSearchManifest: CapabilityManifest = {
  id: 'actions',
  labelKey: 'search.capability.actions',
  icon: 'Zap',
  kind: 'static',
  intentPrefixes: ['/', '>'],
  budget: { default: 4, timeoutMs: 2000, whenIntent: { actions: 8 } },
  order: 6,
  orderWhenIntent: { actions: 1 },
  relax: false,
}

export function createActionsSearchCapability(
  adapters: OnethingSearchProvidersAdapters,
): SearchCapability {
  const legacy = createOnethingSearchRuntimeAdapters(adapters)
  return legacyStaticCapability({
    manifest: actionsSearchManifest,
    run: (query, limit) => legacy.searchActions(query, limit),
    supports: () => true,
    target: result => ({ kind: 'action', payload: { actionId: result.actionId ?? '' } } satisfies ActionTarget),
  })
}

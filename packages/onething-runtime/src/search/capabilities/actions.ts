/**
 * 命令(action)检索能力 —— 静态型。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 第三行 / §6.1(意图)/ §7.1(预算)。
 *
 * S5(2026-09-05)把匹配器从 `providers.ts` 那个大文件搬进来:**一类 = 一个文件**,
 * 这张 `ACTIONS` 表与那只 `searchActions` 从来只有这一个读者。
 *
 * 这一份能力身上挂着**两条法的落点**:
 *
 *  - **意图前缀不再写在 core 里**:旧路那句 `startsWith('/') || startsWith('>')`
 *    是 core 侧的能力字面量。搬成 `intentPrefixes: ['/', '>']` 之后,`parse` 遍历
 *    注册表判意图,**意图名 = 能力 id**(§4.4 表 / §6.1),所以下面两处按意图分档
 *    的键是 `actions`。
 *  - **预算不再是常量表**:旧路 `all` 档那句「命令样查询给 8 条、否则 4 条」变成
 *    `budget.whenIntent`,`budgetPolicy` 只是读表(§7.1)。**反证**:把
 *    `whenIntent` 换回常量 → 「command 意图 actions 8 条」用例红。
 */

import type { CapabilityManifest, SearchCapability } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { staticBackedCapability, type SearchServiceResult } from './scan-adapter.js'
import { matchRangesOf, normalizeSearchQuery, scoreText } from './text-match.js'

/** 这一类的目标形。 */
export interface ActionTarget {
  kind: 'action'
  payload: { actionId: string }
}

export interface ActionDefinition {
  id: string
  name: string
  keywords?: string[]
  shortcut?: string
}

/** 宿主自带的那几条命令。加一条 = 这张表加一行,别处一个字不动。 */
const ACTIONS: ActionDefinition[] = [
  { id: 'new-chat', name: 'New Chat', keywords: ['chat', 'conversation', 'create'], shortcut: '⌘N' },
  { id: 'open-settings', name: 'Open Settings', keywords: ['preferences', 'config'], shortcut: '⌘,' },
  { id: 'toggle-sidebar', name: 'Toggle Sidebar', keywords: ['panel', 'nav'], shortcut: '⌘B' },
  { id: 'toggle-inspector', name: 'Toggle Inspector', keywords: ['details', 'debug', 'steps'] },
  { id: 'close-chat', name: 'Close Chat', keywords: ['delete', 'remove'] },
  { id: 'focus-input', name: 'Focus Input', keywords: ['composer', 'prompt', 'message'] },
]

/** 关键词的分打 0.75 折 —— 名字命中比关键词命中值钱。 */
export function searchActions(query: string, limit: number): SearchServiceResult[] {
  const q = normalizeSearchQuery(query)
  return ACTIONS
    .map(a => ({
      action: a,
      score: Math.max(scoreText(a.name, q), ...(a.keywords || []).map(k => scoreText(k, q) * 0.75)),
    }))
    .filter(item => !q || item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ action }) => ({
      id: `action:${action.id}`,
      type: 'action' as const,
      title: action.name,
      subtitle: action.keywords?.slice(0, 3).join(' · '),
      actionId: action.id,
      shortcut: action.shortcut,
      matchRanges: matchRangesOf(action.name, q),
    }))
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
  // 这一类不吃取材面(命令表是常量),但六件能力的构造签名保持一致 —— 注册那一行
  // 才不用为某一类破例。
  void adapters
  return staticBackedCapability({
    manifest: actionsSearchManifest,
    run: (query, limit) => searchActions(query, limit),
    supports: () => true,
    target: result => ({ kind: 'action', payload: { actionId: result.actionId ?? '' } } satisfies ActionTarget),
  })
}

/**
 * 提示词检索能力 —— 静态型。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 第三行 / §10 S2 行。
 *
 * 旧路两处调用都传 `includeCreateAction = true`(单类档与 `all` 档同款),所以这里
 * 不给这一格留参数:它不是一个选项,是这一类结果自己的一条(「新建提示词」快捷项)。
 */

import type { CapabilityManifest, SearchCapability } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { createOnethingSearchRuntimeAdapters } from '../providers.js'
import { legacyStaticCapability } from './legacy.js'

/** 这一类的目标形:点开就是一条 actionId(插入 / 新建都在它里面)。 */
export interface PromptTarget {
  kind: 'prompt'
  payload: { actionId: string }
}

export const promptsSearchManifest: CapabilityManifest = {
  id: 'prompts',
  labelKey: 'search.capability.prompts',
  icon: 'Pencil',
  kind: 'static',
  budget: { default: 6, timeoutMs: 2000 },
  order: 2,
  orderWhenIntent: { actions: 2 },
  relax: false,
}

export function createPromptsSearchCapability(
  adapters: OnethingSearchProvidersAdapters,
): SearchCapability {
  const legacy = createOnethingSearchRuntimeAdapters(adapters)
  return legacyStaticCapability({
    manifest: promptsSearchManifest,
    run: (query, limit) => legacy.searchPrompts(query, limit, true),
    supports: () => true,
    target: result => ({ kind: 'prompt', payload: { actionId: result.actionId ?? '' } } satisfies PromptTarget),
  })
}

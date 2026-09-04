/**
 * 提示词检索能力 —— 静态型。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 第三行。
 *
 * S5(2026-09-05)把匹配器从 `providers.ts` 搬进来:**一类 = 一个文件**。
 *
 * 「新建提示词」那条快捷项不是一个选项,是**这一类结果自己的一条** —— 旧路两处
 * 调用都传 `includeCreateAction = true`,所以搬过来之后那一格参数直接不要了。
 * 它的位置由 `slice(0, limit - 1)` 之后**是不是空**决定,那也正是基座必须在
 * 拿到 `page.limit` 之后才现造的理由(`scan-adapter.ts` 文件头)。
 */

import type { CapabilityManifest, SearchCapability } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { staticBackedCapability, type SearchServiceResult } from './scan-adapter.js'
import { matchRangesOf, normalizeSearchQuery, scoreText } from './text-match.js'

/** 这一类的目标形:点开就是一条 actionId(插入 / 新建都在它里面)。 */
export interface PromptTarget {
  kind: 'prompt'
  payload: { actionId: string }
}

/** 「Create prompt "..."」里那个引号中间的字。 */
function createPromptTitleFromQuery(query: string): string {
  const q = query.trim()
    .replace(/^>/, '')
    .replace(/^\//, '')
    .trim()
    .replace(/^create\s+prompt\s*/i, '')
    .replace(/^new\s+prompt\s*/i, '')
    .trim()
  return q || 'Untitled Prompt'
}

export function searchPrompts(
  query: string,
  limit: number,
  adapters: OnethingSearchProvidersAdapters,
): SearchServiceResult[] {
  const q = normalizeSearchQuery(query)
  const prompts = adapters.listPrompts()
  const matched: SearchServiceResult[] = prompts
    .map(prompt => {
      const searchable = [
        prompt.title,
        prompt.description,
        prompt.body,
        ...(prompt.tags || []),
      ]
      return {
        prompt,
        score: Math.max(
          scoreText(prompt.title, q),
          scoreText(prompt.description, q) * 0.8,
          scoreText((prompt.tags || []).join(' '), q) * 0.7,
          scoreText(prompt.body, q) * 0.45,
        ),
        searchable: searchable.join(' '),
      }
    })
    .filter(item => !q || item.score > 0 || item.searchable.toLowerCase().includes(q))
    .sort((a, b) => (b.score - a.score) || (b.prompt.updatedAt - a.prompt.updatedAt))
    // 「新建」那一条要占一格,所以先给它留出来。
    .slice(0, Math.max(0, limit - 1))
    .map(({ prompt }) => ({
      id: `prompt:${prompt.id}`,
      type: 'prompt' as const,
      title: prompt.title,
      subtitle: prompt.description || prompt.body.slice(0, 90),
      detail: (prompt.tags || []).join(' · ') || 'Prompt',
      actionId: `insert-prompt:${prompt.id}`,
      timestamp: prompt.updatedAt,
      matchRanges: matchRangesOf(prompt.title, q),
    }))

  const wantsCreate = q && (
    matched.length === 0 ||
    q.startsWith('create prompt') ||
    q.startsWith('new prompt')
  )
  if (wantsCreate) {
    const title = createPromptTitleFromQuery(query)
    matched.unshift({
      id: `prompt-create:${encodeURIComponent(title)}`,
      type: 'prompt',
      title: `Create prompt "${title}"`,
      subtitle: 'Save a reusable prompt snippet',
      detail: 'Prompt',
      actionId: `create-prompt:${encodeURIComponent(title)}`,
      timestamp: Date.now(),
      matchRanges: matchRangesOf(title, q),
    })
  }

  return matched.slice(0, limit)
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
  return staticBackedCapability({
    manifest: promptsSearchManifest,
    run: (query, limit) => searchPrompts(query, limit, adapters),
    supports: () => true,
    target: result => ({ kind: 'prompt', payload: { actionId: result.actionId ?? '' } } satisfies PromptTarget),
  })
}

/**
 * 提示词检索能力 —— 静态型。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 第三行。
 *
 * S5(2026-09-05)把匹配器从 `providers.ts` 搬进来:**一类 = 一个文件**。
 *
 * ## 「新建提示词」不再冒充一条结果(检索面终稿 §0 ③,2026-09-06)
 *
 * 从前它是 `matched.unshift(...)` 进去的一行:占配额(所以匹配器要
 * `slice(0, limit - 1)` 给它留位置)、计进 `total`、被壳当成一条命中画在列表里、
 * 停在它上面还会去请求一次预览。用户 09-05 的原话是「Create prompt "jira" 冒充结果」。
 *
 * 现在它是**页级动作**(`SearchPage.actions`):不在 `items` 里、不计任何数、
 * 句子由壳按 `labelKey + params` 查字典拼(R12 —— 后端不写「Create prompt "…"」
 * 这种成品英文句)。匹配器那两处 `limit` 的特殊算术因此一起消失。
 */

import type {
  ActionDescriptor,
  Candidate,
  CapabilityManifest,
  SearchCapability,
  SearchQuery,
} from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { staticBackedCapability, type SearchServiceResult } from './scan-adapter.js'
import { matchRangesOf, normalizeSearchQuery, scoreText } from './text-match.js'

/**
 * 这一类的目标形:点开要做什么。
 *
 * `promptId` 是 S4 留下的那条死路(落差 #54):壳拿到一条提示词命中,除了一个
 * `insert-prompt:<id>` 的**字符串**之外什么都没有,想读正文就得自己去 `actionId`
 * 里剖 id —— 那是让壳去解析后端的 id 编码。这一格把它明说出来。
 */
export interface PromptTarget {
  kind: 'prompt'
  payload: { actionId: string; promptId: string }
}

/** 这一类自报的动作 id(壳按 `kind` 画,按 `id` 回调 `search.invoke`)。 */
export const CREATE_PROMPT_ACTION = 'create-prompt'

/** 「新建提示词 “…”」里那个引号中间的字。**只是料,不是句子**(R12)。 */
export function createPromptTitleFromQuery(query: string): string {
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

  return matched.slice(0, Math.max(0, limit))
}

/**
 * 「新建一条叫 … 的提示词」这个动作,什么时候提议。
 *
 * 判据与从前那条 `wantsCreate` **逐字相同**(一条都没搜到,或者用户就是在说
 * 「create prompt / new prompt」),搬的只是它的落点:从 `items` 搬到 `actions`。
 */
export function createPromptAction(
  query: SearchQuery,
  items: readonly SearchServiceResult[],
): ActionDescriptor[] | undefined {
  const q = normalizeSearchQuery(query.raw)
  const wants = q.length > 0
    && (items.length === 0 || q.startsWith('create prompt') || q.startsWith('new prompt'))
  if (!wants) return undefined
  const title = createPromptTitleFromQuery(query.raw)
  return [{
    id: `${CREATE_PROMPT_ACTION}:${encodeURIComponent(title)}`,
    kind: 'create',
    capability: promptsSearchManifest.id,
    // 句子在壳里:`search.action.createPrompt` = 「新建提示词 “{title}”」/
    // 「Create prompt “{title}”」。后端只交那个 title。
    labelKey: 'search.action.createPrompt',
    params: { title },
    payload: { title },
  }]
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

/** `prompt:<id>` / `insert-prompt:<id>` 里那个 id。剖 id 这件事只在这一个地方做。 */
function promptIdOf(result: SearchServiceResult): string {
  const fromId = result.id.startsWith('prompt:') ? result.id.slice('prompt:'.length) : ''
  if (fromId.length > 0) return fromId
  const actionId = result.actionId ?? ''
  return actionId.startsWith('insert-prompt:') ? actionId.slice('insert-prompt:'.length) : ''
}

export function createPromptsSearchCapability(
  adapters: OnethingSearchProvidersAdapters,
): SearchCapability {
  const capability = staticBackedCapability({
    manifest: promptsSearchManifest,
    run: (query, limit) => searchPrompts(query, limit, adapters),
    supports: () => true,
    target: result => ({
      kind: 'prompt',
      payload: { actionId: result.actionId ?? '', promptId: promptIdOf(result) },
    } satisfies PromptTarget),
    actions: createPromptAction,
  })

  /**
   * 「新建提示词」按下去那一下(§8 `invoke`)。
   *
   * **取材面没有这一格就结构化拒绝**,不悄悄假装成功:桌面装配把
   * `promptStore.create` 接进来,server 那一侧按 owner 接自己那份;单测的假件
   * 什么都不接,于是它如实说「这台宿主建不了提示词」。
   */
  const invoke = async (actionId: string, candidates: Candidate[]): Promise<void> => {
    void candidates
    if (!actionId.startsWith(`${CREATE_PROMPT_ACTION}:`)) {
      throw new Error(`no such action: ${actionId}`)
    }
    const create = adapters.createPrompt
    if (create === undefined) throw new Error('this host cannot create prompts')
    const title = decodeURIComponent(actionId.slice(`${CREATE_PROMPT_ACTION}:`.length))
    await create({ title })
  }

  return { ...capability, invoke }
}

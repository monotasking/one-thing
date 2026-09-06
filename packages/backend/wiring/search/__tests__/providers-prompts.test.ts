/**
 * 提示词那一类,穿过**装配层的取材面**打真的提示词仓。
 *
 * S5(2026-09-05)之前它问的是 `wiring/search/providers` 的 `executeSearch`(旧扫描
 * 路的门面);旧路退役之后同一件事的入口是「这一类的能力 + 装配层的取材面」——
 * 断言一字未改,因为匹配器本来就是同一份代码(S5 只是把它从 `providers.ts` 搬进
 * `capabilities/prompts.ts`)。
 *
 * 这一条留在**装配层**而不是产品层,是因为它要证的正是装配那一半:
 * `createAppSearchProvidersAdapters().listPrompts` 真的接到了 `prompts/store-bound`
 * 那个仓上。产品层那一半(匹配与排序)有它自己的用例。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSearchContext } from '@onething/runtime/search'
import {
  createPromptsSearchCapability,
  searchResultOf,
} from '@onething/runtime/search/capabilities'
import type { SearchQuery } from '@onething/core/search'
import { createPrompt, listPrompts, setPromptsPathForTests } from '@onething/runtime/prompts/store-bound'
import { createAppSearchProvidersAdapters } from '../adapters.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'search-prompts-'))
  setPromptsPathForTests(path.join(tmpDir, 'prompts.json'))
})

afterEach(async () => {
  setPromptsPathForTests(null)
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function promptsCapability() {
  return createPromptsSearchCapability(createAppSearchProvidersAdapters())
}

async function promptsPage(raw: string, limit: number) {
  const query: SearchQuery = {
    raw,
    ast: { type: 'and', children: [] },
    intent: 'content',
    filters: {},
    capability: 'prompts',
  }
  return await promptsCapability().search(query, { limit }, createSearchContext())
}

async function searchPrompts(raw: string, limit: number) {
  return (await promptsPage(raw, limit)).items.map(searchResultOf)
}

describe('Search Everywhere prompt provider', () => {
  it('returns matching prompts with insert actions ordered by match strength', async () => {
    const weak = createPrompt({ title: 'Code Notes', body: 'deploy checklist' })
    const strong = createPrompt({ title: 'Deploy Helper', body: 'release steps' })

    const results = await searchPrompts('deploy', 10)

    expect(results[0]).toMatchObject({
      id: `prompt:${strong.id}`,
      type: 'prompt',
      title: 'Deploy Helper',
      actionId: `insert-prompt:${strong.id}`,
    })
    expect(results.some(result => result.actionId === `insert-prompt:${weak.id}`)).toBe(true)
  })

  /*
   * 检索面终稿 §0 ③ 起,「新建提示词」是**页级动作**,不是结果行:它不占配额、
   * 不计 `total`、不进 `results`,句子也不再由后端拼(R12 —— `Create prompt "…"`
   * 这种成品英文句从此由壳按 `labelKey + params` 查字典)。断言跟着落点改,
   * 判据(什么时候提议新建 / 引号里那个 title 怎么取)一字未动。
   */
  it('offers a create action when no prompt matches —— 在 actions 上,不在 results 里', async () => {
    createPrompt({ title: 'Existing', body: 'Something else' })

    const page = await promptsPage('new reusable thing', 10)

    expect(page.items).toEqual([])
    expect(page.actions).toHaveLength(1)
    expect(page.actions?.[0]).toMatchObject({
      kind: 'create',
      capability: 'prompts',
      labelKey: 'search.action.createPrompt',
      params: { title: 'new reusable thing' },
      id: 'create-prompt:new%20reusable%20thing',
    })
  })

  it('preserves casing when creating from a create prompt query', async () => {
    const page = await promptsPage('Create Prompt Refactor Plan', 10)

    expect(page.actions?.[0]).toMatchObject({
      params: { title: 'Refactor Plan' },
      id: 'create-prompt:Refactor%20Plan',
    })
  })

  it('那条动作按下去真的建出一条提示词(`invoke` → 装配层接的提示词仓)', async () => {
    const page = await promptsPage('Brand New Thing', 10)
    const action = page.actions?.[0]
    expect(action).toBeDefined()

    const capability = promptsCapability()
    await capability.invoke?.(action!.id, [], createSearchContext())

    expect(listPrompts().map(prompt => prompt.title)).toContain('Brand New Thing')

    // 不认识的动作 id 结构化拒绝,不悄悄成功。
    await expect(capability.invoke?.('nope', [], createSearchContext())).rejects.toThrow()
  })

  it('结果行的 target 带 promptId —— 壳不必再去 actionId 里剖 id(落差 #54)', async () => {
    const made = createPrompt({ title: 'Deploy Helper', body: 'release steps' })
    const page = await promptsPage('deploy', 10)
    expect(page.items[0]?.target).toEqual({
      kind: 'prompt',
      payload: { actionId: `insert-prompt:${made.id}`, promptId: made.id },
    })
  })
})

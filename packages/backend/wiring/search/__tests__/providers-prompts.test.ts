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
import { createPrompt, setPromptsPathForTests } from '@onething/runtime/prompts/store-bound'
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

async function searchPrompts(raw: string, limit: number) {
  const capability = createPromptsSearchCapability(createAppSearchProvidersAdapters())
  const query: SearchQuery = {
    raw,
    ast: { type: 'and', children: [] },
    intent: 'content',
    filters: {},
    capability: 'prompts',
  }
  const page = await capability.search(query, { limit }, createSearchContext())
  return page.items.map(searchResultOf)
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

  it('offers a create shortcut when no prompt matches', async () => {
    createPrompt({ title: 'Existing', body: 'Something else' })

    const results = await searchPrompts('new reusable thing', 10)

    expect(results[0]).toMatchObject({
      type: 'prompt',
      title: 'Create prompt "new reusable thing"',
      actionId: 'create-prompt:new%20reusable%20thing',
    })
  })

  it('preserves casing when creating from a create prompt query', async () => {
    const results = await searchPrompts('Create Prompt Refactor Plan', 10)

    expect(results[0]).toMatchObject({
      title: 'Create prompt "Refactor Plan"',
      actionId: 'create-prompt:Refactor%20Plan',
    })
  })
})

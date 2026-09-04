/**
 * `SearchService`(检索重建 S2,`docs/design/search-index-2026-09.md` §7 / §10 / §11)。
 *
 * 这份文件钉的是「骨架不认识任何一类」的那几条,以及 §11 S2 的两条反证:
 *  - 从注册表摘掉一个能力 → `capabilities()` 少一项、`all` 档少一组、那一类的 parity 红;
 *  - `budgetPolicy` 改回常量 → 「command 意图 actions 8 条」用例红。
 */
import { describe, expect, it } from 'vitest'
import type { IndexedDoc } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { OnethingSearchService, createOnethingSearchService } from '../service.js'
import { actionsSearchManifest, createBuiltinSearchCapabilities } from '../capabilities/index.js'
import { fakeIndexFace } from './fake-index.js'

const ACTION_COUNT = 6

/**
 * S3b:chats / messages / daily 三路改问索引,所以这份文件也得给一份索引替身。
 * 它按能力 id 把手上的文档原样交回去 —— 这里证的是**门面**(分组 / 次序 / 配额 /
 * 注册表),不是命中语义。
 */
function makeDocs(): IndexedDoc[] {
  return [{
    docId: 1,
    capability: 'chats',
    key: 's1',
    time: 200,
    facets: { sessionId: 's1', spaceId: '', archived: false, time: 200 },
    fields: { title: 'Alpha notes' },
  }]
}

function makeService(adapters = makeAdapters()) {
  return createOnethingSearchService(adapters, { index: fakeIndexFace(makeDocs()) })
}

function makeAdapters(): OnethingSearchProvidersAdapters {
  return {
    getSessionsList: () => [
      { id: 's1', name: 'Alpha notes', previewText: 'about alpha', updatedAt: 200 },
    ],
    iterateSessionMessages: () => [
      { id: 'm1', role: 'user', content: 'the alpha thing', timestamp: 10 },
    ],
    getSession: () => undefined,
    getCurrentSessionId: () => undefined,
    getSettings: () => ({ general: { dailyNotes: { enabled: false } } }),
    getVariablesStore: () => ({
      getUserNoteDir: () => undefined,
      getWorkNoteDir: () => undefined,
    }),
    listFiles: () => ({ async *[Symbol.asyncIterator]() {} }),
    listPrompts: () => [
      { id: 'p1', title: 'Alpha prompt', description: 'about alpha', body: 'body', updatedAt: 5 },
    ],
  }
}

describe('SearchService(S2 门面)', () => {
  it('capabilities():注册序 = 缺省展示序,六类都在', () => {
    const service = makeService()
    expect(service.capabilities().map(manifest => manifest.id))
      .toEqual(['chats', 'prompts', 'daily', 'files', 'messages', 'actions'])
  })

  it('全部档:分组按 order,results 就是各组按那个次序拼起来的', async () => {
    const service = makeService()
    const response = await service.query({ query: 'alpha', category: 'all' })

    const groups = response.groups ?? []
    // 缺省次序(旧路 `[...chats, ...prompts, ...daily, ...files, ...messages, ...actions]`)。
    expect(groups.map(group => group.capability))
      .toEqual(['chats', 'prompts', 'daily', 'files', 'messages', 'actions'])
    expect(response.results).toEqual(groups.flatMap(group => group.results))
    // 每组带自己的 label(壳的 tab 从这里来),不是 core 里的一张表。
    expect(groups[0]?.label).toBe('search.capability.chats')
  })

  it('命令意图重排:`/` 一打,actions 跳到第一组 —— 判据在 manifest 的 orderWhenIntent', async () => {
    const service = makeService()
    const response = await service.query({ query: '/chat', category: 'all' })
    expect((response.groups ?? []).map(group => group.capability))
      .toEqual(['actions', 'prompts', 'chats', 'daily', 'files', 'messages'])
  })

  it('命令意图 actions 8 条 —— 预算读的是 manifest.budget.whenIntent(§7.1 反证点)', async () => {
    const service = makeService()
    // 空词的 actions 全表都命中,所以这一格量到的就是配额本身。
    const command = await service.query({ query: '>', category: 'all' })
    const plain = await service.query({ query: '', category: 'all' })

    const actionsOf = (groups: typeof command.groups) =>
      (groups ?? []).find(group => group.capability === 'actions')?.results.length ?? 0

    // 先钉**行为**(摘掉 whenIntent 这两行就红),再钉自述那一格。
    // 表里一共 6 条:命令意图给 8(要不满就是全给),平时给 4。
    expect(actionsOf(command.groups)).toBe(ACTION_COUNT)
    expect(actionsOf(plain.groups)).toBe(4)
    expect(actionsSearchManifest.budget.whenIntent?.actions).toBe(8)
  })

  it('单类档:results 是本页,不带分组总览', async () => {
    const service = makeService()
    const response = await service.query({ query: 'alpha', category: 'chats', limit: 5 })
    expect(response.groups).toBeUndefined()
    expect(response.results.map(result => result.id)).toEqual(['chat:s1'])
  })

  it('不认识的档归到「全部」—— 判据是注册表,不是一张字面量清单(§8)', async () => {
    const service = makeService()
    const response = await service.query({ query: 'alpha', category: 'nope' })
    expect(response.groups).toBeDefined()
  })

  it('§11 反证:注销一个能力 → capabilities 少一项、all 档少一组', async () => {
    const adapters = makeAdapters()
    const service = new OnethingSearchService()
    const disposers = new Map<string, () => void>()
    for (const capability of createBuiltinSearchCapabilities(adapters, fakeIndexFace(makeDocs()))) {
      disposers.set(capability.manifest.id, service.register(capability))
    }

    const before = await service.query({ query: 'alpha', category: 'chats' })
    expect(before.results.map(result => result.id)).toEqual(['chat:s1'])

    // 注销 = `register` 交回来的那把钥匙(§4.3);装配层握的就是它。
    disposers.get('chats')!()

    expect(service.capabilities().map(manifest => manifest.id)).not.toContain('chats')
    const all = await service.query({ query: 'alpha', category: 'all' })
    expect((all.groups ?? []).map(group => group.capability)).not.toContain('chats')
    // 单类档点名一个不在册的能力 → 归到「全部」(注册表说了不认识)。
    expect((await service.query({ query: 'alpha', category: 'chats' })).groups).toBeDefined()
  })
})

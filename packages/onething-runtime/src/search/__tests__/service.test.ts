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
import { FolderVault } from '../../notes/folder/vault.js'
import { OnethingSearchService, createOnethingSearchService } from '../service.js'
import { actionsSearchManifest, createBuiltinSearchCapabilities } from '../capabilities/index.js'
import { fakeIndexFace } from './fake-index.js'

const ACTION_COUNT = 6

/**
 * S3b:chats / messages / notes 三路改问索引,所以这份文件也得给一份索引替身。
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
    getVariablesStore: () => ({
      getUserNoteDir: () => undefined,
      getWorkNoteDir: () => undefined,
    }),
    listFiles: () => ({ async *[Symbol.asyncIterator]() {} }),
    listPrompts: () => [
      { id: 'p1', title: 'Alpha prompt', description: 'about alpha', body: 'body', updatedAt: 5 },
    ],
    // 一个库在册 —— `notes` 的 `supports` 问的就是它(一个库都没有 = 整组不出现)。
    // 没有主库,所以「今天那一条」与「新建笔记」都不掺进这份分组用例里。
    getNoteVaults: () => [new FolderVault({ root: '/notes', id: 'v1' })],
    getPrimaryNoteVault: () => null,
  }
}

describe('SearchService(S2 门面)', () => {
  it('capabilities():注册序 = 缺省展示序,六类都在', () => {
    const service = makeService()
    expect(service.capabilities().map(manifest => manifest.id))
      .toEqual(['chats', 'prompts', 'notes', 'files', 'messages', 'actions'])
  })

  it('全部档:分组按 order,results 就是各组按那个次序拼起来的', async () => {
    const service = makeService()
    const response = await service.query({ query: 'alpha', category: 'all' })

    const groups = response.groups ?? []
    // 缺省次序(旧路 `[...chats, ...prompts, ...notes, ...files, ...messages, ...actions]`)。
    expect(groups.map(group => group.capability))
      .toEqual(['chats', 'prompts', 'notes', 'files', 'messages', 'actions'])
    expect(response.results).toEqual(groups.flatMap(group => group.results))
    // 每组带自己的 label(壳的 tab 从这里来),不是 core 里的一张表。
    expect(groups[0]?.label).toBe('search.capability.chats')
  })

  it('命令意图重排:`/` 一打,actions 跳到第一组 —— 判据在 manifest 的 orderWhenIntent', async () => {
    const service = makeService()
    const response = await service.query({ query: '/chat', category: 'all' })
    expect((response.groups ?? []).map(group => group.capability))
      .toEqual(['actions', 'prompts', 'chats', 'notes', 'files', 'messages'])
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

  /*
   * ── 全部档的每一块自己续页(检索面终稿 §0 ②)────────────────────────────
   *
   * 这三条钉的是 §4「后端」那一段的全部要害:组的 `cursor` 投影出来了没有、那个
   * 游标**回传到单类档**是不是真的接得上(两条路的配额与放宽档不同,这正是风险 #4),
   * 以及动作到底有没有从结果里拿出去。
   */
  describe('全部档:每块带自己的游标(§0 ②)', () => {
    /** 一类多灌几份文档,好让配额(chats 6 / messages 5)真的不够用。 */
    function manyDocs(): IndexedDoc[] {
      const docs: IndexedDoc[] = []
      for (let i = 1; i <= 9; i += 1) {
        docs.push({
          docId: i,
          capability: 'chats',
          key: `s${i}`,
          time: 1000 - i,
          facets: { sessionId: `s${i}`, spaceId: '', archived: false, time: 1000 - i },
          fields: { title: `alpha ${i}` },
        })
      }
      for (let i = 1; i <= 9; i += 1) {
        docs.push({
          docId: 100 + i,
          capability: 'messages',
          key: `s1:m${i}`,
          time: 2000 - i,
          facets: { sessionId: 's1', spaceId: '', role: 'user', archived: false, time: 2000 - i },
          fields: { content: `alpha message ${i}` },
        })
      }
      return docs
    }

    const serviceWithMany = () =>
      createOnethingSearchService(makeAdapters(), { index: fakeIndexFace(manyDocs(), { matched: ['alpha'] }) })

    it('每组带 cursor / relaxed —— 从前这两格在 allResponse 里被整个丢掉', async () => {
      const response = await serviceWithMany().query({ query: 'alpha', category: 'all' })
      const chats = (response.groups ?? []).find(group => group.capability === 'chats')
      const messages = (response.groups ?? []).find(group => group.capability === 'messages')

      // 配额没吃完全集 → 还有下一页 → 必须有游标(契约:缺席 = 取尽)。
      expect(chats?.results).toHaveLength(6)
      expect(chats?.total).toBe(9)
      expect(chats?.cursor).toBeTypeOf('string')
      expect(chats?.relaxed).toBe(0)
      expect(messages?.results).toHaveLength(5)
      expect(messages?.cursor).toBeTypeOf('string')
      // 两块的游标各是各的 —— 它们编着各自的能力 id。
      expect(chats?.cursor).not.toBe(messages?.cursor)
    })

    it('组游标回传给同词同片的单类档:第二页不重不漏(gate 第九步的单测半边)', async () => {
      const service = serviceWithMany()
      const all = await service.query({ query: 'alpha', category: 'all' })
      const group = (all.groups ?? []).find(entry => entry.capability === 'messages')
      const firstIds = (group?.results ?? []).map(result => result.id)

      const next = await service.query({
        query: 'alpha',
        category: 'messages',
        limit: 5,
        cursor: group?.cursor,
      })
      const nextIds = next.results.map(result => result.id)

      // 不重:两页 id 不相交。
      expect(nextIds.some(id => firstIds.includes(id))).toBe(false)
      // 不漏:接着第 6 条开始,两页合起来正好是前 9 条里的 9 条。
      expect(nextIds).toHaveLength(4)
      expect(new Set([...firstIds, ...nextIds]).size).toBe(9)
      // 取尽 = 没有游标。
      expect(next.cursor).toBeUndefined()
    })

    it('过期 / 换词的游标当「从头来」,不抛也不空页', async () => {
      const service = serviceWithMany()
      const all = await service.query({ query: 'alpha', category: 'all' })
      const group = (all.groups ?? []).find(entry => entry.capability === 'messages')
      // 同一个游标换一个词 —— 指纹对不上。
      const other = await service.query({ query: 'message', category: 'messages', limit: 5, cursor: group?.cursor })
      expect(other.success).toBe(true)
      expect(other.results.length).toBeGreaterThan(0)
    })
  })

  describe('动作不是结果(§0 ③)', () => {
    it('「新建提示词」在 actions 上,不进 results、不计 total', async () => {
      const service = makeService()
      // 一条提示词都搜不到的词 —— 旧路这时会 unshift 一行「Create prompt "zzz"」。
      const response = await service.query({ query: 'zzz', category: 'prompts', limit: 5 })

      expect(response.results).toEqual([])
      expect(response.total).toBe(0)
      const action = response.actions?.[0]
      expect(response.actions).toHaveLength(1)
      expect(action?.kind).toBe('create')
      expect(action?.capability).toBe('prompts')
      // 句子归壳:只有键与料,没有「Create prompt "zzz"」这种成品句(R12)。
      expect(action?.labelKey).toBe('search.action.createPrompt')
      expect(action?.params).toEqual({ title: 'zzz' })
      expect(JSON.stringify(action)).not.toContain('Create prompt')
    })

    it('全部档:动作挂在组上也挂在页上,两处都不进 results', async () => {
      const service = makeService()
      const response = await service.query({ query: 'zzz', category: 'all' })
      const prompts = (response.groups ?? []).find(group => group.capability === 'prompts')

      expect(prompts?.actions).toHaveLength(1)
      expect(response.actions).toHaveLength(1)
      expect(response.results.some(result => result.id.startsWith('create-prompt'))).toBe(false)
      expect(prompts?.results).toEqual([])
    })

    it('搜得到提示词时不提议新建(判据与旧路那句 wantsCreate 逐字同)', async () => {
      const service = makeService()
      const response = await service.query({ query: 'alpha', category: 'prompts', limit: 5 })
      expect(response.results.map(result => result.id)).toEqual(['prompt:p1'])
      expect(response.actions).toBeUndefined()
    })
  })

  it('单类档某一路塌了 = 整发失败,不是「没有匹配的结果」(§4)', async () => {
    const service = new OnethingSearchService()
    service.register({
      manifest: {
        id: 'boom',
        labelKey: 'search.capability.boom',
        icon: 'X',
        kind: 'static',
        budget: { default: 5, timeoutMs: 100 },
        order: 1,
        relax: false,
      },
      supports: () => true,
      search: () => Promise.reject(new Error('索引开不了库')),
    })
    const response = await service.query({ query: 'alpha', category: 'boom' })
    expect(response.success).toBe(false)
    expect(response.error).toBe('索引开不了库')
    expect(response.results).toEqual([])
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

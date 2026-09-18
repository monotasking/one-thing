/**
 * 「最近几间会话」那一页,对着**录下来的旧输出**逐条比(检索重建 S5,
 * `docs/design/search-index-2026-09.md` §10 S5 行)。
 *
 * ## 快照的来历
 *
 * `__fixtures__/chats-browse.json` 是 S5 **删掉旧扫描器之前**跑出来的:拿下面
 * 这张 `sessions` 夹具喂 `createOnethingSearchRuntimeAdapters(adapters).searchChats`,
 * 把 `('' | '   ' | '/' | '>') × (2 | 20)` 八种入参的返回值原样 `JSON.stringify`
 * 进文件。旧函数今天已经不存在,所以参照物只能是这份录音 —— 这正是「删路不删行为」
 * 那句话在单测尺度上唯一还成立的证法。
 *
 * **要改这份夹具,先在报告里说清楚为什么**:它变了就是「最近几间会话」这件事的
 * 行为变了,而那是一次用户可感知的改动。
 *
 * **步⑧接上了线**:占位名归空(检索面终稿 §6「无标题会话」)—— 判据函数
 * `sessionTitleOf` 就在 `capabilities/sessions.ts`,而壳这一侧已经把
 * 兜底(首条用户消息 / 「未命名会话」)补上才接线,否则旧壳会画出一行空白。
 *
 * ## 为什么四种查询串都录
 *
 * 空词那一支的判据是 `normalizeSearchQuery(raw) === ''`,而裸 `/` 与 `>` 归一化
 * 之后同样是空串(它们是 `actions` 的意图前缀)。旧路对这三种输入答的是同一页,
 * 新路也必须 —— 夹具里那四把钥匙就是这句话。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SearchQuery } from '@onething/core/search'
import { createChatsSearchCapability, searchResultOf } from '../capabilities/index.js'
import type { OnethingSearchProvidersAdapters, OnethingSearchSessionMeta } from '../providers.js'
import { createSearchContext } from '../service.js'
import { fakeIndexFace } from './fake-index.js'

interface Fixture {
  sessions: OnethingSearchSessionMeta[]
  cases: Record<string, Array<Record<string, unknown>>>
}

const fixture = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/chats-browse.json'),
  'utf-8',
)) as Fixture

function adaptersOf(sessions: OnethingSearchSessionMeta[]): OnethingSearchProvidersAdapters {
  return {
    getSessionsList: () => sessions,
    iterateSessionMessages: () => [],
    getSession: () => undefined,
    getCurrentSessionId: () => undefined,
    getVariablesStore: () => ({
      getUserNoteDir: () => undefined,
      getWorkNoteDir: () => undefined,
    }),
    listFiles: () => ({ async *[Symbol.asyncIterator]() {} }),
    listPrompts: () => [],
  }
}

/**
 * 走**能力**这一层问,而不是直接调那只纯函数:要证的是「命令面板那一页」,而它
 * 中间隔着 `supports` 的空词判据、扫描基座的现造与投影。少一层就少证一件事。
 */
async function browse(raw: string, limit: number): Promise<Array<Record<string, unknown>>> {
  const capability = createChatsSearchCapability(
    adaptersOf(fixture.sessions),
    // 索引里放一份会 chats 文档也不该被答出来 —— 空词那一支根本不问索引。
    fakeIndexFace([{
      docId: 1,
      capability: 'chats',
      key: 's1',
      time: 200,
      facets: { sessionId: 's1', spaceId: '', archived: false, time: 200 },
      fields: { title: 'Alpha notes' },
    }]),
  )
  const query: SearchQuery = {
    raw,
    ast: { type: 'and', children: [] },
    intent: 'content',
    filters: {},
    capability: 'chats',
  }
  expect(capability.supports(query)).toBe(true)
  const page = await capability.search(query, { limit }, createSearchContext())
  // `target` / `facets` / `preview` 是能力多说的三格,旧录音里没有它们。
  return page.items.map(searchResultOf).map(({ target, facets, preview, ...rest }) => {
    void target
    void facets
    void preview
    // 过一趟 JSON:录音是 `JSON.stringify` 出来的,值为 undefined 的键在那一侧
    // 已经消失(旧路的 `matchRanges` 在空词下正是 undefined)。
    return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>
  })
}

/** 同一条路,但要的是**整页**(游标 / total 那两格判据在页上,不在行上)。 */
async function page(raw: string, limit: number, cursor?: string) {
  const capability = createChatsSearchCapability(adaptersOf(fixture.sessions), fakeIndexFace([]))
  const query: SearchQuery = {
    raw,
    ast: { type: 'and', children: [] },
    intent: 'content',
    filters: {},
    capability: 'chats',
  }
  return await capability.search(query, cursor === undefined ? { limit } : { limit, cursor }, createSearchContext())
}

describe('chats 的空词浏览态(S5:与录下来的旧输出逐条同)', () => {
  for (const [key, expected] of Object.entries(fixture.cases)) {
    const [rawJson, limitText] = key.split('@')
    const raw = JSON.parse(rawJson!) as string
    const limit = Number(limitText)
    it(`raw=${rawJson} limit=${limit}:${expected.length} 条,与旧输出逐字同`, async () => {
      expect(await browse(raw, limit)).toEqual(expected)
    })
  }

  it('归档的那间一条都不出现,次序是 updatedAt 降序', async () => {
    const rows = await browse('', 20)
    expect(rows.map(row => row.id)).toEqual(['chat:s3', 'chat:s5', 'chat:s1', 'chat:s2'])
    // s4 是归档的、而且是 updatedAt 最大的那一间 —— 它要是漏进来,一定排在最前。
    expect(rows.some(row => row.id === 'chat:s4')).toBe(false)
  })

  it('没名字的那间**归空**(步⑧接线;画什么归壳:首条用户消息 / 「未命名会话」)', async () => {
    const rows = await browse('', 20)
    expect(rows[0]).toMatchObject({ id: 'chat:s3', title: '' })
    expect('subtitle' in rows[0]!).toBe(false)
  })

  it('浏览态可翻页:第一页带 cursor、total 是真数,第二页接着走且不重不漏', async () => {
    const first = await page('', 2)
    expect(first.total).toBe(4)
    expect(first.cursor).toBeTypeOf('string')
    expect(first.items.map(item => item.id)).toEqual(['chat:s3', 'chat:s5'])

    const second = await page('', 2, first.cursor)
    expect(second.items.map(item => item.id)).toEqual(['chat:s1', 'chat:s2'])
    // 取尽 = 没有游标(契约:cursor 缺席 = 到底了)。
    expect(second.cursor).toBeUndefined()
    // 不重:两页的 id 集合不相交,合起来正好是全集。
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(4)
  })

  it('spaceId 那格过滤片在浏览态里也认 —— 判据是会话表上的 workspaceId', async () => {
    const sessions: OnethingSearchSessionMeta[] = fixture.sessions.map(session => ({
      ...session,
      workspaceId: session.id === 's1' ? 'w1' : 'w2',
    }))
    const capability = createChatsSearchCapability(adaptersOf(sessions), fakeIndexFace([]))
    const query: SearchQuery = {
      raw: '',
      ast: { type: 'and', children: [] },
      intent: 'content',
      filters: { spaceId: 'w1' },
      capability: 'chats',
    }
    const found = await capability.search(query, { limit: 20 }, createSearchContext())
    // 只剩 w1 那一间;`total` 是**过滤之后**的真数,不是全表条数。
    expect(found.items.map(item => item.id)).toEqual(['chat:s1'])
    expect(found.total).toBe(1)
  })
})

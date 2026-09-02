import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SearchResult } from '@shared/ipc/search'
import {
  ensureMessageSearch,
  messageSearchKey,
  messageSearchQuery,
  refetchMessageSearch,
  resetMessageSearch,
} from './message-search-source'
import { configureSearchPort } from './search-port'

/**
 * 正文检索数据源。验的是**取数那一半**:问了几次、缓存按什么键、失败怎么落、
 * 后端那张宽表怎么收窄成能落地的行。
 *
 * 「怎么用这批命中」不在这里(那在 search/transitions.test.ts 与面板的用例里),
 * 与文件侧那两半的分工逐字相同。
 */

const hit = (over: Partial<SearchResult> = {}): SearchResult => ({
  id: 'msg:s1:m1',
  type: 'message',
  title: '...这里提到了 provider 那条老路...',
  sessionId: 's1',
  messageId: 'm1',
  matchRanges: [{ start: 8, end: 16 }],
  ...over,
})

/** 记下每一次真的出门的请求 —— 缓存与去抖那两条断言全靠它。 */
let asks: Array<{ query: string; limit: number }> = []

function seedPort(answer: (query: string, limit: number) => {
  success: boolean
  results: SearchResult[]
}): void {
  configureSearchPort({
    ready: async () => undefined,
    queryMessages: async (query, limit) => {
      asks.push({ query, limit })
      return answer(query, limit)
    },
  })
}

beforeEach(() => {
  asks = []
  resetMessageSearch()
  seedPort(() => ({ success: true, results: [hit()] }))
})

afterEach(() => {
  resetMessageSearch()
  // 恢复 setup.ts 里那份默认假端口(空表)。
  configureSearchPort({
    ready: async () => undefined,
    queryMessages: async () => ({ success: true, results: [] }),
  })
})

const snapshot = (query: string, limit: number) =>
  messageSearchQuery.get(messageSearchKey(query, limit)).get()

describe('ensureMessageSearch:问一次', () => {
  it('把词与 limit 原样交给端口,答案落进那一格', async () => {
    await ensureMessageSearch('provider', 20)
    expect(asks).toEqual([{ query: 'provider', limit: 20 }])
    const snap = snapshot('provider', 20)
    expect(snap.phase).toBe('ready')
    expect(snap.data?.limit).toBe(20)
    expect(snap.data?.hits.map((h) => h.messageId)).toEqual(['m1'])
  })

  it('空词 / limit 为 0:一格都不建,一个字节都不出门', async () => {
    await ensureMessageSearch('', 20)
    await ensureMessageSearch('   ', 20)
    await ensureMessageSearch('provider', 0)
    expect(asks).toEqual([])
    expect(messageSearchQuery.keys()).toEqual([])
  })

  it('词两头的空白不算另一个问题(键前先 trim)', async () => {
    await ensureMessageSearch('provider', 20)
    await ensureMessageSearch('  provider  ', 20)
    expect(asks.length).toBe(1)
  })
})

describe('缓存:键是「词 + limit」', () => {
  it('同一个问题问两次,只出门一次', async () => {
    await ensureMessageSearch('provider', 20)
    await ensureMessageSearch('provider', 20)
    expect(asks.length).toBe(1)
  })

  /*
   * 这一条钉的是「删一个字母又打回去」那个常态:面板那条去抖副作用会为
   * 「pro」发一次、为「provider」发一次,再退回「pro」时不该再发第三次。
   */
  it('换词是另一格,换回来还是原来那一格', async () => {
    await ensureMessageSearch('pro', 20)
    await ensureMessageSearch('provider', 20)
    await ensureMessageSearch('pro', 20)
    expect(asks.map((a) => a.query)).toEqual(['pro', 'provider'])
  })

  /*
   * limit 进键的理由:后端没有游标,翻页 = 带一个更大的 limit 从头重查。
   * 20 条那份答案不能拿来回答 40 条那个问题 —— 它会被判成「取尽了」。
   */
  it('翻页(limit 变大)是另一个问题,必须真的再问一次', async () => {
    await ensureMessageSearch('provider', 20)
    await ensureMessageSearch('provider', 40)
    expect(asks).toEqual([
      { query: 'provider', limit: 20 },
      { query: 'provider', limit: 40 },
    ])
    // 两格各留各的答案,互不覆盖。
    expect(snapshot('provider', 20).data?.limit).toBe(20)
    expect(snapshot('provider', 40).data?.limit).toBe(40)
  })

  it('「重试」是用户明确要求重来:同一个键也照发不误', async () => {
    await ensureMessageSearch('provider', 20)
    await refetchMessageSearch('provider', 20)
    expect(asks.length).toBe(2)
  })

  /*
   * 键面封顶(files-source 那条「键随击键无限长」的顾虑,在这里的解法)。
   * 24 是 CACHE_KEYS —— 这里用 30 个不同的词把它顶出去,验最老的那一格真被丢掉
   * (丢掉 = 再问要重新出门,而不是「还在缓存里」)。
   */
  it('键面封顶:问过太多词之后,最老的那一格被丢掉而不是攒成一本账', async () => {
    for (let i = 0; i < 30; i++) await ensureMessageSearch(`word-${i}`, 20)
    expect(messageSearchQuery.keys().length).toBe(24)
    const before = asks.length
    await ensureMessageSearch('word-0', 20)
    expect(asks.length).toBe(before + 1)
    // 而最近问过的那一个照旧命中缓存。
    await ensureMessageSearch('word-29', 20)
    expect(asks.length).toBe(before + 1)
  })
})

describe('失败与收窄', () => {
  it("`success:false` 落在 error 上,而不是变成一份空命中", async () => {
    seedPort(() => ({ success: false, results: [] }))
    await ensureMessageSearch('provider', 20)
    const snap = snapshot('provider', 20)
    expect(snap.error).toBeTruthy()
    expect(snap.data).toBeUndefined()
  })

  /*
   * 律②:重拉失败不抹掉上一次的答案。这一格在 kernel 里是**性质**,
   * 而不是 files-source 那段带 `sameQuestion` 判断的手写代码 —— 钉一次。
   */
  it('同一格重试塌了:错误与旧答案并陈,屏幕上那批命中不消失', async () => {
    await ensureMessageSearch('provider', 20)
    seedPort(() => ({ success: false, results: [] }))
    await refetchMessageSearch('provider', 20)
    const snap = snapshot('provider', 20)
    expect(snap.error).toBeTruthy()
    expect(snap.data?.hits.length).toBe(1)
  })

  it('缺 sessionId / messageId 的行画不出来,就地丢掉(不留一行按不动的东西)', async () => {
    seedPort(() => ({
      success: true,
      results: [
        hit(),
        hit({ id: 'x1', sessionId: undefined }),
        hit({ id: 'x2', messageId: undefined }),
        hit({ id: 'x3', title: '' }),
      ],
    }))
    await ensureMessageSearch('provider', 20)
    expect(snapshot('provider', 20).data?.hits.map((h) => h.id)).toEqual(['msg:s1:m1'])
  })

  it('不是 message 类型的行一概不收 —— 这条口只要了这一档', async () => {
    seedPort(() => ({
      success: true,
      results: [hit(), hit({ id: 'c1', type: 'chat' }), hit({ id: 'f1', type: 'file' })],
    }))
    await ensureMessageSearch('provider', 20)
    expect(snapshot('provider', 20).data?.hits.map((h) => h.id)).toEqual(['msg:s1:m1'])
  })

  it('后端没给区间就是不高亮(空表),不退回本地再算一遍', async () => {
    seedPort(() => ({ success: true, results: [hit({ matchRanges: undefined })] }))
    await ensureMessageSearch('provider', 20)
    expect(snapshot('provider', 20).data?.hits[0].ranges).toEqual([])
  })

  it('后端没给 id 时按同一形状补一个 —— 行的 key 不许落空', async () => {
    seedPort(() => ({ success: true, results: [hit({ id: '' })] }))
    await ensureMessageSearch('provider', 20)
    expect(snapshot('provider', 20).data?.hits[0].id).toBe('msg:s1:m1')
  })
})

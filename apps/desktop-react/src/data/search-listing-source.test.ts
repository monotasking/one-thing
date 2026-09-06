import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { SearchResponse, SearchResult } from '@shared/ipc/search'
import { configureSearchPort } from './search-port'
import { fakeSearchPort } from '../test/fake-search-port'
import {
  ensureSearchListing,
  refetchSearchListing,
  resetSearchListing,
  searchListingKey,
  searchLoadMore,
  searchLoadMoreKey,
  useSearchListing,
} from './search-listing-source'
import type { SearchBlock, SearchListing } from './search-listing-source'

/**
 * 检索清单那一格的判据(迁移第 ④ 步)。取数走假端口 —— 不碰盘、不碰网。
 *
 * 读法走 `useSearchListing`(那是这个模块交出去的唯一读口 —— family 本身不导出,
 * 见它的文件头「为什么家门口不摆 invalidate」)。所以每条用例都是
 * `renderHook` + `act`,与 `kernel/react.test.tsx` 同一体例。
 */

afterEach(() => {
  // 先摘组件再清格:反过来的话 `reset()` 那一声 emit 会打在还挂着的 hook 上,
  // React 当场报 act 警告(vitest 的 afterEach 是后注册先跑,RTL 的自动 cleanup
  // 排在这一只后面)。
  cleanup()
  resetSearchListing()
  configureSearchPort(fakeSearchPort())
})

const CAP = 'messages'

function row(id: string): SearchResult {
  return { id, type: 'message', title: id, target: { kind: 'message', payload: { id } } }
}

function pageOf(ids: string[], cursor?: string): SearchResponse {
  return { success: true, results: ids.map(row), ...(cursor === undefined ? {} : { cursor }) }
}

/**
 * 一台**认游标的**假 core:`c<n>` 指第 n 页(从 0 数)。每一发都记账,
 * 好断言「问了几次、带的是哪个游标」。
 */
function pagedPort(pages: string[][]): Array<string | undefined> {
  const seen: Array<string | undefined> = []
  configureSearchPort(fakeSearchPort({
    query: async (_q, _capability, _limit, _filters, cursor) => {
      seen.push(cursor)
      const at = cursor === undefined ? 0 : Number(cursor.slice(1))
      return pageOf(pages[at] ?? [], at + 1 < pages.length ? `c${at + 1}` : undefined)
    },
  }))
  return seen
}

function mount(key: string) {
  const hook = renderHook(() => useSearchListing(key))
  return {
    listing: (): SearchListing | undefined => hook.result.current.data,
    block: (capability = CAP): SearchBlock | undefined =>
      hook.result.current.data?.blocks.find(b => b.capability === capability),
    snapshot: () => hook.result.current,
  }
}

async function land(key: string): Promise<void> {
  await act(async () => {
    await ensureSearchListing(key)
  })
}

async function loadMore(key: string, cursor: string, capability = CAP): Promise<void> {
  await act(async () => {
    await searchLoadMore.run({ key, capability, cursor })
  })
}

/* ── 键 ────────────────────────────────────────────────────────────────── */

describe('searchListingKey(三元键)', () => {
  it('键里没有 limit —— 翻页不换格', () => {
    expect(JSON.parse(searchListingKey(CAP, 'jira'))).toEqual([CAP, 'jira', {}])
  })

  it('词两头的空白不进键(还是同一张列表)', () => {
    expect(searchListingKey(CAP, '  jira  ')).toBe(searchListingKey(CAP, 'jira'))
  })

  it('一格的能力表折回标量 —— 缓存与线上不留第二种形状', () => {
    expect(searchListingKey(['chats'], '')).toBe(searchListingKey('chats', ''))
    expect(searchListingKey(['chats', 'files'], '')).not.toBe(searchListingKey('chats', ''))
  })

  it('过滤片进键 —— 按一颗片是另一份答案', () => {
    expect(searchListingKey(CAP, 'jira', { spaceId: 'a' }))
      .not.toBe(searchListingKey(CAP, 'jira', { spaceId: 'b' }))
  })
})

/* ── 首页 ──────────────────────────────────────────────────────────────── */

describe('首页落地', () => {
  it('单类档 = 一块;游标在场 = 还没取尽', async () => {
    pagedPort([['a', 'b'], ['c', 'd']])
    const key = searchListingKey(CAP, 'jira')
    const view = mount(key)
    await land(key)
    expect(view.listing()?.mode).toBe('single')
    expect(view.block()?.rows.map(r => r.id)).toEqual(['a', 'b'])
    expect(view.block()?.cursor).toBe('c1')
    expect(view.block()?.exhausted).toBe(false)
    expect(view.block()?.pages).toBe(1)
  })

  it('游标缺席 = 取尽(壳只认这一条)', async () => {
    pagedPort([['a']])
    const key = searchListingKey(CAP, 'jira')
    const view = mount(key)
    await land(key)
    expect(view.block()?.cursor).toBeUndefined()
    expect(view.block()?.exhausted).toBe(true)
  })

  it('全部档零命中的块:rows 为空且取尽(它照样在格里 —— 失败的块要靠它说话)', async () => {
    configureSearchPort(fakeSearchPort({
      query: async () => ({
        success: true,
        results: [row('a')],
        groups: [
          { capability: 'chats', label: '', results: [row('a')], cursor: 'c1' },
          { capability: 'files', label: '', results: [] },
          { capability: 'daily', label: '', results: [], error: 'boom' },
        ],
      }),
    }))
    const key = searchListingKey('all', 'jira')
    const view = mount(key)
    await land(key)
    expect(view.listing()?.mode).toBe('overview')
    expect(view.block('files')?.rows).toEqual([])
    expect(view.block('files')?.exhausted).toBe(true)
    expect(view.block('daily')?.error).toBe('boom')
    expect(view.block('chats')?.cursor).toBe('c1')
  })

  it('整发失败 = 抛(错误与「一条都没搜到」不是一件事)', async () => {
    configureSearchPort(fakeSearchPort({
      query: async () => ({ success: false, results: [], error: 'index down' }),
    }))
    const key = searchListingKey(CAP, 'jira')
    const view = mount(key)
    await land(key)
    expect(view.listing()).toBeUndefined()
    expect(view.snapshot().error).toBe('index down')
  })
})

/* ── 翻页 ──────────────────────────────────────────────────────────────── */

describe('翻页(同一格追加)', () => {
  it('新行追加在块末尾,旧行**对象引用不换**', async () => {
    pagedPort([['a', 'b'], ['c', 'd']])
    const key = searchListingKey(CAP, 'jira')
    const view = mount(key)
    await land(key)
    const first = view.block()?.rows[0]
    await loadMore(key, 'c1')
    expect(view.block()?.rows.map(r => r.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(view.block()?.rows[0]).toBe(first)
    expect(view.block()?.pages).toBe(2)
  })

  it('按 id 去重 —— 后端把上一页重放一遍也不会长出重复行', async () => {
    configureSearchPort(fakeSearchPort({
      query: async (_q, _c, _l, _f, cursor) =>
        (cursor === undefined ? pageOf(['a', 'b'], 'c1') : pageOf(['b', 'c'], 'c2')),
    }))
    const key = searchListingKey(CAP, 'jira')
    const view = mount(key)
    await land(key)
    await loadMore(key, 'c1')
    expect(view.block()?.rows.map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('闸①:同一个游标连按两下,第二发被丢弃(不重不错)', async () => {
    pagedPort([['a', 'b'], ['c', 'd'], ['e', 'f']])
    const key = searchListingKey(CAP, 'jira')
    const view = mount(key)
    await land(key)
    await loadMore(key, 'c1')
    // 第二发带的是**发车那一刻**的游标 c1,而格里那一块此刻已经是 c2 —— 丢弃。
    await loadMore(key, 'c1')
    expect(view.block()?.rows.map(r => r.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(view.block()?.cursor).toBe('c2')
    expect(view.block()?.exhausted).toBe(false)
    expect(view.block()?.pages).toBe(2)
  })

  it('闸③:一条新 id 都没有 = 按取尽处理(而不是「按了永远没反应」)', async () => {
    configureSearchPort(fakeSearchPort({
      query: async (_q, _c, _l, _f, cursor) =>
        (cursor === undefined ? pageOf(['a', 'b'], 'c1') : pageOf(['a', 'b'], 'c2')),
    }))
    const key = searchListingKey(CAP, 'jira')
    const view = mount(key)
    await land(key)
    await loadMore(key, 'c1')
    expect(view.block()?.rows.map(r => r.id)).toEqual(['a', 'b'])
    expect(view.block()?.exhausted).toBe(true)
    expect(view.block()?.cursor).toBeUndefined()
  })

  it('翻页塌了:行一条不丢、游标不动(重试发同一个)', async () => {
    let calls = 0
    configureSearchPort(fakeSearchPort({
      query: async (_q, _c, _l, _f, cursor) => {
        calls += 1
        if (cursor === undefined) return pageOf(['a', 'b'], 'c1')
        if (calls === 2) return { success: false, results: [], error: 'page boom' }
        return pageOf(['c'], undefined)
      },
    }))
    const key = searchListingKey(CAP, 'jira')
    const view = mount(key)
    await land(key)
    await loadMore(key, 'c1')
    expect(view.block()?.rows.map(r => r.id)).toEqual(['a', 'b'])
    expect(view.block()?.pageError).toBe('page boom')
    expect(view.block()?.cursor).toBe('c1')

    // 重试:**同一个游标**,成功之后 pageError 自己清掉(清它的地方只有一处)。
    await loadMore(key, 'c1')
    expect(view.block()?.rows.map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(view.block()?.pageError).toBeUndefined()
  })

  it('忙态逐块(律③)—— 键是 `<格>#<块>`', () => {
    const key = searchListingKey(CAP, 'jira')
    expect(searchLoadMoreKey(key, CAP)).toBe(`${key}#${CAP}`)
    expect(searchLoadMore.isPending(searchLoadMoreKey(key, CAP))).toBe(false)
  })
})

/* ── 回放与身份 ────────────────────────────────────────────────────────── */

describe('重拉', () => {
  it('回放链:重拉之后行集**不缩**(翻到第几页就再走到第几页)', async () => {
    const seen = pagedPort([['a', 'b'], ['c', 'd'], ['e', 'f']])
    const key = searchListingKey(CAP, 'jira')
    const view = mount(key)
    await land(key)
    await loadMore(key, 'c1')
    expect(view.block()?.rows).toHaveLength(4)

    seen.length = 0
    await act(async () => {
      await refetchSearchListing(key)
    })
    // 头页 + 顺着游标再走一步 —— 账只有一处(`previous.blocks[].pages`)。
    expect(seen).toEqual([undefined, 'c1'])
    expect(view.block()?.rows.map(r => r.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(view.block()?.pages).toBe(2)
  })

  it('equals:逐字相同的一份答案不换引用(律④)', async () => {
    pagedPort([['a', 'b'], ['c', 'd']])
    const key = searchListingKey(CAP, 'jira')
    const view = mount(key)
    await land(key)
    const before = view.listing()
    const rev = view.snapshot().dataRev
    await act(async () => {
      await refetchSearchListing(key)
    })
    expect(view.listing()).toBe(before)
    expect(view.snapshot().dataRev).toBe(rev)
  })

  it('飞行期重拉落地之后,旧游标那一发的 settle 被丢弃', async () => {
    /*
     * 剧情:头页给 c1;`loadMore(c1)` 起飞但**卡住**;这期间一次 `refetch` 落地,
     * 后端换了一份答案(游标变成 c9)。此刻那一发 loadMore 再落地 —— 它带的
     * 游标是 c1,而格里那一块是 c9,**整发作废**(闸①)。
     */
    let head = 0
    let releaseMore!: (value: SearchResponse) => void
    const stuck = new Promise<SearchResponse>((resolve) => { releaseMore = resolve })
    configureSearchPort(fakeSearchPort({
      query: async (_q, _c, _l, _f, cursor) => {
        if (cursor === undefined) {
          head += 1
          return head === 1 ? pageOf(['a'], 'c1') : pageOf(['x'], 'c9')
        }
        if (cursor === 'c1') return await stuck
        return pageOf([], undefined)
      },
    }))
    const key = searchListingKey(CAP, 'jira')
    const view = mount(key)
    await land(key)

    let flying!: Promise<unknown>
    await act(async () => {
      flying = searchLoadMore.run({ key, capability: CAP, cursor: 'c1' })
    })
    await act(async () => {
      await refetchSearchListing(key)
    })
    expect(view.block()?.cursor).toBe('c9')

    await act(async () => {
      releaseMore(pageOf(['stale'], 'c2'))
      await flying
    })
    expect(view.block()?.rows.map(r => r.id)).toEqual(['x'])
    expect(view.block()?.cursor).toBe('c9')
  })
})

/* ── 退役 ──────────────────────────────────────────────────────────────── */

describe('reset', () => {
  it('回到出厂:格清空,下一次 ensure 会重新问', async () => {
    const seen = pagedPort([['a']])
    const key = searchListingKey(CAP, 'jira')
    const view = mount(key)
    await land(key)
    expect(seen).toHaveLength(1)
    await act(async () => {
      resetSearchListing()
    })
    expect(view.listing()).toBeUndefined()
    await land(key)
    expect(seen).toHaveLength(2)
  })
})

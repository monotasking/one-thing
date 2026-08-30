import { describe, expect, it } from 'vitest'
import type { ProjectedToolCall } from '../../model/segments'
import { plainText, presentResearchEpisode, sourceStep, stackDomains } from '../episode'

/**
 * 检索段的**折叠**单测(§5.3)。
 *
 * 夹具照抄真 store 的形状(2026-08-30 勘察,449 个会话 / 389 次 web 调用):
 * `metadata.searches[].results[]` 是完整形,`metadata.results[]` 无 `searches` 是老形态,
 * `metadata.pages[0]` 是 `web_open` 真读到的那一页。**不发明字段** —— 这里每一格
 * 都在真账本上出现过。
 */

const T0 = 1_700_000_000_000

function search(
  id: string,
  args: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  patch: Record<string, unknown> = {},
): ProjectedToolCall {
  return {
    id,
    toolId: 'web_search',
    toolName: 'web_search',
    arguments: args,
    status: 'completed',
    timestamp: T0,
    ...(metadata ? { result: { title: 'x', output: 'x', metadata } } : {}),
    ...patch,
  } as unknown as ProjectedToolCall
}

function open(
  id: string,
  args: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  patch: Record<string, unknown> = {},
): ProjectedToolCall {
  return {
    id,
    toolId: 'web_open',
    toolName: 'web_open',
    arguments: args,
    status: 'completed',
    timestamp: T0,
    ...(metadata ? { result: { title: 'x', output: 'x', metadata } } : {}),
    ...patch,
  } as unknown as ProjectedToolCall
}

const result = (rank: number, url: string, title: string, snippet?: string) => ({
  id: `r${rank}`,
  rank,
  url,
  title,
  ...(snippet ? { snippet } : {}),
})

describe('查询词分组', () => {
  it('一次 web_search 的每条查询词自成一组(真账本:模型常同时搜中英两版)', () => {
    const episode = presentResearchEpisode([
      search('w1', { query: 'AI 新闻', queries: ['AI news'] }, {
        query: 'AI 新闻',
        provider: 'brave',
        searches: [
          { id: 's1', query: 'AI 新闻', results: [result(1, 'https://a.com/x', 'A')] },
          { id: 's2', query: 'AI news', results: [result(1, 'https://b.com/y', 'B')] },
        ],
      }),
    ])
    expect(episode.groups.map((group) => group.query)).toEqual(['AI 新闻', 'AI news'])
    expect(episode.queries).toEqual(['AI 新闻', 'AI news'])
    expect(episode.sources.map((source) => source.domain)).toEqual(['a.com', 'b.com'])
  })

  it('老形态(没有 searches)折成一组,查询词退到 metadata.query', () => {
    const episode = presentResearchEpisode([
      search('w1', { query: '写在参数里的' }, {
        provider: 'brave',
        query: '写在结果里的',
        results: [{ title: 'A', url: 'https://a.com/x', snippet: 's' }],
      }),
    ])
    expect(episode.groups).toHaveLength(1)
    expect(episode.groups[0].query).toBe('写在结果里的')
    expect(episode.sources).toHaveLength(1)
  })

  it('失败的搜索仍然留一组 —— 「搜了 X 没搜着」是事实,抹掉它像是压根没搜', () => {
    const episode = presentResearchEpisode([
      search('w1', { query: '北京天气' }, undefined, {
        status: 'failed',
        result: { success: false, error: 'Brave Search API error: 404' },
      }),
    ])
    expect(episode.groups).toEqual([
      expect.objectContaining({ query: '北京天气', sources: [] }),
    ])
    expect(episode.failed).toBe(1)
  })

  it('后到的 web_open 归入最后一组', () => {
    const episode = presentResearchEpisode([
      search('w1', { query: 'q' }, {
        searches: [{ id: 's1', query: 'q', results: [result(1, 'https://a.com/x', 'A')] }],
      }),
      open('w2', { url: 'https://b.com/y', title: 'B' }),
    ])
    expect(episode.groups).toHaveLength(1)
    expect(episode.groups[0].sources.map((source) => source.domain)).toEqual(['a.com', 'b.com'])
  })

  it('开在最前的 open 归未署名组,而且那一组排在最前', () => {
    const episode = presentResearchEpisode([
      open('w1', { url: 'https://a.com/x', title: 'A' }),
      search('w2', { query: 'q' }, {
        searches: [{ id: 's1', query: 'q', results: [result(1, 'https://b.com/y', 'B')] }],
      }),
    ])
    expect(episode.groups.map((group) => group.query)).toEqual([undefined, 'q'])
    expect(episode.groups[0].sources.map((source) => source.domain)).toEqual(['a.com'])
    // 未署名组不进「M 组查询」—— 它没有查询词。
    expect(episode.queries).toEqual(['q'])
  })
})

describe('来源清单', () => {
  it('同一个 URL 在一段里只有一条:先搜到、后打开 = 同一条被标记为已打开', () => {
    const episode = presentResearchEpisode([
      search('w1', { query: 'q' }, {
        searches: [{ id: 's1', query: 'q', results: [result(1, 'https://a.com/x', '列表短名')] }],
      }),
      open('w2', { url: 'https://a.com/x', title: '打开后的真标题' }, {
        mode: 'open',
        pages: [{ id: 'p1', url: 'https://a.com/x', title: '打开后的真标题', excerpt: '正文摘录', status: 'ok' }],
      }),
    ])
    expect(episode.sources).toHaveLength(1)
    expect(episode.sources[0]).toMatchObject({
      opened: true,
      openCallId: 'w2',
      openStatus: 'ok',
      // 打开之后拿到的是真标题,比搜索给的列表短名更好 —— 后到的换上。
      title: '打开后的真标题',
      excerpt: '正文摘录',
    })
    expect(episode.openedCount).toBe(1)
  })

  it('页面自己说没读到正文时,结局是 failed —— 不拿「调用成功」冒充「读到了」', () => {
    const episode = presentResearchEpisode([
      open('w1', { url: 'https://a.com/x' }, {
        mode: 'open',
        pages: [
          {
            id: 'p1',
            url: 'https://a.com/x',
            status: 'failed',
            error: 'No readable text found on the page.',
          },
        ],
      }),
    ])
    expect(episode.sources[0].openStatus).toBe('failed')
    // 「打开 M 个页面」数的是真读到正文的那些。
    expect(episode.openedCount).toBe(0)
    // 调用本身没失败:失败账与打开结局是两笔。
    expect(episode.failed).toBe(0)
  })

  it('摘录剥掉搜索引擎塞的高亮标签与实体', () => {
    const episode = presentResearchEpisode([
      search('w1', { query: 'q' }, {
        searches: [
          {
            id: 's1',
            query: 'q',
            results: [result(1, 'https://a.com/x', 'A', '由 <strong>SGLang</strong> 孵化&quot;出&quot;')],
          },
        ],
      }),
    ])
    expect(episode.sources[0].excerpt).toBe('由 SGLang 孵化"出"')
  })

  it('URL 解析不了时域名留原样那串字符,不编一个', () => {
    const episode = presentResearchEpisode([open('w1', { url: 'not a url' })])
    expect(episode.sources[0].domain).toBe('not a url')
  })

  it('一条来源都没有的段也是合法的段(全失败),清单为空但不炸', () => {
    const episode = presentResearchEpisode([
      search('w1', {}, undefined, { status: 'failed' }),
    ])
    expect(episode.sources).toEqual([])
    // 参数与结果都没有查询词 → 组头没有词可说,但组还在。
    expect(episode.groups[0].query).toBeUndefined()
  })
})

describe('段级读数', () => {
  it('耗时是各次之和;一次都算不出就缺席', () => {
    expect(
      presentResearchEpisode([
        search('w1', { query: 'q' }, undefined, { durationMs: 6523 }),
        open('w2', { url: 'https://a.com/x' }, undefined, { durationMs: 2906 }),
      ]).durationMs,
    ).toBe(9429)
    expect(presentResearchEpisode([search('w1', { query: 'q' })]).durationMs).toBeUndefined()
  })

  it('还有调用在跑就是 running,活动说的是最后那一条', () => {
    const episode = presentResearchEpisode([
      search('w1', { query: 'q' }, undefined, { status: 'completed' }),
      open('w2', { url: 'https://web.dev/a', title: '标题' }, undefined, { status: 'executing' }),
    ])
    expect(episode.running).toBe(true)
    expect(episode.active).toEqual({ kind: 'open', domain: 'web.dev', title: '标题' })
  })

  it('正在抓的页面还不算「打开了一个页面」—— 结局缺席,进度那个数不提前跳', () => {
    const episode = presentResearchEpisode([
      open('w1', { url: 'https://a.com/x' }, undefined, { status: 'executing' }),
    ])
    expect(episode.sources[0]).toMatchObject({ opened: true, openCallId: 'w1' })
    expect(episode.sources[0].openStatus).toBeUndefined()
    expect(episode.openedCount).toBe(0)
  })

  it('全部收场就不 running,也没有活动', () => {
    const episode = presentResearchEpisode([search('w1', { query: 'q' })])
    expect(episode.running).toBe(false)
    expect(episode.active).toBeUndefined()
  })

  it('cancelled 与 failed 一样计一笔失败账', () => {
    expect(
      presentResearchEpisode([search('w1', { query: 'q' }, undefined, { status: 'cancelled' })])
        .failed,
    ).toBe(1)
  })
})

describe('来源 → 调用的对应', () => {
  it('打开过的来源认打开那次,没打开过的认引入它的那次搜索', () => {
    const episode = presentResearchEpisode([
      search('w1', { query: 'q' }, {
        searches: [
          {
            id: 's1',
            query: 'q',
            results: [result(1, 'https://a.com/x', 'A'), result(2, 'https://b.com/y', 'B')],
          },
        ],
      }),
      open('w2', { url: 'https://a.com/x' }, {
        mode: 'open',
        pages: [{ id: 'p1', url: 'https://a.com/x', status: 'ok' }],
      }),
    ])
    expect(sourceStep(episode, episode.sources[0])?.call.id).toBe('w2')
    expect(sourceStep(episode, episode.sources[1])?.call.id).toBe('w1')
  })
})

describe('小工具', () => {
  it('堆叠域名按来源序去重 —— 同一个站的两页只占一枚脸', () => {
    expect(
      stackDomains([
        { id: '1', url: 'https://a.com/x', domain: 'a.com', callId: 'w1', opened: false },
        { id: '2', url: 'https://a.com/y', domain: 'a.com', callId: 'w1', opened: false },
        { id: '3', url: 'https://b.com/z', domain: 'b.com', callId: 'w1', opened: false },
      ]),
    ).toEqual(['a.com', 'b.com'])
  })

  it('剥完只剩空白就是缺席,不留一个空字符串', () => {
    expect(plainText('<em></em>   ')).toBeUndefined()
    expect(plainText(undefined)).toBeUndefined()
  })
})

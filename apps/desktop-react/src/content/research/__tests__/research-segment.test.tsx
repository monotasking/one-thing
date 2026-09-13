import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useStageStore } from '../../../stage/store'
import type { BlockCtx } from '../../blocks/registry'
import type { ProjectedToolCall } from '../../model/segments'
import { presentResearchEpisode } from '../episode'
import { ResearchSegment } from '../ResearchSegment'
import { revealResearch } from '../reveal'

/**
 * 检索段的**上屏**测(§5.3 前三件)。
 *
 * 模型那一半在 `episode.test.ts` 钉着;这里钉的是定稿里那几条画法:流中态那一行
 * 说的是最后一条活动、收起时清单不在场、展开按查询词分组、来源行点开是 C1 抽屉、
 * favicon 取不到时降级成字母圆片、来源条能把段唤出来。
 */

vi.mock('../../code/highlight', () => ({
  loadHighlighter: () => Promise.resolve(undefined),
  highlight: () => undefined,
  HIGHLIGHT_THEME: 'vitesse-light',
  resetHighlighterForTest: () => undefined,
}))

const T0 = 1_700_000_000_000
const ctx: BlockCtx = { messageId: 'a1', streaming: false }

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

function search(
  id: string,
  query: string,
  results: { url: string; title: string }[],
  patch: Record<string, unknown> = {},
): ProjectedToolCall {
  return {
    id,
    toolId: 'web_search',
    toolName: 'web_search',
    arguments: { query },
    status: 'completed',
    timestamp: T0,
    result: {
      title: 'x',
      output: '结果正文',
      metadata: {
        query,
        searches: [
          {
            id: 's1',
            query,
            results: results.map((item, index) => ({ id: `r${index}`, rank: index + 1, ...item })),
          },
        ],
      },
    },
    ...patch,
  } as unknown as ProjectedToolCall
}

async function draw(calls: ProjectedToolCall[], id = 'a1:0:research') {
  const view = render(
    <ResearchSegment episode={presentResearchEpisode(calls)} id={id} ctx={ctx} />,
  )
  await act(async () => undefined)
  return view
}

const click = async (element: Element) => {
  await act(async () => {
    fireEvent.click(element)
  })
}

describe('收起行', () => {
  it('一句话:检索 · N 个来源;右端 M 组查询 + 耗时', async () => {
    const { container } = await draw([
      search('w1', 'react 19', [
        { url: 'https://react.dev/a', title: 'A' },
        { url: 'https://web.dev/b', title: 'B' },
      ], { durationMs: 2010 }),
    ])
    const head = container.querySelector('button')!
    expect(head.textContent).toContain('检索')
    expect(head.textContent).toContain('2 个来源')
    expect(head.textContent).toContain('1 组查询')
    expect(head.textContent).toContain('2.0s')
    // 收起时清单不在场 —— 它是一句话,不是一堆折起来的行。
    expect(container.querySelector('ul')).toBeNull()
  })

  it('默认收起;点一下才有清单,再点一下收回去', async () => {
    const { container } = await draw([
      search('w1', 'react 19', [{ url: 'https://react.dev/a', title: '标题 A' }]),
    ])
    const head = container.querySelector('button')!
    expect(head.getAttribute('aria-expanded')).toBe('false')

    await click(head)
    expect(container.textContent).toContain('搜索 react 19')
    expect(container.textContent).toContain('标题 A')
    expect(container.textContent).toContain('react.dev')

    await click(head)
    expect(container.querySelector('ul')).toBeNull()
  })

  it('有失败就在右端亮一句红(与工具组同一句话)', async () => {
    const { container } = await draw([
      search('w1', 'q', [{ url: 'https://a.com/x', title: 'A' }], { status: 'failed' }),
    ])
    expect(container.querySelector('button')!.textContent).toContain('1 失败')
  })
})

describe('展开清单', () => {
  it('按查询词分组:两条查询词两个组头', async () => {
    const calls = [
      search('w1', '中文词', [{ url: 'https://a.com/x', title: 'A' }]),
      search('w2', 'english', [{ url: 'https://b.com/y', title: 'B' }]),
    ]
    const { container } = await draw(calls)
    await click(container.querySelector('button')!)
    const heads = [...container.querySelectorAll('h5')].map((node) => node.textContent)
    expect(heads).toEqual(['搜索 中文词', '搜索 english'])
  })

  it('未署名组的组头是「直接打开」—— 不给它编一个查询词', async () => {
    const openCall = {
      id: 'w1',
      toolId: 'web_open',
      toolName: 'web_open',
      arguments: { url: 'https://a.com/x', title: 'A' },
      status: 'completed',
      timestamp: T0,
    } as unknown as ProjectedToolCall
    const { container } = await draw([openCall])
    await click(container.querySelector('button')!)
    expect(container.querySelector('h5')!.textContent).toBe('直接打开')
  })

  it('搜空了的组说出来,不把整组抹掉', async () => {
    const { container } = await draw([search('w1', '搜不到的', [])])
    await click(container.querySelector('button')!)
    expect(container.textContent).toContain('搜索 搜不到的')
    expect(container.textContent).toContain('这一组没有搜到来源')
  })

  it('打开过但没读到正文的来源当场说明 —— 否则屏幕在替它说谎', async () => {
    const openCall = {
      id: 'w1',
      toolId: 'web_open',
      toolName: 'web_open',
      arguments: { url: 'https://a.com/x', title: 'A' },
      status: 'completed',
      timestamp: T0,
      result: {
        metadata: {
          mode: 'open',
          pages: [{ id: 'p1', url: 'https://a.com/x', status: 'failed', error: 'no text' }],
        },
      },
    } as unknown as ProjectedToolCall
    const { container } = await draw([openCall])
    await click(container.querySelector('button')!)
    expect(container.textContent).toContain('未读到正文')
  })

  it('来源行点开的是 C1 抽屉 —— 嵌套即复用,不是第二种详情', async () => {
    const { container } = await draw([
      search('w1', 'q', [{ url: 'https://a.com/x', title: '标题 A' }]),
    ])
    await click(container.querySelector('button')!)
    const rows = [...container.querySelectorAll('li button')]
    expect(rows).toHaveLength(1)
    await click(rows[0])
    // 抽屉的两小节:参数 · 结果(与工具卡逐字同一个组件)。
    expect(container.textContent).toContain('参数')
    expect(container.textContent).toContain('结果')
    expect(container.textContent).toContain('结果正文')
  })
})

describe('流中态行', () => {
  it('说的是最后一条活动的调用 + 一条进度副行', async () => {
    const { container } = await draw([
      search('w1', '第一轮', [{ url: 'https://a.com/x', title: 'A' }]),
      {
        id: 'w2',
        toolId: 'web_open',
        toolName: 'web_open',
        arguments: { url: 'https://web.dev/a', title: '页面标题' },
        status: 'executing',
        timestamp: T0,
      } as unknown as ProjectedToolCall,
    ])
    expect(container.textContent).toContain('正在阅读 web.dev — 页面标题')
    expect(container.textContent).toContain('已搜索 1 组关键词 · 打开 0 个页面')
    // 还在跑就没有收起行可点:那一刻「N 个来源」还在变。
    expect(container.querySelector('button')).toBeNull()
  })

  it('搜的时候说搜的那句;连查询词都没有时退到「正在检索」,不编一个词', async () => {
    const busy = (args: Record<string, unknown>) =>
      ({
        id: 'w1',
        toolId: 'web_search',
        toolName: 'web_search',
        arguments: args,
        status: 'executing',
        timestamp: T0,
      }) as unknown as ProjectedToolCall

    const withQuery = await draw([busy({ query: 'react 19' })])
    expect(withQuery.container.textContent).toContain('正在搜索 react 19')

    const without = await draw([busy({})])
    expect(without.container.textContent).toContain('正在检索')
  })
})

describe('favicon', () => {
  const one = () => draw([search('w1', 'q', [{ url: 'https://react.dev/a', title: 'A' }])])

  it('像主机名就去站点自己那一份取(不经第三方),并且懒加载', async () => {
    const { container } = await one()
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('https://react.dev/favicon.ico')
    expect(img.getAttribute('loading')).toBe('lazy')
  })

  it('图还没来的时候底下已经是一张脸 —— 不留 14px 的洞', async () => {
    const { container } = await one()
    // 懒加载的图可能永远不开始加载(没进视口),所以「等它」不是一个选项。
    expect(container.textContent).toContain('R')
  })

  it('取不到就只剩代位圆片(域名首字,大写)', async () => {
    const { container } = await one()
    await act(async () => {
      fireEvent.error(container.querySelector('img')!)
    })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('R')
  })

  it('软 404(200 + 一页 HTML)也算取不到 —— naturalWidth 是唯一可靠的判据', async () => {
    const { container } = await one()
    const img = container.querySelector('img')!
    Object.defineProperty(img, 'naturalWidth', { value: 0, configurable: true })
    await act(async () => {
      fireEvent.load(img)
    })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('R')
  })

  it('真解出像素了才把字母让位给图标', async () => {
    const { container } = await one()
    const img = container.querySelector('img')!
    Object.defineProperty(img, 'naturalWidth', { value: 32, configurable: true })
    await act(async () => {
      fireEvent.load(img)
    })
    expect(container.querySelector('img')).not.toBeNull()
    expect(container.textContent).not.toContain('R')
  })

  it('域名压根不像主机名时连请求都不发,直接画代位圆片', async () => {
    const openCall = {
      id: 'w1',
      toolId: 'web_open',
      toolName: 'web_open',
      arguments: { url: 'not a url' },
      status: 'completed',
      timestamp: T0,
    } as unknown as ProjectedToolCall
    const { container } = await draw([openCall])
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('N')
  })
})

describe('被来源条唤出来', () => {
  it('收到自己那一份信号:展开 + 滚进视野', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    const { container } = await draw(
      [search('w1', 'q', [{ url: 'https://a.com/x', title: '标题 A' }])],
      'a1:3:research',
    )
    expect(container.querySelector('ul')).toBeNull()

    await act(async () => {
      revealResearch('a1:3:research')
    })
    expect(container.textContent).toContain('标题 A')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('点名的是别人就不动 —— 一条消息上可以有两段检索', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    const { container } = await draw(
      [search('w1', 'q', [{ url: 'https://a.com/x', title: '标题 A' }])],
      'a1:3:research',
    )
    await act(async () => {
      revealResearch('a1:9:research')
    })
    expect(container.querySelector('ul')).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})

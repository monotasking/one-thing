import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useStageStore } from '../../../stage/store'
import type { BlockCtx } from '../../blocks/registry'
import type { ProjectedToolCall } from '../../model/segments'
import { presentResearchEpisode } from '../episode'
import { ResearchSegment } from '../ResearchSegment'
import { openSourceUrl } from '../open-source'

vi.mock('../open-source', () => ({ openSourceUrl: vi.fn(() => Promise.resolve(true)) }))

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

/** 收起行:`ui/Fold` 的触发器(role=button),段里第一个带 aria-expanded 的。 */
const head = (container: HTMLElement) => container.querySelector('[role="button"][aria-expanded]')!

/** 看得见的那几条(筛选与收起都是 hidden,不卸载)。 */
const visibleRows = (container: HTMLElement) =>
  [...container.querySelectorAll('li')].filter((li) => !li.closest('[hidden]'))

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
    const row = head(container)
    expect(row.textContent).toContain('检索')
    expect(row.textContent).toContain('2 个来源')
    expect(row.textContent).toContain('1 组查询')
    expect(row.textContent).toContain('2.0s')
    // 收起时清单不在场 —— 它是一句话,不是一堆折起来的行。
    expect(container.querySelector('ul')).toBeNull()
  })

  it('默认收起;点一下才有清单,再点一下收回去', async () => {
    const { container } = await draw([
      search('w1', 'react 19', [{ url: 'https://react.dev/a', title: '标题 A' }]),
    ])
    const trigger = head(container)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    await click(trigger)
    expect(container.querySelector('h5')!.textContent).toContain('react 19')
    expect(container.textContent).toContain('标题 A')
    expect(container.textContent).toContain('react.dev')

    // 收起是 hidden,不是卸载:再开时是同一批节点(树/面常驻铁律 —— 重挂就是闪)。
    const list = container.querySelector('ul')!
    await click(trigger)
    expect(visibleRows(container)).toHaveLength(0)
    await click(trigger)
    expect(container.querySelector('ul')).toBe(list)
    expect(visibleRows(container)).toHaveLength(1)
  })

  it('搜索失败在右端亮一句红,说的是「几次搜索失败」', async () => {
    const { container } = await draw([
      search('w1', 'q', [{ url: 'https://a.com/x', title: 'A' }], { status: 'failed' }),
    ])
    expect(head(container).textContent).toContain('1 次搜索失败')
  })
})

describe('展开清单', () => {
  it('按查询词分组:两条查询词两个组头', async () => {
    const calls = [
      search('w1', '中文词', [{ url: 'https://a.com/x', title: 'A' }]),
      search('w2', 'english', [{ url: 'https://b.com/y', title: 'B' }]),
    ]
    const { container } = await draw(calls)
    await click(head(container))
    // 组头 = 查询词 + 这一组的条数(文字读数,不是徽)。
    const heads = [...container.querySelectorAll('h5')].map((node) => node.textContent)
    expect(heads).toEqual(['中文词1 条', 'english1 条'])
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
    await click(head(container))
    expect(container.querySelector('h5')!.textContent).toBe('直接打开1 条')
  })

  it('搜空了的组说出来,不把整组抹掉', async () => {
    const { container } = await draw([search('w1', '搜不到的', [])])
    await click(head(container))
    expect(container.querySelector('h5')!.textContent).toBe('搜不到的')
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
    await click(head(container))
    expect(container.textContent).toContain('未读到正文')
  })

  it('原始调用降在详情的第三个动作后面,点开是 C1 抽屉 —— 嵌套即复用', async () => {
    const { container } = await draw([
      search('w1', 'q', [{ url: 'https://a.com/x', title: '标题 A' }]),
    ])
    await click(head(container))
    // 一行 = 行钮 + 两颗快捷钮(兄弟,不是父子)。
    const row = container.querySelector('li [role="button"][aria-expanded]')!
    await click(row)
    // 点开先给摘录与地址,抽屉此刻还不在。
    expect(container.textContent).toContain('https://a.com/x')
    expect(container.textContent).not.toContain('参数')
    const raw = [...container.querySelectorAll('li [role="button"]')].find((b) =>
      b.textContent?.includes('看原始调用'),
    )!
    await click(raw)
    // 抽屉的两小节:参数 · 结果(与工具卡逐字同一个组件)。
    expect(container.textContent).toContain('参数')
    expect(container.textContent).toContain('结果')
    expect(container.textContent).toContain('结果正文')
  })
})

describe('流中态行', () => {
  it('步骤单:每次搜索 / 阅读一行,顶上报已找到几个来源', async () => {
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
    // 正在读的那一页本身也是一个来源(它从打开那一刻起就在清单上)。
    expect(container.textContent).toContain('已找到 2 个来源')
    const steps = [...container.querySelectorAll('[data-step-status]')]
    expect(steps.map((node) => node.getAttribute('data-step-status'))).toEqual(['ok', 'running'])
    expect(steps[0].textContent).toBe('搜索第一轮1 条')
    expect(steps[1].textContent).toContain('阅读')
    expect(steps[1].textContent).toContain('页面标题')
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
    expect(withQuery.container.querySelector('[data-step-status]')!.textContent).toContain('react 19')

    const without = await draw([busy({})])
    expect(without.container.textContent).toContain('正在检索')
  })
})

function opened(id: string, url: string, title: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    toolId: 'web_open',
    toolName: 'web_open',
    arguments: { url, title },
    status: 'completed',
    timestamp: T0,
    result: {
      title: 'x',
      output: 'x',
      metadata: { mode: 'open', pages: [{ id: `p-${id}`, url, title, excerpt: `${title} 的正文` }] },
    },
    ...patch,
  } as unknown as ProjectedToolCall
}

describe('读过与没读过(09-27 重做)', () => {
  const twoOfThree = () => [
    search('w1', 'q', [
      { url: 'https://a.com/x', title: 'A' },
      { url: 'https://b.com/y', title: 'B' },
      { url: 'https://c.com/z', title: 'C' },
    ]),
    opened('w2', 'https://a.com/x', 'A'),
    opened('w3', 'https://b.com/y', 'B', {
      result: { metadata: { mode: 'open', pages: [{ id: 'p', url: 'https://b.com/y', status: 'failed' }] } },
    }),
  ]

  it('收起行多说一件事:细读几篇;打开了却没读到的在右端说红字', async () => {
    const { container } = await draw(twoOfThree())
    const text = head(container).textContent
    expect(text).toContain('3 个来源')
    expect(text).toContain('细读 1 篇')
    expect(text).toContain('1 篇未读到')
  })

  it('一篇都没读时不说「细读 0 篇」—— 那句话只在有东西可说时出现', async () => {
    const { container } = await draw([search('w1', 'q', [{ url: 'https://a.com/x', title: 'A' }])])
    expect(head(container).textContent).not.toContain('细读')
  })

  it('读过的带「已读」签;「只看已读」只留它们', async () => {
    const { container } = await draw(twoOfThree())
    await click(head(container))
    const read = container.querySelectorAll('[data-source-read]')
    expect(read).toHaveLength(1)
    expect(read[0].textContent).toContain('已读')
    expect(visibleRows(container)).toHaveLength(3)

    const onlyRead = [...container.querySelectorAll('[role="radio"]')].find((b) =>
      b.textContent?.includes('只看已读'),
    )!
    await click(onlyRead)
    expect(visibleRows(container)).toHaveLength(1)
  })

  it('点开一条来源:行本身一个字不动,只在下面多出详情', async () => {
    const { container } = await draw([
      search('w1', 'q', [{ url: 'https://a.com/x', title: 'A', snippet: '摘要一句' } as never]),
    ])
    await click(head(container))
    const row = container.querySelector('li [role="button"][aria-expanded]')!
    const before = row.outerHTML.replace(/ aria-(expanded|controls)="[^"]*"/g, '')
    const acts = container.querySelectorAll('li button[aria-label]').length
    await click(row)
    const after = row.outerHTML.replace(/ aria-(expanded|controls)="[^"]*"/g, '')
    expect(after).toBe(before)
    // 快捷钮不因展开卸载(它们住在 ui/Reveal 里,只动透明度)。
    expect(container.querySelectorAll('li button[aria-label]').length).toBe(acts)
    expect(container.querySelector('li p')!.textContent).toBe('摘要一句')
  })

  it('读过的是全部或一篇没有时,不给筛选 —— 两档筛出来一样', async () => {
    const { container } = await draw([search('w1', 'q', [{ url: 'https://a.com/x', title: 'A' }])])
    await click(head(container))
    expect(container.querySelector('[role="radiogroup"]')).toBeNull()
  })

  it('来源行第二行是域名 + 摘要;点开是摘录(命中词加粗,不当 HTML 渲染)', async () => {
    const { container } = await draw([
      search('w1', 'q', [
        { url: 'https://a.com/x', title: 'A', snippet: '讲 <strong>WebContentsView</strong> 的内存 <img src=x>' } as never,
      ]),
    ])
    await click(head(container))
    expect(container.querySelector('li')!.textContent).toContain('讲 WebContentsView 的内存')
    await click(container.querySelector('li [role="button"][aria-expanded]')!)
    const marks = [...container.querySelectorAll('li mark')].map((node) => node.textContent)
    expect(marks).toEqual(['WebContentsView'])
    // 摘录里的 `<img>` 是外部文本里的一段标签,不是一张图(li 里那张 img 是站点图标)。
    const excerpt = container.querySelector('li p')!
    expect(excerpt.querySelector('img')).toBeNull()
    expect(excerpt.textContent).toBe('讲 WebContentsView 的内存')
  })

  it('「在内置浏览器打开」走出处引用那条路', async () => {
    const { container } = await draw([search('w1', 'q', [{ url: 'https://a.com/x', title: 'A' }])])
    await click(head(container))
    await click(container.querySelector('li button[aria-label="在内置浏览器打开"]')!)
    expect(openSourceUrl).toHaveBeenCalledWith('https://a.com/x')
  })

  it('复制链接就地反馈:钮换成「已复制」', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { container } = await draw([search('w1', 'q', [{ url: 'https://a.com/x', title: 'A' }])])
    await click(head(container))
    await click(container.querySelector('li button[aria-label="复制链接"]')!)
    expect(writeText).toHaveBeenCalledWith('https://a.com/x')
    expect(container.querySelector('li button[aria-label="已复制"]')).not.toBeNull()
  })

  it('步骤单只摆最近 4 行,更早的收成一句', async () => {
    const calls = [
      ...['q1', 'q2', 'q3', 'q4', 'q5'].map((q, index) =>
        search(`w${index}`, q, [{ url: `https://s${index}.com/x`, title: q }]),
      ),
      { ...search('w9', 'q6', []), status: 'executing' } as ProjectedToolCall,
    ]
    const { container } = await draw(calls)
    expect(container.querySelectorAll('[data-step-status]')).toHaveLength(4)
    expect(container.textContent).toContain('前面还有 2 步')
    expect(container.textContent).toContain('6 步')
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

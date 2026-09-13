import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useStageStore } from '../../../stage/store'
import type { BlockCtx } from '../../blocks/registry'
import type { ProjectedToolCall, SegmentModel } from '../../model/segments'
import { presentResearchEpisode } from '../episode'
import { ResearchSegment } from '../ResearchSegment'
import { MessageSourceFoot, researchFoots } from '../SourceFoot'

/**
 * 四件套第四件:**消息尾来源条**。
 *
 * 钉两件事:哪几段值得挂丸(纯函数),以及点它能不能把那一段唤出来 ——
 * 后者是这一批唯一的跨组件接缝(research/reveal.ts),所以整条链一起测:
 * 丸点下去 → 那一段展开 + 滚进视野。
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
  urls: string[],
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
      metadata: {
        query,
        searches: [
          {
            id: 's1',
            query,
            results: urls.map((url, index) => ({ id: `r${index}`, rank: index + 1, url, title: url })),
          },
        ],
      },
    },
    ...patch,
  } as unknown as ProjectedToolCall
}

const researchSegment = (calls: ProjectedToolCall[]): SegmentModel => ({
  kind: 'research',
  episode: presentResearchEpisode(calls),
})

const textSegment: SegmentModel = { kind: 'rich-text', blocks: [], offsets: [] }

describe('哪几段挂丸', () => {
  it('每一段检索一枚,id 与段 key 同源', () => {
    const foots = researchFoots(
      [textSegment, researchSegment([search('w1', 'q', ['https://a.com/x'])])],
      'a1',
    )
    expect(foots).toEqual([{ id: 'a1:1:research', count: 1, domains: ['a.com'] }])
  })

  it('两段检索两枚丸 —— 合成一枚就答不出「点了滚到哪一段」', () => {
    const foots = researchFoots(
      [
        researchSegment([search('w1', 'q1', ['https://a.com/x'])]),
        textSegment,
        researchSegment([search('w2', 'q2', ['https://b.com/y', 'https://c.com/z'])]),
      ],
      'a1',
    )
    expect(foots.map((foot) => `${foot.id}=${foot.count}`)).toEqual([
      'a1:0:research=1',
      'a1:2:research=2',
    ])
  })

  it('一条来源都没有的段不挂 —— 写着「0 个来源」的丸只会骗人点一次', () => {
    expect(researchFoots([researchSegment([search('w1', 'q', [])])], 'a1')).toEqual([])
  })

  it('还在跑的段不挂:那时数还在变,而丸说的是结论', () => {
    const running = researchSegment([
      search('w1', 'q', ['https://a.com/x'], { status: 'executing' }),
    ])
    expect(researchFoots([running], 'a1')).toEqual([])
  })

  it('没有检索段时组件自己返回 null —— ChatStream 因此对检索一无所知', () => {
    const { container } = render(<MessageSourceFoot segments={[textSegment]} messageId="a1" />)
    expect(container.firstChild).toBeNull()
  })
})

describe('点它把那一段唤出来', () => {
  it('丸 → 那一段展开 + 滚进视野', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    const segments = [
      textSegment,
      researchSegment([search('w1', '查询词', ['https://a.com/x'])]),
    ]

    const { container } = render(
      <>
        <ResearchSegment
          episode={(segments[1] as Extract<SegmentModel, { kind: 'research' }>).episode}
          id="a1:1:research"
          ctx={ctx}
        />
        <MessageSourceFoot segments={segments} messageId="a1" />
      </>,
    )
    await act(async () => undefined)

    // 丸上说的数与清单上看得见的行数是同一个。
    const pill = container.querySelector('[data-testid="research-foot"] button')!
    expect(pill.textContent).toContain('1 个来源')
    expect(container.querySelector('ul')).toBeNull()

    await act(async () => {
      fireEvent.click(pill)
    })

    expect(container.textContent).toContain('搜索 查询词')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.calls[0][0]).toMatchObject({ block: 'center' })
  })
})

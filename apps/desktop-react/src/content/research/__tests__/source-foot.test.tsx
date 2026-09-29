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
 * 钉两件事:哪几段值得挂丸(纯函数),以及点它**就地**展开来源清单 ——
 * 不滚、不去动正文里那一段检索(09-27 用户令:原地看,不跳)。
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
    const segments = [textSegment, researchSegment([search('w1', 'q', ['https://a.com/x'])])]
    const foots = researchFoots(segments, 'a1')
    expect(foots).toMatchObject([{ id: 'a1:1:research', count: 1, domains: ['a.com'] }])
    // 丸点开就地画的清单读的就是这一段自己的 episode(同一个对象,不是一份拷贝)。
    expect(foots[0].episode).toBe((segments[1] as Extract<SegmentModel, { kind: 'research' }>).episode)
  })

  it('两段检索两枚丸 —— 合成一枚就答不出「N 是两段之和吗」', () => {
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
    const { container } = render(<MessageSourceFoot segments={[textSegment]} messageId="a1" ctx={ctx} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('点它就地看', () => {
  it('丸 → 丸下面摊开同一张清单;正文里那一段检索不动,也不滚', async () => {
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
        <MessageSourceFoot segments={segments} messageId="a1" ctx={ctx} />
      </>,
    )
    await act(async () => undefined)

    const foot = container.querySelector('[data-testid="research-foot"]')!
    const pill = foot.querySelector('button')!
    // 丸上说的数与清单上看得见的行数是同一个。
    expect(pill.textContent).toContain('1 个来源')
    expect(pill.getAttribute('aria-expanded')).toBe('false')
    expect(foot.querySelector('ul')).toBeNull()

    await act(async () => {
      fireEvent.click(pill)
    })
    expect(pill.getAttribute('aria-expanded')).toBe('true')
    expect(foot.querySelector('li')!.textContent).toContain('a.com')
    expect(foot.textContent).toContain('查询词')
    // 正文里那一段仍然收着,而且没人滚。
    expect(container.querySelector('[data-research-id="a1:1:research"]')!.hasAttribute('data-open')).toBe(false)
    expect(scrollIntoView).not.toHaveBeenCalled()

    // 再点收起:藏,不卸 —— 再开是同一批节点。
    const list = foot.querySelector('ul')!
    await act(async () => {
      fireEvent.click(pill)
    })
    expect(list.closest('[hidden]')).not.toBeNull()
    await act(async () => {
      fireEvent.click(pill)
    })
    expect(foot.querySelector('ul')).toBe(list)
    expect(list.closest('[hidden]')).toBeNull()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { buildContextCompactContent } from '@shared/engine/context-compact-content'
import { SegmentView } from '../../SegmentView'
import { ThinkingSegment } from '../../ThinkingSegment'
import { CompactSeam } from '../../CompactSeam'
import { ToolCard } from '../../tools/ToolCard'
import { ResearchSegment } from '../../research/ResearchSegment'
import { BlockView } from '../../blocks/BlockView'
import type { BlockCtx } from '../../blocks/registry'
import { blockKey } from '../../assemble/key'
import { markdownToFrame } from '../../assemble/markdown'
import { presentToolCard } from '../../assemble/present'
import { textLatest, textPreview, textToFrame } from '../../assemble/text'
import { presentResearchEpisode } from '../../research/episode'
import { parseCompactMarker } from '../../compact/marker'
import type { ProjectedToolCall, SegmentModel } from '../../model/segments'
import { chatSources } from '../../../data/chat-source'
import { useStageStore } from '../../../stage/store'

/**
 * **DOM 逐节点相同**(正本 §20.5):六型各经 `SegmentView` 渲一次,与直接渲那个既有组件
 * 比一次整棵 `innerHTML`。
 *
 * 「直接渲」那一侧就是 P3 之前 `SegmentView` 的 `switch` 里那一支**原样抄过来**(props
 * 一格一格照旧递)—— 所以这组用例证的正是「适配函数把 props 翻过去之后,屏幕上一个节点
 * 都没多、一个属性都没变」。适配层若插了一层包裹、漏递一格、递错一格(例如思考段递了
 * `live` 而不是 `thinking`),这里当场红。
 *
 * 比之前把 `useId` 的产物按出现序换成占位:两次独立渲染拿到的是同一个全局计数器的两段,
 * 值不同是 React 的事,不是这一单的变化;**出现的位置与次数**仍然逐字比。
 */

// shiki 是异步的,而这里比的是素文本先行那一帧 —— 与 tool-card 测同一条。
vi.mock('../../code/highlight', () => ({
  loadHighlighter: () => Promise.resolve(undefined),
  highlight: () => undefined,
  HIGHLIGHT_THEME: 'vitesse-light',
  resetHighlighterForTest: () => undefined,
}))

const T0 = 1_700_000_000_000
const CTX: BlockCtx = { messageId: 'sv-1', streaming: false, sessionId: 's-sv' }

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  chatSources.resetAll()
})

/** 把 React 生成的 id(19.2 起是 `_r_3_`,更早是 `«r3»` / `:r3:`)按出现序换成 `#id0`、`#id1`… */
function normalizeIds(html: string): string {
  const seen = new Map<string, string>()
  return html.replace(/_r_[0-9a-z]+_|«[^»]+»|:r[0-9a-z]+:/g, (token) => {
    let name = seen.get(token)
    if (!name) {
      name = `#id${seen.size}`
      seen.set(token, name)
    }
    return name
  })
}

async function html(element: ReactElement): Promise<{ html: string; roots: number }> {
  const { container, unmount } = render(element)
  // 刷掉挂载后那一拍的 effect(几何上报、懒加载的首帧),两侧同样刷,比的是落定后的 DOM。
  await act(async () => undefined)
  const out = { html: normalizeIds(container.innerHTML), roots: container.childNodes.length }
  unmount()
  return out
}

async function expectSameDom(segment: SegmentModel, key: string, direct: ReactElement): Promise<void> {
  const viaView = await html(<SegmentView segment={segment} segmentKey={key} ctx={CTX} />)
  const viaDirect = await html(direct)
  expect(viaView.roots).toBe(viaDirect.roots)
  expect(viaView.html).toBe(viaDirect.html)
}

function toolCall(patch: Record<string, unknown> = {}): ProjectedToolCall {
  return {
    id: 'c1',
    toolId: 'read',
    toolName: 'read',
    arguments: { path: 'src/a.ts' },
    status: 'completed',
    timestamp: T0,
    durationMs: 1200,
    ...patch,
  } as unknown as ProjectedToolCall
}

function searchCall(): ProjectedToolCall {
  return {
    id: 'w1',
    toolId: 'web_search',
    toolName: 'web_search',
    arguments: { query: 'react 19' },
    status: 'completed',
    timestamp: T0,
    result: {
      title: 'x',
      output: '结果正文',
      metadata: {
        query: 'react 19',
        searches: [
          {
            id: 's1',
            query: 'react 19',
            results: [
              { id: 'r0', rank: 1, url: 'https://react.dev/a', title: 'A' },
              { id: 'r1', rank: 2, url: 'https://web.dev/b', title: 'B' },
            ],
          },
        ],
      },
    },
  } as unknown as ProjectedToolCall
}

describe('SegmentView 与直接渲组件逐节点相同', () => {
  it('thinking —— 递的是 `thinking` 不是 `live`', async () => {
    // live 为真而这块思考已不是最后一件:两格不同值,递错一格就会在 data-live 上露出来。
    const { blocks, tail } = textToFrame('sv-think', '第一行想法\n第二行想法\n还在写', true)
    const segment: SegmentModel = {
      kind: 'thinking',
      blocks,
      tail,
      live: true,
      thinking: false,
      preview: textPreview(blocks, tail),
      latest: textLatest(blocks, tail),
    }
    await expectSameDom(segment, 'sv-1:0:thinking', (
      <ThinkingSegment
        blocks={segment.blocks}
        tail={segment.tail}
        thinking={segment.thinking}
        preview={segment.preview}
        latest={segment.latest}
      />
    ))
  })

  it('rich-text —— 一串块、不加包裹层,块 key 挂在段 key 下', async () => {
    const { blocks, offsets, ids } = markdownToFrame('sv-rt', '# 标题\n\n一段正文。\n\n- 甲\n- 乙\n\n```ts\nconst a = 1\n```', false)
    const segment: SegmentModel = { kind: 'rich-text', blocks, offsets, ids }
    const key = 'sv-1:1:rich-text'
    await expectSameDom(segment, key, (
      <>
        {blocks.map((block, index) => (
          <BlockView
            key={blockKey(key, index, block, offsets[index], ids?.[index])}
            block={block}
            ctx={CTX}
          />
        ))}
      </>
    ))
  })

  it('tool-group —— 一步的卡与多步的卡', async () => {
    for (const calls of [[toolCall()], [toolCall(), toolCall({ id: 'c2', arguments: { path: 'src/b.ts' } })]]) {
      const segment: SegmentModel = { kind: 'tool-group', card: presentToolCard(calls) }
      await expectSameDom(segment, 'sv-1:2:tool-group', <ToolCard card={segment.card} ctx={CTX} />)
    }
  })

  it('research —— 段 key 就是检索段的身份', async () => {
    const segment: SegmentModel = { kind: 'research', episode: presentResearchEpisode([searchCall()]) }
    const key = 'sv-1:3:research'
    await expectSameDom(segment, key, <ResearchSegment episode={segment.episode} id={key} ctx={CTX} />)
  })

  it('compact —— 进行中与完成两态', async () => {
    for (const input of [
      { status: 'compacting', compactedMessageCount: 0 },
      { status: 'completed', compactedMessageCount: 12, summary: '前面聊了**三件事**。' },
    ] as Parameters<typeof buildContextCompactContent>[0][]) {
      const marker = parseCompactMarker({ role: 'system', content: buildContextCompactContent(input) })
      if (!marker) throw new Error('这份夹具不是压缩标记 —— 先修夹具')
      const segment: SegmentModel = { kind: 'compact', marker }
      await expectSameDom(segment, 'sv-1:0:compact', <CompactSeam marker={marker} ctx={CTX} />)
    }
  })

  it('image —— 今天不画:一个节点都没有(与 P3 之前那一格逐字同义)', async () => {
    const segment: SegmentModel = { kind: 'image', blob: { hash: 'h', bytes: 1, mime: 'image/png' } }
    const viaView = await html(<SegmentView segment={segment} segmentKey="sv-1:4:image" ctx={CTX} />)
    expect(viaView).toEqual({ html: '', roots: 0 })
  })
})

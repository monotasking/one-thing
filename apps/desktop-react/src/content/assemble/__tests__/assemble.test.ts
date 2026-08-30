import { describe, expect, it } from 'vitest'
import type { ProjectedMessage } from '../../../data/chat-fold'
import type { BlockModel } from '../../model/blocks'
import { assembleMessage, blockKey, segmentKey } from '..'
import { plainTextToBlocks } from '../markdown'
import { defaultToolPresenter } from '../../tools/presenter'

/**
 * 装配管线的单测 —— **纯函数,jsdom 都不用起**(§2 纪律 / §8)。
 *
 * 这一层验的是「一条消息算成哪几段」,不验它画出来长什么样;屏幕那一端由
 * ChatStream 那批组件测钉着(那 11 条一个断言都没动,它们正是「行为零变化」的证词)。
 */

const T0 = 1_700_000_000_000

function message(patch: Partial<ProjectedMessage> = {}): ProjectedMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: '',
    timestamp: T0,
    ...patch,
  } as ProjectedMessage
}

function toolCall(patch: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    toolId: 'read',
    toolName: 'read',
    arguments: { path: 'a.txt' },
    status: 'completed',
    timestamp: T0,
    ...patch,
  }
}

describe('段序列:一条消息算成哪几段', () => {
  it('纯文本正文 = 一个 rich-text 段,里面一个段落块、一个 text 行内节点', () => {
    const segments = assembleMessage(message({ content: '第一行\n第二行' }))
    expect(segments).toEqual([
      {
        kind: 'rich-text',
        blocks: [{ kind: 'paragraph', inline: [{ type: 'text', text: '第一行\n第二行' }] }],
      },
    ])
  })

  it('换行留在字符串里 —— P0 不解析 markdown,pre-wrap 那条行为原样成立', () => {
    const [segment] = assembleMessage(message({ content: 'a\n\nb' }))
    expect(segment).toMatchObject({ kind: 'rich-text' })
    expect(plainTextToBlocks('a\n\nb')).toHaveLength(1)
  })

  it('空正文不产段(而不是产一个空段落)', () => {
    expect(assembleMessage(message({ content: '' }))).toEqual([])
  })

  it('顶部推理 → 思考段,排在正文前面(与从前屏幕上的顺序逐字相同)', () => {
    const segments = assembleMessage(message({ reasoning: '想一下', content: '好的' }))
    expect(segments.map((s) => s.kind)).toEqual(['thinking', 'rich-text'])
    expect(segments[0]).toEqual({ kind: 'thinking', text: '想一下', live: false })
  })

  it('isStreaming 是思考段 live 的产地(今天没有渲染器读它,但事实得对)', () => {
    const [segment] = assembleMessage(message({ reasoning: '想一下', isStreaming: true }))
    expect(segment).toMatchObject({ kind: 'thinking', live: true })
  })

  it('工具调用一个一张卡,排在正文之后(P0 不归组、不按锚点归位)', () => {
    const segments = assembleMessage(
      message({
        content: '读一下',
        toolCalls: [toolCall(), toolCall({ id: 'c2', status: 'failed' })] as never,
      }),
    )
    expect(segments.map((s) => s.kind)).toEqual(['rich-text', 'tool', 'tool'])
    expect(segments[1]).toEqual({
      kind: 'tool',
      row: { callId: 'c1', icon: 'FolderTree', name: 'read', status: 'completed' },
    })
    expect(segments[2]).toMatchObject({ row: { callId: 'c2', status: 'failed' } })
  })

  it('拿不到 toolName 就用 toolId —— 那是事实,编一个名字是猜', () => {
    const segments = assembleMessage(
      message({ toolCalls: [toolCall({ toolName: '' })] as never }),
    )
    expect(segments[0]).toMatchObject({ row: { name: 'read' } })
  })

  it('认不出的状态原样带过去(渲染层再决定显示英文枚举)', () => {
    const segments = assembleMessage(
      message({ toolCalls: [toolCall({ status: 'teleported' })] as never }),
    )
    expect(segments[0]).toMatchObject({ row: { status: 'teleported' } })
  })
})

describe('按消息引用 memo', () => {
  it('同一个引用两次装配 = 同一个数组(不是内容相等,是同一个)', () => {
    const m = message({ content: '你好' })
    expect(assembleMessage(m)).toBe(assembleMessage(m))
  })

  it('换了引用就重算 —— 折叠器变则换引用,所以这条判据是硬的', () => {
    const first = assembleMessage(message({ content: '你好' }))
    const second = assembleMessage(message({ content: '你好' }))
    expect(second).not.toBe(first)
    expect(second).toEqual(first)
  })
})

describe('key 稳定性', () => {
  it('同一份输入两次算出逐字相同的 key', () => {
    const a = assembleMessage(message({ content: '你好' }))
    const b = assembleMessage(message({ content: '你好' }))
    expect(segmentKey('a1', 0, b[0])).toBe(segmentKey('a1', 0, a[0]))
  })

  it('末尾追加一张工具卡,前面那些段的 key 一个都不变(否则流式期间整棵重挂)', () => {
    const before = assembleMessage(message({ reasoning: '想', content: '好' }))
    const after = assembleMessage(
      message({ reasoning: '想', content: '好', toolCalls: [toolCall()] as never }),
    )
    const keysOf = (segments: typeof before) =>
      segments.map((segment, index) => segmentKey('a1', index, segment))
    expect(keysOf(after).slice(0, 2)).toEqual(keysOf(before))
  })

  it('同一位置换了段的种类就换 key —— 那本来就该是两个组件', () => {
    const [thinking] = assembleMessage(message({ reasoning: '想' }))
    const [rich] = assembleMessage(message({ content: '好' }))
    expect(segmentKey('a1', 0, rich)).not.toBe(segmentKey('a1', 0, thinking))
  })

  it('块 key 挂在段 key 下面派生 —— 段换了,块自然全换', () => {
    const key = segmentKey('a1', 0, { kind: 'rich-text', blocks: [] })
    const block: BlockModel = { kind: 'paragraph', inline: [] }
    expect(blockKey(key, 0, block)).toBe(`${key}/0:paragraph`)
    expect(blockKey('other', 0, block)).not.toBe(blockKey(key, 0, block))
  })
})

describe('兜底 presenter 的详情:参数与结果 JSON 原样', () => {
  it('落 source-fallback,reason 是机器口径的词', () => {
    const detail = defaultToolPresenter.detail(
      toolCall({ result: { text: '读到了' } }) as never,
    )
    expect(detail).toHaveLength(1)
    expect(detail[0]).toMatchObject({ kind: 'source-fallback', reason: 'tool-default' })
    expect(detail[0]).toHaveProperty('source', expect.stringContaining('读到了'))
  })

  it('结果里有环也不许它自己抛 —— 这已经是最后一层了', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const detail = defaultToolPresenter.detail(toolCall({ result: circular }) as never)
    expect(detail[0]).toMatchObject({ kind: 'source-fallback' })
  })
})

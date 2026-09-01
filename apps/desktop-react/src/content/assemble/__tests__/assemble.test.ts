import { describe, expect, it } from 'vitest'
import type { ProjectedMessage } from '../../../data/chat-fold'
import type { BlockModel } from '../../model/blocks'
import { assembleMessage, blockKey, segmentKey } from '..'
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
        // 段落内的**软换行**照实留在 text 节点里(markdown 的段落不因单个换行结束),
        // 所以 P0 那条「pre-wrap 保留换行」的行为在真解析器下逐字成立。
        blocks: [{ kind: 'paragraph', inline: [{ type: 'text', text: '第一行\n第二行' }] }],
        offsets: [0],
      },
    ])
  })

  it('空行是段落边界 —— P1 起正文过 markdown,一段变两段', () => {
    // P0 时这里是「一个段落块」:那是纯文本时代的事实。P1 的可感知变化就在这一格。
    const [segment] = assembleMessage(message({ content: 'a\n\nb' }))
    expect(segment).toMatchObject({ kind: 'rich-text' })
    expect(segment.kind === 'rich-text' && segment.blocks).toHaveLength(2)
    expect(segment.kind === 'rich-text' && segment.offsets).toEqual([0, 3])
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

  it('单发工具 = 一组一次(画出来是一张卡,卡里带着那次调用,抽屉惰性算详情)', () => {
    // P0 时这条断言的是「两次调用 = 两张卡,都排在正文后面」。P2 起归组把相邻的
    // 两次折成一组(可感知变化,B2 定稿),所以这里只留单发那一格。
    // 09-01 再改一次:**单发也是一组** —— 段种不再随条数改判(改判 = React 整段
    // 重挂,真机 t=6614),「画成卡」挪去 `ToolGroup` 的 total===1 那一支。
    const segments = assembleMessage(
      message({ content: '读一下', toolCalls: [toolCall()] as never }),
    )
    expect(segments.map((s) => s.kind)).toEqual(['rich-text', 'tool-group'])
    expect(segments[1]).toMatchObject({
      kind: 'tool-group',
      group: {
        total: 1,
        entries: [
          {
            children: [
              {
                row: { callId: 'c1', icon: 'FileText', name: 'a.txt', status: 'completed' },
                call: { id: 'c1' },
              },
            ],
          },
        ],
      },
    })
  })

  it('相邻两次调用折成一组(B2)—— 归组是 P2 的可感知变化', () => {
    const segments = assembleMessage(
      message({
        content: '读一下',
        toolCalls: [toolCall(), toolCall({ id: 'c2', status: 'failed' })] as never,
      }),
    )
    expect(segments.map((s) => s.kind)).toEqual(['rich-text', 'tool-group'])
    expect(segments[1]).toMatchObject({
      group: { total: 2, failed: 1, names: ['read'] },
    })
  })

  it('拿不到 toolName 就用 toolId —— 那是事实,编一个名字是猜', () => {
    // 工具名认不出来时 read 的 presenter 也认不出它,于是走兜底:名字是 toolId。
    const segments = assembleMessage(
      message({ toolCalls: [toolCall({ toolName: '', toolId: 'mystery' })] as never }),
    )
    expect(segments[0]).toMatchObject({
      group: { entries: [{ children: [{ row: { name: 'mystery' } }] }] },
    })
  })

  it('认不出的状态原样带过去(渲染层再决定显示英文枚举)', () => {
    const segments = assembleMessage(
      message({ toolCalls: [toolCall({ status: 'teleported' })] as never }),
    )
    expect(segments[0]).toMatchObject({
      group: { entries: [{ children: [{ row: { status: 'teleported' } }] }] },
    })
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
    const key = segmentKey('a1', 0, { kind: 'rich-text', blocks: [], offsets: [] })
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

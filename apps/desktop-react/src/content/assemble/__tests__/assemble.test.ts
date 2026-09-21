import { describe, expect, it } from 'vitest'
import type { ProjectedMessage } from '../../../data/chat-fold'
import type { BlockModel } from '../../model/blocks'
import { buildContextCompactContent } from '@onething/core/engine'
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
        // R4a:块流的身份号随段一起出厂(产地派生 `${源偏移}:${kind}`)。
        ids: ['0:paragraph'],
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
    // 09-14 起思考段是**一串块 + 活动尾**(正本 `docs/thinking-stream-2026-09.md` §3)。
    // 不流的那一份全冻:尾是空的,原文整份在块里,预览是开头那 240 字。
    // 09-20 G 线 P1 多一格 `latest`(末尾那 240 字):流式期间收起态那一行显示的是它。
    // 这一段整份短于 240 字,所以首尾两截恰好重合 —— 那正是「短于一行」那一档。
    expect(segments[0]).toEqual({
      kind: 'thinking',
      blocks: [{ id: 'a1#0#0', text: '想一下' }],
      tail: '',
      live: false,
      thinking: false,
      preview: '想一下',
      latest: '想一下',
    })
  })

  it('isStreaming 是思考段 live 的产地(块冻结读它)', () => {
    const [segment] = assembleMessage(message({ reasoning: '想一下', isStreaming: true }))
    expect(segment).toMatchObject({ kind: 'thinking', live: true })
  })

  /**
   * ── `thinking`:**这一块**思考还在不在进行(P1b 裁定 D,2026-09-21)──────────
   *
   * 用户原话:「think 区域的流式动画效果在这块思考结束后应该停止」。判据是
   * 「它是不是序列上的最后一件」—— 为什么不是账本上的 `part.ended`,判词写在
   * `assemble/index.ts` 那段循环上面(投影的 `materializeContentParts` 把 `ended`
   * 丢掉了,而顶部推理压根没有 part 身份)。
   */
  it('思考是这条消息的最后一件、而且消息还在流 → thinking', () => {
    const [segment] = assembleMessage(message({ reasoning: '正在想', isStreaming: true }))
    expect(segment).toMatchObject({ kind: 'thinking', live: true, thinking: true })
  })

  it('思考 → 正文(消息**仍然在流**):那块思考已经不在进行', () => {
    const segments = assembleMessage(
      message({ reasoning: '想完了', content: '开始写', isStreaming: true }),
    )
    expect(segments.map((s) => s.kind)).toEqual(['thinking', 'rich-text'])
    // `live` 照旧为真(这条消息还在流,块冻结要它);`thinking` 已经是假。
    expect(segments[0]).toMatchObject({ kind: 'thinking', live: true, thinking: false })
  })

  it('思考 → 工具 → 思考:只有最后那一段在进行', () => {
    const segments = assembleMessage(
      message({
        reasoning: '先想一下',
        contentParts: [
          { type: 'tool-call', toolCalls: [toolCall()], turnIndex: 0 },
          { type: 'reasoning', content: '再想一下', turnIndex: 0 },
        ] as never,
        toolCalls: [toolCall()] as never,
        isStreaming: true,
      }),
    )
    const thinkings = segments.filter((s) => s.kind === 'thinking')
    expect(thinkings).toHaveLength(2)
    expect(thinkings[0]).toMatchObject({ thinking: false })
    expect(thinkings[1]).toMatchObject({ thinking: true })
  })

  it('消息收尾之后一块都不在进行(哪怕思考是最后一件)', () => {
    const [segment] = assembleMessage(message({ reasoning: '想完了' }))
    expect(segment).toMatchObject({ kind: 'thinking', live: false, thinking: false })
  })

  it('单发工具 = 一组一次(画出来是一张卡,卡里带着那次调用,抽屉惰性算详情)', () => {
    // P0 时这条断言的是「两次调用 = 两张卡,都排在正文后面」。P2 起归组把相邻的
    // 两次折成一组(可感知变化,B2 定稿),所以这里只留单发那一格。
    // 09-01 再改一次:**单发也是一组** —— 段种不再随条数改判(改判 = React 整段
    // 重挂,真机 t=6614),「画成卡」挪去 `ToolCard`(C2-a 起单发与连发是同一张卡,一步的卡没有头行)。
    const segments = assembleMessage(
      message({ content: '读一下', toolCalls: [toolCall()] as never }),
    )
    expect(segments.map((s) => s.kind)).toEqual(['rich-text', 'tool-group'])
    expect(segments[1]).toMatchObject({
      kind: 'tool-group',
      card: {
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
      // `names`(计数句里那串工具名)随计数句一起退役 —— 「用到了哪几种」
      // 现在由头行那句摘要说,同名连发在那里读作「read ×2」。
      card: { total: 2, failed: 1, head: { text: 'read ×2' } },
    })
  })

  it('拿不到 toolName 就用 toolId —— 那是事实,编一个名字是猜', () => {
    // 工具名认不出来时 read 的 presenter 也认不出它,于是走兜底:名字是 toolId。
    const segments = assembleMessage(
      message({ toolCalls: [toolCall({ toolName: '', toolId: 'mystery' })] as never }),
    )
    expect(segments[0]).toMatchObject({
      card: { entries: [{ children: [{ row: { name: 'mystery' } }] }] },
    })
  })

  it('认不出的状态原样带过去(渲染层再决定显示英文枚举)', () => {
    const segments = assembleMessage(
      message({ toolCalls: [toolCall({ status: 'teleported' })] as never }),
    )
    expect(segments[0]).toMatchObject({
      card: { entries: [{ children: [{ row: { status: 'teleported' } }] }] },
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

/**
 * **现状记录:思考段的 `live` 取的是「这条消息还在跑」,不是「这一段推理还在长」**
 * (R3 浸泡首单,09-01 用户真机截图:「think 还在,但是下面有一个工具调用」)。
 *
 * `ThinkingSegment` 的行为是「流式中自动展开、收尾自动折」,而它的开关就是这一格。
 * 于是一条 88.7s、带多轮工具的消息里,**第一段早已写完的推理照样整轮摊着** ——
 * 用户看到的正是这个。
 *
 * 呈现本身没问题(真机取证:两段推理全程住在思考件里,新路与 `--r2=off` 旧路
 * 逐格相同;斜体灰字是六轮比稿 S2 的定稿形,它本来就没有檐)。**该不该在这一刻
 * 折回一行是可感知的行为裁定**,与挂着的「思考块 settle 自动折叠」是同一族,
 * 按「行为裁定须先问」留给拍板。
 *
 * 这条用例把今天的答案钉住:改法一落地它就会红 —— 那正是要的,拍板得是显式的。
 */
describe('思考段的 live 粒度(现状记录,等拍板)', () => {
  it('后面已经接了正文与工具的那段推理,live 仍是真', () => {
    const segments = assembleMessage(
      message({
        isStreaming: true,
        reasoning: '第一段推理,早就写完了。',
        content: '正文。',
        toolCalls: [toolCall()],
      } as Partial<ProjectedMessage>),
    )
    const thinking = segments.filter((s) => s.kind === 'thinking')
    expect(thinking).toHaveLength(1)
    expect(thinking[0].kind === 'thinking' && thinking[0].live).toBe(true)
    // 它后面确实还有别的段 —— 也就是说「这一段推理」按事实早就结束了。
    expect(segments.findIndex((s) => s.kind === 'thinking')).toBe(0)
    expect(segments.length).toBeGreaterThan(1)
  })
})

/**
 * ⓪ **按内容自述分类**(U2):一条 system 消息说自己是压缩标记,就产一个 compact 段。
 *
 * 判据整件不在这个文件里 —— 它住 `content/compact/marker.ts`,这里验的是**接得对不对**:
 * 认出来的走折痕(而不是把一坨 JSON 交给 markdown 那一步,09-08 事故屏幕上的那一坨),
 * 认不出来的照常走 rich-text(降级是「照实把正文摆出来」,不是吞掉这条消息)。
 */
describe('压缩标记:system 消息按内容自述分类', () => {
  const compactContent = buildContextCompactContent({
    status: 'completed',
    compactedMessageCount: 42,
    summary: '## 已完成\n\n- 修了那条夹法',
    retainedContextSize: 96_000,
    contextSizeBefore: 701_297,
  })

  it('压缩标记 → 一个 compact 段(正文里那坨 JSON 一个字都不上屏)', () => {
    const segments = assembleMessage(
      message({ id: 'sys-1', role: 'system', content: compactContent }),
    )
    expect(segments).toHaveLength(1)
    expect(segments[0].kind).toBe('compact')
    expect(segments[0].kind === 'compact' && segments[0].marker).toMatchObject({
      status: 'completed',
      compactedMessageCount: 42,
      contextSizeBefore: 701_297,
      retainedContextSize: 96_000,
    })
    // 正文那串 JSON 没有变成任何一个 rich-text 段。
    expect(segments.some((s) => s.kind === 'rich-text')).toBe(false)
  })

  it('别的 system 消息照常走 rich-text —— 分类不是「system 一律不画字」', () => {
    const segments = assembleMessage(
      message({ id: 'sys-2', role: 'system', content: '会话已从 deepseek 切到 claude。' }),
    )
    expect(segments.map((s) => s.kind)).toEqual(['rich-text'])
    expect(segments[0].kind === 'rich-text' && segments[0].blocks[0]).toMatchObject({
      kind: 'paragraph',
    })
  })
})

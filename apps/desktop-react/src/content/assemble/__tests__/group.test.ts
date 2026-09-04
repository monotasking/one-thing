import { describe, expect, it } from 'vitest'
import type { AnchoredNode } from '../anchor'
import type { ProjectedToolCall } from '../../model/segments'
import { groupNodes } from '../group'
import { presentToolCard } from '../present'

/**
 * ② **归组**与组内**同名聚合**的单测(§2 ②/③)。
 *
 * 两件事分两层测,因为它们回答两个问题:归组回答「哪几次是一组」(只看相邻),
 * 聚合回答「组里这几次怎么摆」(只看同名连续)。混在一起测的话,一条断言红了
 * 说不出是哪一层错。
 */

const T0 = 1_700_000_000_000

function call(id: string, toolName = 'read', patch: Record<string, unknown> = {}): ProjectedToolCall {
  return {
    id,
    toolId: toolName,
    toolName,
    arguments: {},
    status: 'completed',
    timestamp: T0,
    ...patch,
  } as unknown as ProjectedToolCall
}

const tool = (id: string, name?: string): AnchoredNode =>
  ({ node: 'tool', call: call(id, name) }) as AnchoredNode
const text = (value: string): AnchoredNode => ({ node: 'text', text: value })

describe('归组判据:相邻成组,别的节点打断', () => {
  it('相邻的两次以上折成一组', () => {
    const out = groupNodes([tool('c1'), tool('c2'), tool('c3')])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ node: 'tool-group' })
  })

  /*
   * 09-01 P2 改判:**一次调用也是一组**。
   *
   * 「单发不说计数句、直接把那件事摆出来」这条纪律一个字没变 —— 它挪去了呈现层
   * (`ToolGroup` 的 `total === 1` 画的就是从前那张卡,逐像素相同)。留在归组这
   * 一层的话,第二次调用到达的那一帧同一个位置换了段种,段 key 带 kind,React
   * 把整段卸载重挂:真机 t=6614 单卡整行消失换成组卡(DOM 不是同一个节点)。
   */
  it('单发也是一组 —— 画成卡是呈现的事,不该决定「这是不是同一件东西」', () => {
    expect(groupNodes([tool('c1')])).toEqual([
      { node: 'tool-group', calls: [expect.objectContaining({ id: 'c1' })] },
    ])
  })

  it('正文一插进来就是两组(人读到的确实是两段)', () => {
    const out = groupNodes([tool('c1'), tool('c2'), text('说一句'), tool('c3'), tool('c4')])
    expect(out.map((node) => node.node)).toEqual(['tool-group', 'text', 'tool-group'])
  })

  it('被打断之后各剩一次 = 两组各一次(画出来是两张单卡)', () => {
    const out = groupNodes([tool('c1'), text('说一句'), tool('c2')])
    expect(out.map((node) => node.node)).toEqual(['tool-group', 'text', 'tool-group'])
  })

  it('思考段同样是打断 —— 判据是「中间有别的节点」,不是「中间有正文」', () => {
    const reasoning: AnchoredNode = { node: 'reasoning', text: '想', placement: 'inline' }
    const out = groupNodes([tool('c1'), reasoning, tool('c2')])
    expect(out.map((node) => node.node)).toEqual(['tool-group', 'reasoning', 'tool-group'])
  })

  it('非工具节点原样穿过去,顺序一个都不动', () => {
    const out = groupNodes([text('一'), text('二')])
    expect(out).toEqual([text('一'), text('二')])
  })
})

describe('检索段:web 族连着来的折成 research(P4)', () => {
  const web = (id: string, name: 'web_search' | 'web_open' = 'web_search'): AnchoredNode =>
    ({ node: 'tool', call: call(id, name) }) as AnchoredNode

  it('单发也成段 —— 一次搜索照样带回一份来源清单', () => {
    const out = groupNodes([web('w1')])
    expect(out).toEqual([{ node: 'research', calls: [expect.objectContaining({ id: 'w1' })] }])
  })

  it('族内混序算一段:search → open → open → search 是一次检索,不是四件事', () => {
    const out = groupNodes([
      web('w1', 'web_search'),
      web('w2', 'web_open'),
      web('w3', 'web_open'),
      web('w4', 'web_search'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ node: 'research' })
    expect((out[0] as { calls: { id: string }[] }).calls.map((c) => c.id)).toEqual([
      'w1',
      'w2',
      'w3',
      'w4',
    ])
  })

  it('非 web 工具打断 —— 中间读了个文件,那是两段检索夹着一次读', () => {
    const out = groupNodes([web('w1'), tool('c1', 'read'), web('w2')])
    expect(out.map((node) => node.node)).toEqual(['research', 'tool-group', 'research'])
  })

  it('正文打断照旧(与普通组同一条判据:中间有别的节点)', () => {
    const out = groupNodes([web('w1'), web('w2'), text('说一句'), web('w3')])
    expect(out.map((node) => node.node)).toEqual(['research', 'text', 'research'])
  })

  it('两族相邻不混段:read、read、search 是一个 tool-group + 一段检索', () => {
    const out = groupNodes([tool('c1', 'read'), tool('c2', 'read'), web('w1')])
    expect(out.map((node) => node.node)).toEqual(['tool-group', 'research'])
  })

  it('检索之后剩一次普通调用 = 一组一次(画出来是单卡),不并进检索段', () => {
    const out = groupNodes([web('w1'), tool('c1', 'read')])
    expect(out.map((node) => node.node)).toEqual(['research', 'tool-group'])
  })
})

describe('卡内同名连续聚合:数据层折,渲染层只画', () => {
  it('同名连着三次 = 一格,count 3、children 逐条', () => {
    const card = presentToolCard([call('c1'), call('c2'), call('c3')])
    expect(card.entries).toHaveLength(1)
    expect(card.entries[0]).toMatchObject({ tool: 'read', count: 3 })
    expect(card.entries[0].children.map((child) => child.call.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('不相邻的同名不聚合 —— 顺序是这一卡唯一的结构', () => {
    const card = presentToolCard([call('c1'), call('c2', 'bash'), call('c3')])
    expect(card.entries.map((entry) => `${entry.tool}×${entry.count}`)).toEqual([
      'read×1',
      'bash×1',
      'read×1',
    ])
  })

  /*
   * C2-a 拍点 ⑨:**时间序,不重排**。`steps` 与 `entries` 指向同一批对象,
   * 前者逐条、后者按同名连发折过 —— 两条路读出来的先后必须逐条相同。
   */
  it('steps 是时间序,与 entries 摊平之后逐条相同(失败不置顶)', () => {
    const card = presentToolCard([
      call('c1'),
      call('c2', 'read', { status: 'failed', error: '炸了' }),
      call('c3'),
    ])
    expect(card.steps.map((step) => step.call.id)).toEqual(['c1', 'c2', 'c3'])
    expect(card.entries.flatMap((entry) => entry.children).map((step) => step.call.id)).toEqual([
      'c1',
      'c2',
      'c3',
    ])
    // 同一批**对象**,不是两份拷贝 —— 分叉了就会出现「展开与收起说的不是一回事」。
    expect(card.entries[0].children[0]).toBe(card.steps[0])
  })

  it('卡上那两个数:总次数、失败数', () => {
    const card = presentToolCard([
      call('c1'),
      call('c2', 'bash', { status: 'failed', error: '炸了' }),
      call('c3', 'read'),
    ])
    expect(card.total).toBe(3)
    expect(card.failed).toBe(1)
  })

  it('聚合格自己也记失败数(那点红长在「read ×3」那一行上)', () => {
    const card = presentToolCard([
      call('c1'),
      call('c2', 'read', { status: 'failed', error: '炸了' }),
    ])
    expect(card.entries[0]).toMatchObject({ count: 2, failed: 1 })
  })

  it('头行的总耗时是各次之和;一次都算不出就缺席,不写 0', () => {
    expect(
      presentToolCard([
        call('c1', 'read', { durationMs: 120 }),
        call('c2', 'read', { durationMs: 30 }),
      ]).head?.durationMs,
    ).toBe(150)
    expect(presentToolCard([call('c1'), call('c2')]).head?.durationMs).toBeUndefined()
  })

  it('cancelled 也计一笔失败账 —— 从人的角度「这一步没做成」是同一件事', () => {
    expect(presentToolCard([call('c1', 'read', { status: 'cancelled' })]).failed).toBe(1)
  })

  /*
   * §6.1:一步的卡里只有那一行 —— 一个人做了一件事,上面再压一句概括它的话
   * 只是把那件事推远。多步才有头行。
   */
  it('一步的卡没有头行,多步才有', () => {
    expect(presentToolCard([call('c1')]).head).toBeUndefined()
    // 这批夹具没有参数,所以 presenter 说不出行名,行名 = 工具名 —— 摘要句
    // 于是只说工具名一次(`entryText` 那条「名与工具名相同就不说两遍」)。
    expect(presentToolCard([call('c1'), call('c2', 'bash')]).head).toMatchObject({
      text: 'read · bash',
      failed: 0,
      live: false,
    })
  })

  it('头行的 live 是「还有步没收场」', () => {
    const card = presentToolCard([call('c1'), call('c2', 'bash', { status: 'executing' })])
    expect(card.head?.live).toBe(true)
  })
})

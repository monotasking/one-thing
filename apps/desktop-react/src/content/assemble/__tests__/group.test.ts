import { describe, expect, it } from 'vitest'
import type { AnchoredNode } from '../anchor'
import type { ProjectedToolCall } from '../../model/segments'
import { groupNodes } from '../group'
import { presentToolGroup } from '../present'

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

  it('单发不成组 —— 「执行了 1 步」比直接摆出那件事更远', () => {
    expect(groupNodes([tool('c1')])).toEqual([{ node: 'tool', call: expect.objectContaining({ id: 'c1' }) }])
  })

  it('正文一插进来就是两组(人读到的确实是两段)', () => {
    const out = groupNodes([tool('c1'), tool('c2'), text('说一句'), tool('c3'), tool('c4')])
    expect(out.map((node) => node.node)).toEqual(['tool-group', 'text', 'tool-group'])
  })

  it('被打断之后各剩一次 = 两张单卡,不是两个一步的组', () => {
    const out = groupNodes([tool('c1'), text('说一句'), tool('c2')])
    expect(out.map((node) => node.node)).toEqual(['tool', 'text', 'tool'])
  })

  it('思考段同样是打断 —— 判据是「中间有别的节点」,不是「中间有正文」', () => {
    const reasoning: AnchoredNode = { node: 'reasoning', text: '想', placement: 'inline' }
    const out = groupNodes([tool('c1'), reasoning, tool('c2')])
    expect(out.map((node) => node.node)).toEqual(['tool', 'reasoning', 'tool'])
  })

  it('非工具节点原样穿过去,顺序一个都不动', () => {
    const out = groupNodes([text('一'), text('二')])
    expect(out).toEqual([text('一'), text('二')])
  })
})

describe('组内同名连续聚合:数据层折,渲染层只画', () => {
  it('同名连着三次 = 一格,count 3、children 逐条', () => {
    const group = presentToolGroup([call('c1'), call('c2'), call('c3')])
    expect(group.entries).toHaveLength(1)
    expect(group.entries[0]).toMatchObject({ tool: 'read', count: 3 })
    expect(group.entries[0].children.map((child) => child.call.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('不相邻的同名不聚合 —— 顺序是这一组唯一的结构', () => {
    const group = presentToolGroup([call('c1'), call('c2', 'bash'), call('c3')])
    expect(group.entries.map((entry) => `${entry.tool}×${entry.count}`)).toEqual([
      'read×1',
      'bash×1',
      'read×1',
    ])
  })

  it('计数句要的三个数:总次数、去重的名字序、失败数', () => {
    const group = presentToolGroup([
      call('c1'),
      call('c2', 'bash', { status: 'failed', error: '炸了' }),
      call('c3', 'read'),
    ])
    expect(group.total).toBe(3)
    expect(group.names).toEqual(['read', 'bash'])
    expect(group.failed).toBe(1)
  })

  it('聚合格自己也记失败数(那点红长在「read ×3」那一行上)', () => {
    const group = presentToolGroup([
      call('c1'),
      call('c2', 'read', { status: 'failed', error: '炸了' }),
    ])
    expect(group.entries[0]).toMatchObject({ count: 2, failed: 1 })
  })

  it('总耗时是各次之和;一次都算不出就缺席,不写 0', () => {
    expect(presentToolGroup([call('c1', 'read', { durationMs: 120 }), call('c2', 'read', { durationMs: 30 })]).durationMs).toBe(150)
    expect(presentToolGroup([call('c1')]).durationMs).toBeUndefined()
  })

  it('cancelled 也计一笔失败账 —— 从人的角度「这一步没做成」是同一件事', () => {
    expect(presentToolGroup([call('c1', 'read', { status: 'cancelled' })]).failed).toBe(1)
  })
})

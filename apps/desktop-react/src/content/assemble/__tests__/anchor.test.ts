import { describe, expect, it } from 'vitest'
import type { ProjectedMessage } from '../../../data/chat-fold'
import { anchorMessage } from '../anchor'
import { assembleMessage } from '..'

/**
 * ① **锚点归位**的单测(§2 ①)。
 *
 * 验的是一件事:**工具段出现在它发生的那个正文位置**,而不是消息尾。P0 时锚点是
 * 直通的(工具卡一律挂尾),所以这一批的可感知变化全在这个文件里说清。
 *
 * 算法本身不在这里测 —— 它是 core 的 `synthesizeCoreToolAnchors`,那边有自己的
 * 用例,而本壳是第三个消费者(不许抄第二份)。这里测的是**接得对不对**:
 * parts 递进去了吗、`data-steps{turnIndex}` 翻回真调用了吗、没被锚点认领的调用
 * 有没有消失。
 */

const T0 = 1_700_000_000_000

function call(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    toolId: 'read',
    toolName: 'read',
    arguments: { path: `${id}.txt` },
    status: 'completed',
    timestamp: T0,
    ...patch,
  }
}

function step(callId: string, turnIndex: number) {
  return { id: `s-${callId}`, type: 'tool-call', title: 't', status: 'completed', timestamp: T0, turnIndex, toolCallId: callId, toolCall: call(callId) }
}

function message(patch: Partial<ProjectedMessage> = {}): ProjectedMessage {
  return { id: 'a1', role: 'assistant', content: '', timestamp: T0, ...patch } as ProjectedMessage
}

/** 两轮:说一句 → 做一件事 → 再说一句 → 再做一件事。屏幕上该是交错的四段。 */
function twoTurnMessage(): ProjectedMessage {
  return message({
    content: '先看看这个再看看那个',
    contentParts: [
      { type: 'text', content: '先看看', turnIndex: 0 },
      { type: 'text', content: '这个', turnIndex: 0 },
      { type: 'text', content: '再看看那个', turnIndex: 1 },
    ],
    steps: [step('c1', 0), step('c2', 1)],
    toolCalls: [call('c1'), call('c2')],
  } as Partial<ProjectedMessage>)
}

describe('锚点归位:工具段插在它发生的那处正文之间', () => {
  it('按 turnIndex 织进序列 —— 不再一律挂尾', () => {
    const nodes = anchorMessage(twoTurnMessage())
    expect(nodes.map((node) => node.node)).toEqual(['text', 'tool', 'text', 'tool'])
    expect(nodes[1]).toMatchObject({ node: 'tool', call: { id: 'c1' } })
    expect(nodes[3]).toMatchObject({ node: 'tool', call: { id: 'c2' } })
  })

  it('对照旧序:同一条消息在「一律挂尾」的读法下是 text · tool · tool', () => {
    // 这条不是重复上一条 —— 它把**旧行为**写下来,好让下一个人一眼看出这一批
    // 改的是什么:从前 c1 排在全部正文之后,现在它排在第一轮那两段正文之后。
    const nodes = anchorMessage(twoTurnMessage())
    const tailOrder = [
      ...nodes.filter((node) => node.node !== 'tool'),
      ...nodes.filter((node) => node.node === 'tool'),
    ]
    expect(tailOrder.map((node) => node.node)).toEqual(['text', 'text', 'tool', 'tool'])
    expect(nodes.map((node) => node.node)).not.toEqual(tailOrder.map((node) => node.node))
  })

  it('相邻文本 part 合并成一段 —— 一个 <p> 不许被 part 边界劈成两个', () => {
    const nodes = anchorMessage(twoTurnMessage())
    // 前两个 part 中间没有锚点,所以它们是同一段正文,而且逐字相接(没有分隔符)。
    expect(nodes[0]).toEqual({ node: 'text', text: '先看看这个' })
  })

  it('没有 contentParts 的老消息:按正文现搭一格,再走同一条合成', () => {
    const nodes = anchorMessage(
      message({ content: '读一下', toolCalls: [call('c1')] } as Partial<ProjectedMessage>),
    )
    expect(nodes.map((node) => node.node)).toEqual(['text', 'tool'])
  })

  it('只有 toolCalls 没有 steps 的更老消息:走 core 的 tool-call 兜底锚点', () => {
    const nodes = anchorMessage(
      message({
        content: '读一下',
        contentParts: [{ type: 'text', content: '读一下' }],
        toolCalls: [call('c1'), call('c2')],
      } as Partial<ProjectedMessage>),
    )
    expect(nodes.map((node) => node.node)).toEqual(['text', 'tool', 'tool'])
  })

  it('锚点盖不全时剩下的调用挂尾 —— 屏幕上少一张卡就是说谎', () => {
    // c2 有调用但没有 step:锚点只认得出 c1,c2 必须仍然在场。
    const nodes = anchorMessage(
      message({
        contentParts: [{ type: 'text', content: '嗯', turnIndex: 0 }],
        steps: [step('c1', 0)],
        toolCalls: [call('c1'), call('c2')],
      } as Partial<ProjectedMessage>),
    )
    expect(nodes.filter((node) => node.node === 'tool')).toHaveLength(2)
  })

  it('同一次调用只出现一次(锚点 + 挂尾兜底不许重复计数)', () => {
    const nodes = anchorMessage(twoTurnMessage())
    const ids = nodes.flatMap((node) => (node.node === 'tool' ? [node.call.id] : []))
    expect(ids).toEqual(['c1', 'c2'])
  })

  it('顶部推理仍在最前;行内推理按它在 parts 里的位置就位', () => {
    const nodes = anchorMessage(
      message({
        reasoning: '先想想',
        content: '好的',
        contentParts: [
          { type: 'reasoning', content: '再想想', turnIndex: 0 },
          { type: 'text', content: '好的', turnIndex: 0 },
        ],
      } as Partial<ProjectedMessage>),
    )
    expect(nodes).toEqual([
      { node: 'reasoning', text: '先想想', placement: 'top' },
      { node: 'reasoning', text: '再想想', placement: 'inline' },
      { node: 'text', text: '好的' },
    ])
  })

  it('装配之后:两轮消息算成 正文 · 工具 · 正文 · 工具 四段', () => {
    expect(assembleMessage(twoTurnMessage()).map((segment) => segment.kind)).toEqual([
      'rich-text',
      'tool',
      'rich-text',
      'tool',
    ])
  })
})

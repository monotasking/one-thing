import { describe, expect, it } from 'vitest'
import { buildWorkRender, buildWorkSummary, type WorkPartEntry } from '../helpers/work-group'
import type { ContentPart, Step, ToolCall } from '@/types'

/**
 * `buildWorkRender` 的纯函数测试:哪条 entry 渲染哪些 step 行、组与尾的分界、
 * 头部统计。组件级的同名测试(`components/chat/message/__tests__/work-group.test.ts`)
 * 继续守挂载后的实际渲染,两者不重叠。
 */

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc1',
    toolId: 'bash',
    toolName: 'bash',
    arguments: { command: 'ls' },
    status: 'completed',
    timestamp: 1_000,
    startTime: 1_000,
    endTime: 4_000,
    durationMs: 3_000,
    ...overrides,
  }
}

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: 'step1',
    type: 'tool-call',
    title: 'bash',
    status: 'completed',
    timestamp: 1_000,
    turnIndex: 1,
    toolCallId: 'tc1',
    toolCall: toolCall(),
    ...overrides,
  }
}

/** entry key 的生成在 MessageBubble 里;这里只要稳定唯一即可。 */
function entries(...parts: ContentPart[]): WorkPartEntry[] {
  return parts.map((part, index) => ({ part, key: `${part.type}-${index}` }))
}

function render(
  parts: ContentPart[],
  options: { steps?: Step[]; role?: 'user' | 'assistant'; hasThinking?: boolean } = {},
) {
  const steps = options.steps ?? []
  const byId = new Map(steps.filter(s => s.toolCallId).map(s => [s.toolCallId as string, s]))
  return buildWorkRender({
    entries: entries(...parts),
    role: options.role ?? 'assistant',
    hasThinking: options.hasThinking,
    findStep: id => byId.get(id),
    stepsForTurn: turnIndex =>
      (turnIndex === undefined ? steps : steps.filter(s => s.turnIndex === turnIndex)),
  })
}

describe('buildWorkRender', () => {
  it('纯思考不成组:没有工具就没有 Working/Worked 头,全部落进 tail', () => {
    const result = render(
      [
        { type: 'reasoning', content: '想一想', turnIndex: 0 } as ContentPart,
        { type: 'text', content: '答案' } as ContentPart,
      ],
      { hasThinking: true },
    )
    expect(result.hasWorkGroup).toBe(false)
    expect(result.workEntries).toEqual([])
    expect(result.tailEntries).toHaveLength(2)
    // hasThinking 一步 + reasoning part 一步。
    expect(result.stats.reasoningCount).toBe(2)
    expect(result.stats.toolCount).toBe(0)
  })

  it('user 角色永远不成组', () => {
    const result = render(
      [{ type: 'data-steps', turnIndex: 1 } as ContentPart],
      { steps: [step()], role: 'user' },
    )
    expect(result.hasWorkGroup).toBe(false)
  })

  it('tool-call 与 data-steps 指向同一个 toolCall 时只算一次(tool-call 认领)', () => {
    const call = toolCall({ id: 'tc-dup' })
    const real = step({ id: 's-dup', toolCallId: 'tc-dup', toolCall: call, turnIndex: 2 })
    const result = render(
      [
        { type: 'tool-call', toolCalls: [call] } as ContentPart,
        { type: 'data-steps', turnIndex: 2 } as ContentPart,
      ],
      { steps: [real] },
    )
    expect(result.stats.toolCount).toBe(1)
    expect(result.stats.toolCounts.get('bash')).toBe(1)
    // 行归 tool-call 那条 entry,data-steps 一行不剩(因此也不进 stepsByEntry)。
    expect(result.stepsByEntry.get('tool-call-0')).toEqual([real])
    expect(result.stepsByEntry.has('data-steps-1')).toBe(false)
  })

  it('没有真实 step 时 tool-call 合成一行,并继承同批次的 turnIndex', () => {
    const a = toolCall({ id: 'a', toolName: 'read' })
    const b = toolCall({ id: 'b', toolName: 'write' })
    const realA = step({ id: 'sa', toolCallId: 'a', toolCall: a, turnIndex: 7 })
    const result = render(
      [{ type: 'tool-call', toolCalls: [a, b] } as ContentPart],
      { steps: [realA] },
    )
    const rows = result.stepsByEntry.get('tool-call-0') ?? []
    expect(rows).toHaveLength(2)
    expect(rows[0]).toBe(realA)
    expect(rows[1].turnIndex).toBe(7)
    expect(rows[1].toolCallId).toBe('b')
  })

  it('历史消息(只有 data-steps)照常渲染', () => {
    const s1 = step({ id: 's1', toolCallId: 'tc1', turnIndex: 1 })
    const s2 = step({ id: 's2', toolCallId: 'tc2', turnIndex: 1, toolCall: toolCall({ id: 'tc2', toolName: 'read' }) })
    const result = render(
      [{ type: 'data-steps', turnIndex: 1 } as ContentPart],
      { steps: [s1, s2] },
    )
    expect(result.stepsByEntry.get('data-steps-0')).toEqual([s1, s2])
    expect(result.stats.toolCount).toBe(2)
  })

  it('最后一轮工具之后的文本进 tail,之前的文本留在组里', () => {
    const result = render(
      [
        { type: 'text', content: '先说两句' } as ContentPart,
        { type: 'data-steps', turnIndex: 1 } as ContentPart,
        { type: 'text', content: '中间叙述' } as ContentPart,
        { type: 'data-steps', turnIndex: 2 } as ContentPart,
        { type: 'text', content: '最终答案' } as ContentPart,
      ],
      {
        steps: [
          step({ id: 's1', toolCallId: 'tc1', turnIndex: 1 }),
          step({ id: 's2', toolCallId: 'tc2', turnIndex: 2, toolCall: toolCall({ id: 'tc2' }) }),
        ],
      },
    )
    expect(result.hasWorkGroup).toBe(true)
    expect(result.workEntries.map(e => e.key)).toEqual([
      'text-0', 'data-steps-1', 'text-2', 'data-steps-3',
    ])
    expect(result.tailEntries.map(e => e.key)).toEqual(['text-4'])
  })

  it('空轮锚点的位置决定正文去向:排在正文前 → 正文进 tail;挂在正文后 → 正文被卷进组', () => {
    // 真机 e0267646 的形状:轮 1 有工具但没有任何内容 part(top reasoning 落
    // message.reasoning),轮 2 只有最终正文。锚点该插在正文**之前**。
    const s1 = step({ id: 's1', toolCallId: 'tc1', turnIndex: 1 })
    const text = { type: 'text', content: '最终答案' } as ContentPart
    const anchor = { type: 'data-steps', turnIndex: 1 } as ContentPart

    const correct = render([anchor, text], { steps: [s1] })
    expect(correct.hasWorkGroup).toBe(true)
    expect(correct.tailEntries.map(e => e.part.type)).toEqual(['text'])
    expect(correct.tailEntries.map(e => (e.part as { content?: string }).content)).toEqual(['最终答案'])
    expect(correct.workEntries.map(e => e.part.type)).toEqual(['data-steps'])

    // 反向:同一批 part,锚点挂尾 —— lastProcessIndex 被推到末位,tail 空,
    // 整条正文进折叠区(历史消息默认收起 = 正文不可见)。这就是修 A 前的现场。
    const broken = render([text, anchor], { steps: [s1] })
    expect(broken.hasWorkGroup).toBe(true)
    expect(broken.tailEntries).toEqual([])
    expect(broken.workEntries.map(e => e.part.type)).toEqual(['text', 'data-steps'])
  })

  it('waiting 不移动组/尾的分界', () => {
    const withWaiting = render(
      [
        { type: 'data-steps', turnIndex: 1 } as ContentPart,
        { type: 'waiting', turnIndex: 1 } as ContentPart,
        { type: 'text', content: '答案' } as ContentPart,
      ],
      { steps: [step()] },
    )
    expect(withWaiting.workEntries.map(e => e.key)).toEqual(['data-steps-0'])
    expect(withWaiting.tailEntries.map(e => e.key)).toEqual(['waiting-1', 'text-2'])
  })

  it('空的 data-steps 轮次不移动分界(没有行就不算过程)', () => {
    const result = render(
      [
        { type: 'data-steps', turnIndex: 1 } as ContentPart,
        { type: 'data-steps', turnIndex: 9 } as ContentPart,
        { type: 'text', content: '答案' } as ContentPart,
      ],
      { steps: [step()] },
    )
    expect(result.workEntries.map(e => e.key)).toEqual(['data-steps-0'])
    expect(result.tailEntries.map(e => e.key)).toEqual(['data-steps-1', 'text-2'])
  })

  it('failedCount 只数失败的行', () => {
    const result = render(
      [{ type: 'data-steps', turnIndex: 1 } as ContentPart],
      {
        steps: [
          step({ id: 's1', toolCallId: 'tc1' }),
          step({ id: 's2', toolCallId: 'tc2', status: 'failed', toolCall: toolCall({ id: 'tc2' }) }),
          step({ id: 's3', toolCallId: 'tc3', status: 'failed', toolCall: toolCall({ id: 'tc3' }) }),
        ],
      },
    )
    expect(result.stats.failedCount).toBe(2)
    expect(result.stats.toolCount).toBe(3)
  })

  it('lastToolEnd 取最晚的结束时刻(endTime 缺席时用 startTime/timestamp + durationMs)', () => {
    const result = render(
      [{ type: 'data-steps', turnIndex: 1 } as ContentPart],
      {
        steps: [
          step({ id: 's1', toolCallId: 'tc1', toolCall: toolCall({ endTime: 4_000 }) }),
          step({
            id: 's2',
            toolCallId: 'tc2',
            toolCall: toolCall({ id: 'tc2', endTime: undefined, startTime: 5_000, durationMs: 2_500 }),
          }),
          step({
            id: 's3',
            toolCallId: 'tc3',
            toolCall: toolCall({ id: 'tc3', endTime: undefined, startTime: undefined, timestamp: 1_000, durationMs: 100 }),
          }),
        ],
      },
    )
    expect(result.stats.lastToolEnd).toBe(7_500)
  })
})

describe('buildWorkSummary', () => {
  function stats(reasoningCount: number, tools: Array<[string, number]>) {
    return {
      reasoningCount,
      toolCount: tools.reduce((sum, [, n]) => sum + n, 0),
      failedCount: 0,
      toolCounts: new Map(tools),
      lastToolEnd: 0,
    }
  }

  it('思考步数 + 按次数降序的工具名', () => {
    expect(buildWorkSummary(stats(3, [['read', 1], ['bash', 5]]))).toBe('思考 3 步 · bash ×5 · read')
  })

  it('没有思考时不写思考', () => {
    expect(buildWorkSummary(stats(0, [['bash', 1]]))).toBe('bash')
  })

  it('超过 4 种工具折成 +N', () => {
    expect(buildWorkSummary(stats(0, [['a', 6], ['b', 5], ['c', 4], ['d', 3], ['e', 2], ['f', 1]])))
      .toBe('a ×6 · b ×5 · c ×4 · d ×3 · +2')
  })
})

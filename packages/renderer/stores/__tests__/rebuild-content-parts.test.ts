import { describe, expect, it } from 'vitest'
import { rebuildLoadedContentParts, synthesizeToolAnchors } from '../helpers/content-parts'
import { buildWorkRender, type WorkPartEntry } from '../helpers/work-group'
import type { ContentPart, Step, ToolCall } from '@/types'

/**
 * `rebuildLoadedContentParts` —— 加载历史消息时的 parts 重建(D-lite)。
 *
 * 老消息只有 `content` + `steps`(极老的只有 `toolCalls`),渲染层却按 part
 * 走位。这里钉死三件事:正文在前、工具占位统一走 `data-steps`(按 turnIndex
 * 升序去重)、只有在**一个 step 都没有**时才回退到 `tool-call` 块。
 *
 * 最后一条是等价性:同一条老消息,用旧的 `tool-call` parts 和新的 `data-steps`
 * parts 过 `buildWorkRender`,得到的 step 行集合与组/尾切分必须一致。
 */

function toolCall(id: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
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

function step(id: string, overrides: Partial<Step> = {}): Step {
  return {
    id,
    type: 'tool-call',
    title: 'bash',
    status: 'completed',
    timestamp: 1_000,
    turnIndex: 0,
    toolCallId: id,
    toolCall: toolCall(id),
    ...overrides,
  }
}

describe('rebuildLoadedContentParts', () => {
  it('有 steps:正文在前,每一轮补一个 data-steps 占位', () => {
    const parts = rebuildLoadedContentParts({
      content: '做完了',
      steps: [step('a', { turnIndex: 0 }), step('b', { turnIndex: 1 })],
    })
    expect(parts).toEqual([
      { type: 'text', content: '做完了' },
      { type: 'data-steps', turnIndex: 0 },
      { type: 'data-steps', turnIndex: 1 },
    ])
  })

  it('多轮 steps:占位按 turnIndex 升序且去重,乱序输入也一样', () => {
    const parts = rebuildLoadedContentParts({
      steps: [
        step('a', { turnIndex: 2 }),
        step('b', { turnIndex: 0 }),
        step('c', { turnIndex: 2 }),
        step('d', { turnIndex: 1 }),
        step('e', { turnIndex: 0 }),
      ],
    })
    expect(parts).toEqual([
      { type: 'data-steps', turnIndex: 0 },
      { type: 'data-steps', turnIndex: 1 },
      { type: 'data-steps', turnIndex: 2 },
    ])
  })

  it('step 缺 turnIndex 时视为第 0 轮', () => {
    const parts = rebuildLoadedContentParts({
      steps: [step('a', { turnIndex: undefined }), step('b', { turnIndex: 0 })],
    })
    expect(parts).toEqual([{ type: 'data-steps', turnIndex: 0 }])
  })

  it('有 steps 时不再补 tool-call 兜底(steps 与 toolCalls 双存的老消息)', () => {
    const parts = rebuildLoadedContentParts({
      steps: [step('a')],
      toolCalls: [toolCall('a')],
    })
    expect(parts.some(part => part.type === 'tool-call')).toBe(false)
    expect(parts).toEqual([{ type: 'data-steps', turnIndex: 0 }])
  })

  it('无 steps 有 toolCalls:保留旧的 tool-call 兜底,且是拷贝不是原数组', () => {
    const calls = [toolCall('a'), toolCall('b')]
    const parts = rebuildLoadedContentParts({ content: '正文', toolCalls: calls })
    expect(parts).toEqual([
      { type: 'text', content: '正文' },
      { type: 'tool-call', toolCalls: calls },
    ])
    const toolPart = parts[1] as Extract<ContentPart, { type: 'tool-call' }>
    expect(toolPart.toolCalls).not.toBe(calls)
  })

  it('二者皆空:只剩正文;正文也没有就什么都不补', () => {
    expect(rebuildLoadedContentParts({ content: '只有正文' })).toEqual([
      { type: 'text', content: '只有正文' },
    ])
    expect(rebuildLoadedContentParts({})).toEqual([])
    expect(rebuildLoadedContentParts({ content: '', steps: [], toolCalls: [] })).toEqual([])
  })
})

describe('rebuildLoadedContentParts × buildWorkRender 等价性', () => {
  /** entry key 的生成在 MessageBubble 里;这里只要稳定唯一即可。 */
  function entries(parts: readonly ContentPart[]): WorkPartEntry[] {
    return parts.map((part, index) => ({ part, key: `${part.type}-${index}` }))
  }

  function render(parts: readonly ContentPart[], steps: Step[]) {
    const byId = new Map(steps.filter(s => s.toolCallId).map(s => [s.toolCallId as string, s]))
    return buildWorkRender({
      entries: entries(parts),
      role: 'assistant',
      findStep: id => byId.get(id),
      stepsForTurn: turnIndex =>
        (turnIndex === undefined ? steps : steps.filter(s => s.turnIndex === turnIndex)),
    })
  }

  /** 行集合按 step id 拍平比较 —— key 是按 part 位置生成的,两侧本就不同。 */
  function rowIds(result: ReturnType<typeof render>): string[][] {
    return [...result.stepsByEntry.values()].map(rows => rows.map(row => row.id))
  }

  it('同一条老消息:旧 tool-call parts 与新 data-steps parts 的行集合与切分一致', () => {
    const steps = [
      step('a', { turnIndex: 0 }),
      step('b', { turnIndex: 0 }),
      step('c', { turnIndex: 1 }),
    ]
    const message = {
      content: '做完了',
      steps,
      toolCalls: steps.map(s => s.toolCall as ToolCall),
    }

    // 旧实现:正文 + 一个把所有 toolCalls 糊在一起的 tool-call 块。
    const legacyParts: ContentPart[] = [
      { type: 'text', content: message.content },
      { type: 'tool-call', toolCalls: [...message.toolCalls] },
    ]
    const nextParts = rebuildLoadedContentParts(message)

    const legacy = render(legacyParts, steps)
    const next = render(nextParts, steps)

    // 行集合:同一批真 step,分组数不同(旧 1 组 / 新 2 组)但并集逐条相同。
    expect(rowIds(legacy).flat()).toEqual(['a', 'b', 'c'])
    expect(rowIds(next).flat()).toEqual(['a', 'b', 'c'])
    expect(rowIds(next)).toEqual([['a', 'b'], ['c']])

    // 统计与切分:工具计数、成组判定、组/尾的 part 类型序列一致。
    expect(next.stats.toolCount).toBe(legacy.stats.toolCount)
    expect(next.stats.failedCount).toBe(legacy.stats.failedCount)
    expect(next.hasWorkGroup).toBe(legacy.hasWorkGroup)
    expect(next.workEntries.map(e => e.part.type)).toEqual(['text', 'data-steps', 'data-steps'])
    expect(legacy.workEntries.map(e => e.part.type)).toEqual(['text', 'tool-call'])
    // 尾部两侧都为空:老消息的正文在工具之前,最后一轮工具之后没有东西。
    expect(next.tailEntries).toEqual([])
    expect(legacy.tailEntries).toEqual([])
  })

  it('无 step 的更老消息:两侧都靠 tool-call 兜底合成行,结果逐条相同', () => {
    const calls = [toolCall('a'), toolCall('b')]
    const legacyParts: ContentPart[] = [{ type: 'tool-call', toolCalls: [...calls] }]
    const nextParts = rebuildLoadedContentParts({ toolCalls: calls })
    expect(nextParts).toEqual(legacyParts)

    const legacy = render(legacyParts, [])
    const next = render(nextParts, [])
    expect(rowIds(next)).toEqual(rowIds(legacy))
    expect(next.stats.toolCount).toBe(2)
    expect(next.hasWorkGroup).toBe(legacy.hasWorkGroup)
  })
})

/**
 * `synthesizeToolAnchors` —— S3w-0:events 读模式的投影 contentParts 只有
 * text/reasoning(无渲染锚点),加载路径按 steps/toolCalls 现合成 data-steps。
 * 反向门:不修则 work group 空(投影形态的工具行折不出);修后每一轮都折得出。
 */
describe('synthesizeToolAnchors(投影形态补锚点)', () => {
  function entries(parts: readonly ContentPart[]): WorkPartEntry[] {
    return parts.map((part, index) => ({ part, key: `${part.type}-${index}` }))
  }

  function render(parts: readonly ContentPart[], steps: Step[]) {
    const byId = new Map(steps.filter(s => s.toolCallId).map(s => [s.toolCallId as string, s]))
    return buildWorkRender({
      entries: entries(parts),
      role: 'assistant',
      findStep: id => byId.get(id),
      stepsForTurn: turnIndex =>
        (turnIndex === undefined ? steps : steps.filter(s => (s.turnIndex ?? 0) === turnIndex)),
    })
  }

  function rowIds(result: ReturnType<typeof render>): string[] {
    return [...result.stepsByEntry.values()].flat().map(row => row.id)
  }

  it('反向:投影形态(text/reasoning-only,无锚点)+ 齐全 steps → 补锚点后 work group 折得出', () => {
    // 投影补水的形状:每一轮的正文,但没有任何 data-steps / tool-call 锚点。
    // 工具在第 0、1 轮;第 2 轮是无工具的最终回答。
    const projected: ContentPart[] = [
      { type: 'reasoning', content: '想一下', turnIndex: 0 },
      { type: 'text', content: '先查一下', turnIndex: 0 },
      { type: 'text', content: '再查一下', turnIndex: 1 },
      { type: 'text', content: '查完了,答案是 X', turnIndex: 2 },
    ]
    const steps = [
      step('a', { turnIndex: 0 }),
      step('b', { turnIndex: 0 }),
      step('c', { turnIndex: 1 }),
    ]

    // 不修(投影形态原样过 buildWorkRender):无锚点 → 工具一个都折不出、无 work group。
    const before = render(projected, steps)
    expect(before.hasWorkGroup).toBe(false)
    expect(before.stats.toolCount).toBe(0)

    // 修后:补出 data-steps,每一轮的 step 都折得出。
    const merged = synthesizeToolAnchors(projected, {
      steps,
      toolCalls: steps.map(s => s.toolCall as ToolCall),
    })
    expect(merged).not.toBeNull()
    const after = render(merged!, steps)
    expect(after.hasWorkGroup).toBe(true)
    expect(after.stats.toolCount).toBe(3)
    expect(rowIds(after).sort()).toEqual(['a', 'b', 'c'])

    // Working/Worked 切分:最后一轮工具之后的最终回答留在 tail,不卷进 work group。
    expect(after.tailEntries.map(e => (e.part as { content?: string }).content)).toEqual([
      '查完了,答案是 X',
    ])
    // 锚点位置:各轮正文之后、下一轮之前。
    expect(merged!.map(p => `${p.type}:${(p as { turnIndex?: number }).turnIndex ?? ''}`)).toEqual([
      'reasoning:0',
      'text:0',
      'data-steps:0',
      'text:1',
      'data-steps:1',
      'text:2',
    ])
  })

  it('单轮投影 + 无后续回答文本:锚点补在末尾,tail 为空', () => {
    const projected: ContentPart[] = [{ type: 'text', content: '执行中', turnIndex: 0 }]
    const steps = [step('a', { turnIndex: 0 })]
    const merged = synthesizeToolAnchors(projected, { steps })
    expect(merged).toEqual([
      { type: 'text', content: '执行中', turnIndex: 0 },
      { type: 'data-steps', turnIndex: 0 },
    ])
    const after = render(merged!, steps)
    expect(after.hasWorkGroup).toBe(true)
    expect(after.stats.toolCount).toBe(1)
  })

  it('幂等:已带 data-steps 锚点的历史消息过一遍不变(返回 null,锚点数不增)', () => {
    const withAnchor: ContentPart[] = [
      { type: 'text', content: '做完了' },
      { type: 'data-steps', turnIndex: 0 },
    ]
    expect(synthesizeToolAnchors(withAnchor, { steps: [step('a')] })).toBeNull()
  })

  it('幂等:已带 tool-call 锚点(流式/极老消息)也是 no-op', () => {
    const withToolCall: ContentPart[] = [{ type: 'tool-call', toolCalls: [toolCall('a')] }]
    expect(synthesizeToolAnchors(withToolCall, { toolCalls: [toolCall('a')] })).toBeNull()
  })

  it('无工具:纯 text/reasoning 的消息不补锚点(返回 null)', () => {
    const textOnly: ContentPart[] = [{ type: 'text', content: '就一句话', turnIndex: 0 }]
    expect(synthesizeToolAnchors(textOnly, {})).toBeNull()
    expect(synthesizeToolAnchors(textOnly, { steps: [], toolCalls: [] })).toBeNull()
    // reasoning step 但无 toolCall/toolCallId → 不算工具活儿。
    const reasoningStep = step('r', { type: 'thinking', toolCall: undefined, toolCallId: undefined })
    expect(synthesizeToolAnchors(textOnly, { steps: [reasoningStep] })).toBeNull()
  })

  it('无 steps 只有 toolCalls 的投影消息:兜底补一个 tool-call 块挂末尾', () => {
    const projected: ContentPart[] = [{ type: 'text', content: '正文' }]
    const calls = [toolCall('a'), toolCall('b')]
    const merged = synthesizeToolAnchors(projected, { toolCalls: calls })
    expect(merged).toEqual([
      { type: 'text', content: '正文' },
      { type: 'tool-call', toolCalls: calls },
    ])
    const toolPart = merged![1] as Extract<ContentPart, { type: 'tool-call' }>
    expect(toolPart.toolCalls).not.toBe(calls)
  })

  it('多轮乱序 turnIndex 全覆盖:每一轮都有一个 data-steps 锚点', () => {
    const projected: ContentPart[] = [
      { type: 'text', content: 't0', turnIndex: 0 },
      { type: 'text', content: 't1', turnIndex: 1 },
      { type: 'text', content: 't2', turnIndex: 2 },
    ]
    const steps = [
      step('a', { turnIndex: 2 }),
      step('b', { turnIndex: 0 }),
      step('c', { turnIndex: 1 }),
    ]
    const merged = synthesizeToolAnchors(projected, { steps })!
    const anchorTurns = merged
      .filter(p => p.type === 'data-steps')
      .map(p => (p as { turnIndex?: number }).turnIndex)
    expect(anchorTurns).toEqual([0, 1, 2])
    const after = render(merged, steps)
    expect(after.stats.toolCount).toBe(3)
    expect(rowIds(after).sort()).toEqual(['a', 'b', 'c'])
  })
})

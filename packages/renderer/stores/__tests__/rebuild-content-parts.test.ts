import { describe, expect, it } from 'vitest'
import { rebuildLoadedContentParts } from '../helpers/content-parts'
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

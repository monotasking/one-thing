// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import MessageBubble from '../MessageBubble.vue'
import type { ContentPart, Step, ToolCall } from '@/types'
import { clearExpansionIntents } from '@/stores/helpers/expansion-intent'

/**
 * The message-level work group (2026-08-19): one Working/Worked header
 * around thoughts + tool rounds + interim narration; the answer after the
 * last tool round stays outside; header settles as soon as that answer
 * starts streaming.
 */

const stubs = {
  StreamingMarkdown: {
    props: ['content', 'isUser', 'isStreaming'],
    template: '<div data-renderer="streaming">{{ content }}</div>',
  },
  StaticMarkdown: {
    props: ['content', 'isUser'],
    template: '<div data-renderer="static">{{ content }}</div>',
  },
  StepsPanel: { props: ['steps'], template: '<div class="steps-stub" :data-count="steps.length" />' },
}

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

function mountBubble(props: Partial<InstanceType<typeof MessageBubble>['$props']> & { contentParts: ContentPart[] }) {
  return mount(MessageBubble, {
    props: {
      role: 'assistant',
      content: '',
      messageId: 'm1',
      startedAt: 0,
      ...props,
    },
    global: { stubs },
    slots: { thinking: '<div class="thinking-slot">thought</div>' },
  })
}

describe('work group', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearExpansionIntents()
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('splits at the last tool round: process inside the group, the answer outside', async () => {
    const w = mountBubble({
      contentParts: [
        { type: 'text', content: 'let me look', turnIndex: 1 },
        { type: 'reasoning', content: 'I should check the file first.', turnIndex: 1 },
        { type: 'data-steps', turnIndex: 1 },
        { type: 'text', content: 'final answer', turnIndex: 2 },
      ],
      steps: [step()],
      isStreaming: false,
    })
    await nextTick()

    const rail = w.find('.process-rail')
    expect(rail.classes()).not.toContain('is-solo')
    // Header: settled label + tally; the top-thought slot rides inside the group.
    expect(rail.find('.process-rail-title').text()).toContain('Worked')
    expect(rail.find('.process-rail-title').text()).toContain('bash')
    // Settled → collapsed by default: interim narration hidden, answer visible.
    expect(rail.find('.process-rail-body').exists()).toBe(false)
    const tail = w.find('.other-parts-container')
    expect(tail.text()).toContain('final answer')
    expect(tail.text()).not.toContain('let me look')

    // Expanding reveals the interim narration + thought + tool rows, in order.
    await rail.find('.process-rail-header').trigger('click')
    const body = rail.find('.process-rail-body')
    // The top-thought slot rides inside the group, first.
    expect(body.find('.thinking-slot').exists()).toBe(true)
    expect(body.text()).toContain('let me look')
    expect(body.find('.inline-reasoning').exists()).toBe(true)
    expect(body.find('.steps-stub').attributes('data-count')).toBe('1')
    // The answer did NOT move into the group.
    expect(body.text()).not.toContain('final answer')
  })

  it('reads "Working" while the tool runs and settles to "Worked" once the answer streams', async () => {
    const running = toolCall({ status: 'executing', endTime: undefined, durationMs: undefined })
    const w = mountBubble({
      contentParts: [
        { type: 'tool-call', toolCalls: [running] },
      ],
      steps: [],
      isStreaming: true,
    })
    await nextTick()
    const rail = w.find('.process-rail')
    expect(rail.find('.process-rail-title').text()).toContain('Working')
    // Live: auto-open, and the timer ticks from `startedAt`.
    expect(rail.classes()).toContain('is-open')
    await vi.advanceTimersByTimeAsync(5_000)
    await nextTick()
    expect(rail.find('.process-rail-title').text()).toContain('5.0s')

    // Tool done, the answer starts streaming after it: work is over even
    // though the message is still streaming.
    await w.setProps({
      contentParts: [
        { type: 'tool-call', toolCalls: [toolCall({ endTime: 4_000 })] },
        { type: 'data-steps', turnIndex: 1 },
        { type: 'text', content: 'here is', turnIndex: 2 },
      ],
      steps: [step()],
      isStreaming: true,
    })
    await nextTick()
    expect(rail.find('.process-rail-title').text()).toContain('Worked')
    // Frozen at the moment work ended (the ticker's value), not reset.
    expect(rail.find('.process-rail-title').text()).toContain('5.0s')
    expect(w.find('.other-parts-container').text()).toContain('here is')
  })

  it('reopens and goes live again when another tool call follows the interim text', async () => {
    const w = mountBubble({
      contentParts: [
        { type: 'tool-call', toolCalls: [toolCall()] },
        { type: 'data-steps', turnIndex: 1 },
        { type: 'text', content: 'interim', turnIndex: 2 },
      ],
      steps: [step()],
      isStreaming: true,
    })
    await nextTick()
    const rail = w.find('.process-rail')
    expect(rail.find('.process-rail-title').text()).toContain('Worked')
    expect(w.find('.other-parts-container').text()).toContain('interim')

    await w.setProps({
      contentParts: [
        { type: 'tool-call', toolCalls: [toolCall()] },
        { type: 'data-steps', turnIndex: 1 },
        { type: 'text', content: 'interim', turnIndex: 2 },
        { type: 'tool-call', toolCalls: [toolCall({ id: 'tc2', status: 'executing', endTime: undefined, durationMs: undefined })] },
      ],
    })
    await nextTick()
    expect(rail.find('.process-rail-title').text()).toContain('Working')
    expect(rail.classes()).toContain('is-open')
    // The interim text moved into the group; nothing is left in the tail.
    expect(w.find('.other-parts-container').exists()).toBe(false)
    expect(rail.find('.process-rail-body').text()).toContain('interim')
  })

  // 2026-08-19 用户拍板(方案 B):框子的票是**整条流**(`isStreaming`),不是
  // 工作组自己那面来回翻的旗。这条钉的是喂票的那一层:多轮工具的一个回合里,
  // 头上的 Working/Worked 该翻多少次翻多少次,rail 的 is-open 一次都不许抖。
  it('keeps the rail open across every round of a multi-round turn', async () => {
    const running = toolCall({ id: 'tc1', status: 'executing', endTime: undefined, durationMs: undefined })
    const w = mountBubble({
      contentParts: [{ type: 'tool-call', toolCalls: [running] }],
      steps: [],
      isStreaming: true,
    })
    await nextTick()
    const rail = () => w.find('.process-rail')
    expect(rail().classes()).toContain('is-open')

    const states = [rail().classes().includes('is-open')]
    const labels = [rail().find('.process-rail-title').text().includes('Working')]
    const parts: ContentPart[] = [{ type: 'tool-call', toolCalls: [toolCall({ id: 'tc1' })] }]

    for (let round = 2; round <= 4; round++) {
      // 这一轮的工具结束、过渡叙述流出 → 头翻 Worked
      parts.push({ type: 'text', content: `interim ${round}`, turnIndex: round })
      await w.setProps({ contentParts: [...parts], isStreaming: true })
      await nextTick()
      states.push(rail().classes().includes('is-open'))
      labels.push(rail().find('.process-rail-title').text().includes('Working'))

      // 下一轮工具开跑 → 头翻回 Working
      parts.push({
        type: 'tool-call',
        toolCalls: [toolCall({ id: `tc${round}`, status: 'executing', endTime: undefined, durationMs: undefined })],
      })
      await w.setProps({ contentParts: [...parts], isStreaming: true })
      await nextTick()
      states.push(rail().classes().includes('is-open'))
      labels.push(rail().find('.process-rail-title').text().includes('Working'))
    }

    // 头确实来回翻过(否则这条测试什么都没证明)……
    expect(new Set(labels).size).toBe(2)
    // ……而框子从头到尾一次没抖。
    expect(states.every(Boolean)).toBe(true)

    // 回合真正结束才折一次。
    await w.setProps({
      contentParts: [...parts.slice(0, -1), { type: 'text', content: 'final answer', turnIndex: 5 }],
      steps: [step()],
      isStreaming: false,
    })
    await nextTick()
    expect(rail().classes()).not.toContain('is-open')
  })

  it('has no header for a thought-only turn (no tool round)', async () => {
    const w = mountBubble({
      contentParts: [{ type: 'text', content: 'plain answer', turnIndex: 1 }],
      hasThinking: true,
      isStreaming: false,
    })
    await nextTick()
    const rail = w.find('.process-rail')
    expect(rail.classes()).toContain('is-solo')
    expect(rail.find('.process-rail-header').exists()).toBe(false)
    expect(rail.find('.thinking-slot').exists()).toBe(true)
    expect(w.find('.other-parts-container').text()).toContain('plain answer')
  })

  it('derives the settled duration from the last tool end for a history message', async () => {
    const w = mountBubble({
      contentParts: [
        { type: 'data-steps', turnIndex: 1 },
        { type: 'text', content: 'done', turnIndex: 2 },
      ],
      steps: [step({ toolCall: toolCall({ endTime: 41_000 }) })],
      startedAt: 1_000,
      isStreaming: false,
    })
    await nextTick()
    expect(w.find('.process-rail-title').text()).toContain('40s')
  })
})

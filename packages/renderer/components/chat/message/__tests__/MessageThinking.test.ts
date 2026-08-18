// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MessageThinking from '../MessageThinking.vue'

vi.mock('@/composables/useMarkdownRenderer', () => ({
  renderMarkdown: (content: string) => `<p>${content}</p>`,
  cleanReasoningContent: (content: string) => content.trim(),
}))

describe('MessageThinking', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now())
      return 1
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('stays collapsed when reasoning arrives and streams its tail through the header', async () => {
    const wrapper = mount(MessageThinking, {
      props: {
        isStreaming: true,
        hasContent: false,
        reasoning: '',
      },
    })

    expect(wrapper.find('.thinking-reasoning-wrapper').exists()).toBe(false)

    await wrapper.setProps({ reasoning: 'first line of reasoning\nsecond   line' })
    await nextTick()

    expect(wrapper.find('.thinking-panel').classes()).toContain('collapse-panel')
    expect(wrapper.find('.thinking-panel').classes()).toContain('variant-plain')
    expect(wrapper.find('.thinking-panel').classes()).toContain('icon-inline-end')
    // No auto-expand (2026-08-17): the body stays folded …
    const reasoning = wrapper.find('.thinking-reasoning-wrapper')
    expect(reasoning.exists()).toBe(true)
    expect(reasoning.classes()).not.toContain('expanded')
    // … and the live text shows in the collapsed header, one line, tail-first.
    const header = wrapper.find('.thought-header')
    expect(header.text()).toContain('Thinking')
    expect(header.find('.thought-detail-text').classes()).toContain('tail')
    expect(header.find('.thought-detail-text').text()).toBe('first line of reasoning second line')

    wrapper.unmount()
  })

  it('does not persist waiting time as thinking time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const wrapper = mount(MessageThinking, {
      props: {
        isStreaming: true,
        hasContent: false,
        reasoning: '',
      },
    })

    vi.advanceTimersByTime(1200)
    await wrapper.setProps({ isStreaming: false })
    await nextTick()

    expect(wrapper.emitted('updateThinkingTime')).toBeUndefined()

    wrapper.unmount()
  })

  it('starts thinking time when reasoning appears after waiting', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const wrapper = mount(MessageThinking, {
      props: {
        isStreaming: true,
        hasContent: false,
        reasoning: '',
      },
    })

    vi.advanceTimersByTime(1500)
    await wrapper.setProps({
      reasoning: 'reasoning summary',
      thinkingStartTime: Date.now(),
    })
    await nextTick()

    vi.advanceTimersByTime(2000)
    await wrapper.setProps({ hasContent: true })
    await nextTick()

    const emitted = wrapper.emitted('updateThinkingTime')
    expect(emitted).toBeTruthy()
    expect(emitted?.[0]?.[0]).toBeCloseTo(2, 1)

    wrapper.unmount()
  })

  it('never folds or opens by itself across answer start and stream end', async () => {
    const wrapper = mount(MessageThinking, {
      props: {
        isStreaming: true,
        hasContent: false,
        reasoning: 'reasoning summary',
      },
    })
    expect(wrapper.find('.thinking-reasoning-wrapper').classes()).not.toContain('expanded')

    await wrapper.setProps({ hasContent: true })
    await nextTick()
    expect(wrapper.find('.thinking-reasoning-wrapper').classes()).not.toContain('expanded')

    await wrapper.setProps({ isStreaming: false })
    await nextTick()
    expect(wrapper.find('.thinking-reasoning-wrapper').classes()).not.toContain('expanded')
    // Settled header keeps the streamed tail; elapsed shows only once a timer measured it.
    const header = wrapper.find('.thought-header')
    expect(header.text()).toContain('Thought')
    expect(header.find('.thought-detail-text.tail').text()).toBe('reasoning summary')

    wrapper.unmount()
  })

  it('does not override user-controlled expansion when streaming ends', async () => {
    const wrapper = mount(MessageThinking, {
      props: {
        isStreaming: true,
        hasContent: false,
        reasoning: 'reasoning summary',
      },
    })

    // Starts collapsed; one click opens it.
    expect(wrapper.find('.thinking-reasoning-wrapper').classes()).not.toContain('expanded')
    await wrapper.find('.thinking-status-row.clickable').trigger('click')
    await nextTick()
    expect(wrapper.find('.thinking-reasoning-wrapper').classes()).toContain('expanded')

    await wrapper.setProps({ isStreaming: false })
    await nextTick()

    expect(wrapper.find('.thinking-reasoning-wrapper').classes()).toContain('expanded')

    wrapper.unmount()
  })
})

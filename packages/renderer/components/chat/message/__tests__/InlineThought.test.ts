// @vitest-environment happy-dom
/**
 * `InlineThought` —— 行间思考块。它自己不存展开态:展开由外面的
 * expansion-intent 记录说了算(受控),点头只是**报告**用户按了一下。
 * 这条约束一旦破,重挂载就会把用户展开的思考默默合上。
 *
 * 另外两件:live 态要一路传到 ThoughtHeader(转圈的和写完的必须一眼分得开),
 * 以及流式期间正文走增量 markdown 管线。
 */
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import InlineThought from '../InlineThought.vue'

vi.mock('@/composables/useMarkdownRenderer', () => ({
  renderMarkdown: (content: string) => `<p>${content}</p>`,
  cleanReasoningContent: (content: string) => content.trim(),
}))

const stubs = {
  MessageMarkdown: {
    props: ['content', 'live', 'isStreaming'],
    template:
      '<div class="md-stub" :data-live="String(live)" :data-streaming="String(isStreaming)">{{ content }}</div>',
  },
}

function mountThought(props: Partial<InstanceType<typeof InlineThought>['$props']> = {}) {
  return mount(InlineThought, {
    props: {
      name: 'reasoning-0',
      // 显式给 `expanded: undefined`(而不是不给):Vue 对**缺省**的 Boolean prop
      // 会强制转成 false,那就成了「受控且恒收起」,和非受控是两回事。
      expanded: undefined,
      content: '  先把问题看清楚,再动手。然后写代码。  ',
      live: false,
      liveMarkdown: false,
      isStreaming: false,
      ...props,
    },
    global: { stubs },
  })
}

describe('InlineThought', () => {
  it('受控:expanded=false 时正文不在场,点头也不自己打开', async () => {
    const w = mountThought({ expanded: false })
    expect(w.find('.inline-reasoning-content').exists()).toBe(false)

    await w.find('.collapse-panel-header').trigger('click')
    await nextTick()
    // 自己不改状态 —— 只把意图报出去。
    expect(w.find('.inline-reasoning-content').exists()).toBe(false)
    expect(w.emitted('update:expanded')?.[0]).toEqual([true])
  })

  it('受控:expanded=true 时正文在场,点头报告收起', async () => {
    const w = mountThought({ expanded: true })
    expect(w.find('.inline-reasoning-content').exists()).toBe(true)

    await w.find('.collapse-panel-header').trigger('click')
    expect(w.emitted('update:expanded')?.[0]).toEqual([false])
  })

  it('外部把 expanded 翻过来,正文跟着进出', async () => {
    const w = mountThought({ expanded: false })
    await w.setProps({ expanded: true })
    expect(w.find('.inline-reasoning-content').exists()).toBe(true)
    await w.setProps({ expanded: false })
    expect(w.find('.inline-reasoning-content').exists()).toBe(false)
  })

  it('expanded 为 undefined 就是非受控:默认收起,点头自己开', async () => {
    const w = mountThought({ expanded: undefined })
    expect(w.find('.inline-reasoning-content').exists()).toBe(false)
    await w.find('.collapse-panel-header').trigger('click')
    await nextTick()
    expect(w.find('.inline-reasoning-content').exists()).toBe(true)
  })

  it('live 态传到 ThoughtHeader,并把面板置为 streaming', async () => {
    const settled = mountThought({ expanded: true })
    expect(settled.find('.thought-header').exists()).toBe(true)
    expect(settled.find('.collapse-panel').classes()).toContain('status-completed')

    const live = mountThought({ expanded: true, live: true })
    expect(live.find('.collapse-panel').classes()).toContain('status-streaming')
    expect(live.find('.collapse-panel').classes()).toContain('is-streaming')
  })

  it('头部摘要是这段思考的第一句,正文是清洗后的内容', () => {
    const w = mountThought({ expanded: true })
    expect(w.find('.thought-detail-text').text()).toBe('先把问题看清楚,再动手。')
    expect(w.find('.md-stub').text()).toBe('先把问题看清楚,再动手。然后写代码。')
  })

  it('isStreaming 时正文走 live markdown 管线', () => {
    const streaming = mountThought({ expanded: true, liveMarkdown: true, isStreaming: true })
    const md = streaming.find('.md-stub')
    expect(md.attributes('data-live')).toBe('true')
    expect(md.attributes('data-streaming')).toBe('true')

    const stat = mountThought({ expanded: true })
    expect(stat.find('.md-stub').attributes('data-live')).toBe('false')
    expect(stat.find('.md-stub').attributes('data-streaming')).toBe('false')
  })
})

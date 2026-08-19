// @vitest-environment happy-dom
/**
 * `ContentPartView` 是「一条 content part → 哪个子组件」的分派表,别无他物。
 * 这里守两件事:每种 part 落到**对的**子组件上,以及导出的
 * `CONTENT_PART_TYPES` 与模板里的分支逐条对得上 —— 那个集合是 MessageBubble
 * 用来筛「哪些 part 归我画」的判据,它和模板一旦走散,part 就会消失在两边的缝里。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ContentPartView, { CONTENT_PART_TYPES } from '../ContentPartView.vue'
import type { ContentPart } from '@/types'

const stubs = {
  MessageMarkdown: {
    props: ['content', 'live', 'isStreaming'],
    template: '<div class="md-stub" :data-live="String(live)">{{ content }}</div>',
  },
  PluginStatusLine: {
    props: ['part'],
    template: '<div class="plugin-status-stub">{{ part.label }}</div>',
  },
  PromptReferenceCard: {
    props: ['title', 'content', 'description'],
    template: '<div class="prompt-ref-stub" :data-title="title">{{ content }}</div>',
  },
}

/** 注释不算渲染 —— 组件顶部那段说明会出现在 html() 里。 */
function renderedMarkup(wrapper: { html(): string }): string {
  return wrapper.html().replace(/<!--[\s\S]*?-->/g, '').trim()
}

function render(part: ContentPart, options: { live?: boolean; isStreaming?: boolean } = {}) {
  return mount(ContentPartView, {
    props: {
      part,
      isUser: false,
      live: options.live ?? false,
      isStreaming: options.isStreaming ?? false,
    },
    global: { stubs },
  })
}

describe('ContentPartView 分派', () => {
  it('text → MessageMarkdown,并把 live 透传下去', () => {
    const w = render({ type: 'text', content: '答案在这' }, { live: true })
    expect(w.find('.content').exists()).toBe(true)
    const md = w.find('.md-stub')
    expect(md.text()).toBe('答案在这')
    expect(md.attributes('data-live')).toBe('true')
  })

  it('image-loading → 骨架,label 落在无障碍名上', () => {
    const w = render({ type: 'image-loading', label: '正在画图' })
    const skeleton = w.find('.image-generation-skeleton')
    expect(skeleton.exists()).toBe(true)
    expect(skeleton.attributes('role')).toBe('status')
    expect(skeleton.attributes('aria-label')).toBe('正在画图')
    // 没给 label 时也得有个说得出口的默认值。
    const fallback = render({ type: 'image-loading' })
    expect(fallback.find('.image-generation-skeleton').attributes('aria-label')).toBe('Generating image')
  })

  it('plugin-status → PluginStatusLine,整条 part 交给它', () => {
    const w = render({
      type: 'plugin-status',
      pluginId: 'demo',
      id: 'job-1',
      label: '后台任务运行中',
    })
    expect(w.find('.plugin-status-stub').text()).toBe('后台任务运行中')
    expect(w.find('.md-stub').exists()).toBe(false)
  })

  it('prompt-ref → PromptReferenceCard,标题取 title', () => {
    const w = render({
      type: 'prompt-ref',
      promptId: 'p1',
      title: '写周报',
      content: '正文',
      description: '每周五',
      bodyHash: 'h1',
    })
    const card = w.find('.prompt-ref-stub')
    expect(card.attributes('data-title')).toBe('写周报')
    expect(card.text()).toBe('正文')
  })

  it('skill-ref → 同一个 PromptReferenceCard,标题取 name(不是 title)', () => {
    const w = render({
      type: 'skill-ref',
      skillId: 's1',
      name: 'pdf-tools',
      description: '处理 PDF',
      source: 'builtin',
      content: '技能正文',
      bodyHash: 'h2',
    } as ContentPart)
    const card = w.find('.prompt-ref-stub')
    expect(card.attributes('data-title')).toBe('pdf-tools')
    expect(card.text()).toBe('技能正文')
  })

  it('不认识的 part 什么都不画(工具行、思考、占位都不归它)', () => {
    for (const part of [
      { type: 'reasoning', content: '想一想' },
      { type: 'data-steps', turnIndex: 0 },
      { type: 'waiting' },
      { type: 'tool-call', toolCalls: [] },
    ] as ContentPart[]) {
      expect(renderedMarkup(render(part))).toBe('')
    }
  })

  it('CONTENT_PART_TYPES 与模板分支逐条一致', () => {
    expect([...CONTENT_PART_TYPES].sort()).toEqual(
      ['image-loading', 'plugin-status', 'prompt-ref', 'skill-ref', 'text'],
    )
    // 声明的每一种都必须真的画出东西来。
    const samples: Record<string, ContentPart> = {
      'text': { type: 'text', content: 'x' },
      'image-loading': { type: 'image-loading' },
      'plugin-status': { type: 'plugin-status', pluginId: 'p', id: 'i', label: 'l' },
      'prompt-ref': { type: 'prompt-ref', promptId: 'p', title: 't', content: 'c', bodyHash: 'h' },
      'skill-ref': {
        type: 'skill-ref', skillId: 's', name: 'n', description: 'd', source: 'builtin', content: 'c', bodyHash: 'h',
      } as ContentPart,
    }
    for (const type of CONTENT_PART_TYPES) {
      expect(renderedMarkup(render(samples[type]))).not.toBe('')
    }
  })
})

// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import { createPinia } from 'pinia'
import StepsPanel from '../StepsPanel.vue'
import { clearExpansionIntents } from '@/stores/helpers/expansion-intent'
import { CHAT_FOLLOW_STATE_KEY } from '@/composables/useFollowScroll'
import {
  MockIntersectionObserver,
  verticalRect,
} from '@/composables/__tests__/intersection-observer-mock'
import type { Step, ToolCall } from '@/types'

function fileStep(id: string, status: Step['status'] = 'completed', turnIndex?: number): Step {
  const toolCall: ToolCall = {
    id,
    toolId: 'edit',
    toolName: 'edit',
    status: status === 'running' ? 'executing' : status === 'awaiting-confirmation' ? 'pending' : status,
    arguments: { path: `/repo/src/${id}.ts` },
    timestamp: 1,
    changes: {
      filePath: `/repo/src/${id}.ts`,
      diff: '@@ -1 +1 @@\n-a\n+b\n',
      additions: 1,
      deletions: 1,
    },
  }

  return {
    id,
    type: 'tool-call',
    title: `edit: /repo/src/${id}.ts`,
    status,
    timestamp: 1,
    turnIndex,
    toolCallId: id,
    toolCall,
  }
}

function readStep(id: string, turnIndex?: number): Step {
  const toolCall: ToolCall = {
    id,
    toolId: 'read',
    toolName: 'read',
    status: 'completed',
    arguments: { filePath: `/repo/src/${id}.ts` },
    timestamp: 1,
  }

  return {
    id,
    type: 'tool-call',
    title: `read: /repo/src/${id}.ts`,
    status: 'completed',
    result: 'const value = 1',
    timestamp: 1,
    turnIndex,
    toolCallId: id,
    toolCall,
  }
}

function commandStep(id: string, command: string): Step {
  const toolCall: ToolCall = {
    id,
    toolId: 'bash',
    toolName: 'bash',
    status: 'completed',
    arguments: { command },
    timestamp: 1,
  }

  return {
    id,
    type: 'command',
    title: `run ${command}`,
    status: 'completed',
    timestamp: 1,
    toolCallId: id,
    toolCall,
  }
}

function runningBashStep(id: string, command: string, turnIndex?: number): Step {
  const toolCall: ToolCall = {
    id,
    toolId: 'bash',
    toolName: 'bash',
    status: 'executing',
    arguments: { command },
    timestamp: 1,
  }

  return {
    id,
    type: 'command',
    title: `run ${command}`,
    status: 'running',
    timestamp: 1,
    turnIndex,
    toolCallId: id,
    toolCall,
  }
}

function variableStep(id: string, value: string): Step {
  const toolCall: ToolCall = {
    id,
    toolId: 'variable',
    toolName: 'variable',
    status: 'completed',
    arguments: {
      action: 'set',
      name: 'workdir',
      value,
    },
    timestamp: 1,
  }

  return {
    id,
    type: 'tool-call',
    title: 'variable',
    status: 'completed',
    timestamp: 1,
    toolCallId: id,
    toolCall,
  }
}

function fartStep(id: string): Step {
  const toolCall: ToolCall = {
    id,
    toolId: 'fart',
    toolName: 'fart',
    status: 'completed',
    arguments: { action: 'fart' },
    timestamp: 1,
  }

  return {
    id,
    type: 'tool-call',
    title: 'fart',
    status: 'completed',
    timestamp: 1,
    toolCallId: id,
    toolCall,
  }
}

function webSearchStep(id: string): Step {
  const toolCall: ToolCall = {
    id,
    toolId: 'web_search',
    toolName: 'web_search',
    status: 'completed',
    arguments: { query: 'collapse panel' },
    timestamp: 1,
  }

  return {
    id,
    type: 'tool-call',
    title: 'web_search',
    status: 'completed',
    timestamp: 1,
    toolCallId: id,
    toolCall,
    partialResult: {
      content: [{ type: 'text', text: 'Search results text fallback' }],
      details: {
        phase: 'ready',
        query: 'collapse panel',
        provider: 'brave',
        resultCount: 1,
        pageCount: 1,
        fetchedPageCount: 1,
        searches: [{
          id: 's1',
          query: 'collapse panel',
          resultCount: 1,
          results: [{
            id: 's1-r1',
            searchId: 's1',
            query: 'collapse panel',
            rank: 1,
            title: 'Collapse Panel Result',
            url: 'https://example.com/collapse-panel',
            snippet: 'Search result rendered inside collapse content.',
            pageId: 'p1',
          }],
        }],
        pages: [{
          id: 'p1',
          resultId: 's1-r1',
          searchId: 's1',
          query: 'collapse panel',
          title: 'Collapse Panel Result',
          url: 'https://example.com/collapse-panel',
          snippet: 'Search result rendered inside collapse content.',
          status: 'ready',
          text: 'Fetched page body for collapse panel result.',
          wordCount: 7,
          fetchMs: 12,
        }],
      },
    },
  }
}

function mountPanel(steps: Step[], pinia = createPinia()) {
  return mount(StepsPanel, {
    props: { steps },
    global: {
      plugins: [pinia],
      stubs: {
        FartCallItem: { template: '<div class="fart-stub" />' },
        ToolActivityDetails: { template: '<div class="detail-stub" />' },
      },
    },
  })
}

function mountPanelWithDetails(steps: Step[], pinia = createPinia()) {
  return mount(StepsPanel, {
    props: { steps },
    global: {
      plugins: [pinia],
      stubs: {
        FartCallItem: { template: '<div class="fart-stub" />' },
      },
    },
  })
}

describe('StepsPanel interaction contract', () => {
  it('renders grouped and single tool calls through collapse panels', async () => {
    const grouped = mountPanel([fileStep('a', 'completed', 1), fileStep('b', 'completed', 1)])

    expect(grouped.find('.tool-activity-timeline').classes()).toContain('collapse-group')
    expect(grouped.find('.workflow-group').classes()).toContain('collapse-panel')
    expect(grouped.find('.workflow-group').classes()).toContain('variant-plain')
    expect(grouped.find('.workflow-group').classes()).toContain('icon-inline-end')
    expect(grouped.find('.workflow-group > .collapse-panel-header > .collapse-panel-title .collapse-panel-icon').exists()).toBe(true)
    await grouped.find('.group-header').trigger('click')
    expect(grouped.find('.operation-block').classes()).toContain('collapse-panel')
    expect(grouped.find('.operation-block').classes()).toContain('variant-plain')
    expect(grouped.find('.operation-block').classes()).toContain('icon-inline-end')
    expect(grouped.find('.operation-block > .collapse-panel-header > .collapse-panel-title .collapse-panel-icon').exists()).toBe(true)

    const single = mountPanel([readStep('single')])
    expect(single.find('.operation-block').classes()).toContain('collapse-panel')
    expect(single.find('.operation-block').classes()).toContain('variant-plain')
    expect(single.find('.operation-block').classes()).toContain('icon-inline-end')
  })

  it('wraps special tool-call renderers in a collapse panel shell', () => {
    const wrapper = mountPanel([fartStep('fart')])

    expect(wrapper.find('.fart-panel').classes()).toContain('collapse-panel')
    expect(wrapper.find('.fart-stub').exists()).toBe(true)
  })

  it('renders web search results through the shared collapse content panel', async () => {
    const wrapper = mountPanelWithDetails([webSearchStep('web')])
    const operation = wrapper.find('.operation-block')

    expect(operation.classes()).toContain('collapse-panel')
    expect(operation.classes()).toContain('variant-plain')
    expect(operation.find('.node-action').text()).toBe('WebSearch')
    expect(operation.find('.node-target-name').text()).toBe('"collapse panel"')
    expect(wrapper.find('.activity-inline-details').exists()).toBe(false)

    await operation.find('.node-target-name').trigger('click')

    const details = wrapper.find('.activity-inline-details')
    expect(details.exists()).toBe(true)
    expect(details.classes()).toContain('collapse-panel-content')
    expect(details.find('.web-search-result').exists()).toBe(true)
    expect(details.find('.web-search-summary').exists()).toBe(true)
    expect(details.find('.details-content-wrapper').exists()).toBe(false)
  })

  it('expands read details when clicking a file-link target name', async () => {
    const wrapper = mountPanel([readStep('a')])

    await wrapper.find('.node-target-name.file-link').trigger('click')

    expect(wrapper.emitted('open-file')).toBeUndefined()
    expect(wrapper.find('.activity-inline-details').exists()).toBe(true)
    expect(wrapper.find('.activity-inline-details').classes()).toContain('collapse-panel-content')
    expect(wrapper.find('.details-content-wrapper').exists()).toBe(false)
  })

  it('toggles a nested operation from its own expand icon without collapsing the group', async () => {
    const wrapper = mountPanel([fileStep('a', 'completed', 1), fileStep('b', 'completed', 1)])

    await wrapper.find('.workflow-group > .collapse-panel-header').trigger('click')
    expect(wrapper.find('.workflow-group').classes()).toContain('is-expanded')

    const operation = wrapper.find('.operation-block')
    const operationIcon = operation.find('.collapse-panel-icon')

    await operationIcon.trigger('click')

    expect(wrapper.find('.workflow-group').classes()).toContain('is-expanded')
    expect(operation.classes()).toContain('is-expanded')
    expect(wrapper.find('.activity-inline-details').exists()).toBe(true)

    await operationIcon.trigger('click')

    expect(wrapper.find('.workflow-group').classes()).toContain('is-expanded')
    expect(operation.classes()).not.toContain('is-expanded')
    expect(wrapper.find('.activity-inline-details').exists()).toBe(false)
  })

  it('keeps an activity expanded when its group grows from 1 to 2', async () => {
    const wrapper = mountPanel([fileStep('a', 'completed', 1)])

    await wrapper.find('.operation-row').trigger('click')
    expect(wrapper.find('.activity-inline-details').exists()).toBe(true)

    await wrapper.setProps({ steps: [fileStep('a', 'completed', 1), fileStep('b', 'completed', 1)] })

    expect(wrapper.find('.workflow-group').classes()).toContain('is-expanded')
    expect(wrapper.find('.activity-inline-details').exists()).toBe(true)
  })

  it('shows failure summary in the grouped operation title row', () => {
    const failed = fileStep('c', 'failed', 1)
    failed.error = 'No match found'
    failed.toolCall!.status = 'failed'

    const wrapper = mountPanel([fileStep('a', 'completed', 1), failed])

    expect(wrapper.find('.operation-failure').exists()).toBe(false)
    expect(wrapper.find('.node-error-summary').exists()).toBe(true)
    expect(wrapper.find('.node-error-summary').text()).toContain('No match found')
  })

  it('summarizes a failed batch with a Failed badge and summed stats', () => {
    const failed = fileStep('c', 'failed', 1)
    failed.error = 'No match found'
    failed.toolCall!.status = 'failed'

    const wrapper = mountPanel([fileStep('a', 'completed', 1), failed])

    expect(wrapper.find('.group-summary-text').text()).toBe('2 tools')
    expect(wrapper.find('.group-status-badge.failed').text()).toBe('Failed')
    expect(wrapper.find('.workflow-group > .collapse-panel-header .collapse-panel-icon').exists()).toBe(true)
  })

  it('summarizes a completed batch as N tools with summed diff stats', () => {
    const wrapper = mountPanel([fileStep('a', 'completed', 1), fileStep('b', 'completed', 1)])

    expect(wrapper.find('.group-summary-text').text()).toBe('2 tools')
    expect(wrapper.find('.group-status-badge').exists()).toBe(false)
    expect(wrapper.find('.group-stat.addition').text()).toBe('+2')
    expect(wrapper.find('.group-stat.deletion').text()).toBe('-2')
    expect(wrapper.find('.workflow-group > .collapse-panel-header .collapse-panel-icon').exists()).toBe(true)
  })

  it('never groups sequential calls from different turns', () => {
    const wrapper = mountPanel([readStep('a', 1), readStep('b', 2)])

    expect(wrapper.find('.workflow-group').exists()).toBe(false)
    expect(wrapper.findAll('.operation-row')).toHaveLength(2)
  })

  it('never groups steps without a turn index', () => {
    const wrapper = mountPanel([readStep('a'), readStep('b')])

    expect(wrapper.find('.workflow-group').exists()).toBe(false)
    expect(wrapper.findAll('.operation-row')).toHaveLength(2)
  })

  it('uses a trailing disclosure group header and renders tool icons on every row', async () => {
    const wrapper = mountPanel([fileStep('a', 'completed', 1), fileStep('b', 'completed', 1)])

    expect(wrapper.find('.workflow-group > .collapse-panel-header .collapse-panel-icon').exists()).toBe(true)
    expect(wrapper.find('.group-header .group-chevron').exists()).toBe(false)
    expect(wrapper.find('.group-header .group-icons .tool-icon').exists()).toBe(true)
    await wrapper.find('.group-header').trigger('click')
    expect(wrapper.findAll('.operation-row .tool-icon')).toHaveLength(2)
  })

  it('reflects active and awaiting statuses on the row tool icon', () => {
    const running = fileStep('run', 'running')
    const awaiting = fileStep('needs-approval', 'awaiting-confirmation')
    awaiting.toolCall!.requiresConfirmation = true

    const wrapper = mountPanel([running, awaiting])

    expect(wrapper.find('.operation-row.status-executing .tool-icon.icon-executing').exists()).toBe(true)
    expect(wrapper.find('.operation-row.status-executing .node-action.is-flowing').exists()).toBe(true)
    expect(wrapper.find('.operation-row.status-awaiting-confirmation .tool-icon.icon-awaiting-confirmation').exists()).toBe(true)
    expect(wrapper.find('.operation-row.status-awaiting-confirmation .node-status-badge').text()).toBe('Needs approval')
  })

  it('does not render inline approval controls for awaiting-confirmation rows', () => {
    const awaiting = fileStep('needs-approval', 'awaiting-confirmation')
    awaiting.toolCall!.requiresConfirmation = true

    const wrapper = mountPanel([awaiting])

    expect(wrapper.find('.row-review-btn').exists()).toBe(false)
    expect(wrapper.find('.operation-row .node-target').attributes('aria-label')).toBe('Edit(needs-approval.ts)')
    expect(wrapper.find('.operation-row .node-meta').exists()).toBe(false)
  })

  it('renders the tool name and full command as separate structured parts', () => {
    const wrapper = mountPanel([commandStep('luac-check', 'luac -p nlp_test.lua')])

    const row = wrapper.find('.operation-row')
    expect(row.find('.node-target').attributes('aria-label')).toBe('Bash(luac -p nlp_test.lua)')
    expect(row.find('.node-action').text()).toBe('Bash')
    expect(row.find('.node-target-name').text()).toBe('luac -p nlp_test.lua')
    expect(row.find('.node-target-name').classes()).toContain('command-chip')
  })

  it('renders variable target metadata in the row meta slot', () => {
    const wrapper = mountPanel([variableStep('set-workdir', '/Users/me/project')])

    expect(wrapper.find('.operation-row .node-target').attributes('aria-label')).toBe('Variable(workdir)')
    expect(wrapper.find('.operation-row .node-action').text()).toBe('Variable')
    expect(wrapper.find('.operation-row .node-target-name').text()).toBe('workdir')
    expect(wrapper.find('.operation-row .node-meta').text()).toBe('= /Users/me/project')
  })

  it('does not render the inspector link action in operation rows', () => {
    const wrapper = mountPanel([fileStep('a')])

    expect(wrapper.find('.operation-inspector-btn').exists()).toBe(false)
  })
})

// 并行批次不自动展开(T1)。10 个并行 bash 同时弹开 10 个图纸框、跑完再逐个
// 合上,是流式期间最大的一个布局抖动源;而 RUNNING 阶段框里只有一行 `$ 命令`,
// 与行标题完全重复。所以"executing 自动展开"只对单发生效。
describe('StepsPanel parallel-batch auto expansion', () => {
  it('does not auto-expand running bash rows inside a parallel batch', () => {
    const wrapper = mountPanel([
      runningBashStep('a', 'sleep 1', 7),
      runningBashStep('b', 'sleep 2', 7),
    ])

    expect(wrapper.find('.workflow-group').exists()).toBe(true)
    expect(wrapper.findAll('.operation-row')).toHaveLength(2)
    expect(wrapper.find('.activity-inline-details').exists()).toBe(false)
  })

  it('does not auto-expand a lone running bash either', () => {
    const wrapper = mountPanel([runningBashStep('solo', 'sleep 1', 7)])

    expect(wrapper.find('.workflow-group').exists()).toBe(false)
    expect(wrapper.find('.activity-inline-details').exists()).toBe(false)
  })

  it('suppresses batch auto-expansion in flat rail mode as well', () => {
    const wrapper = mount(StepsPanel, {
      props: {
        steps: [runningBashStep('a', 'sleep 1', 7), runningBashStep('b', 'sleep 2', 7)],
        flat: true,
      },
      global: {
        plugins: [createPinia()],
        stubs: {
          FartCallItem: { template: '<div class="fart-stub" />' },
          ToolActivityDetails: { template: '<div class="detail-stub" />' },
        },
      },
    })

    expect(wrapper.find('.workflow-group').exists()).toBe(false)
    expect(wrapper.findAll('.operation-row')).toHaveLength(2)
    expect(wrapper.find('.activity-inline-details').exists()).toBe(false)
  })

  it('keeps a failed edit expanded even inside a parallel batch', () => {
    const failed = fileStep('c', 'failed', 7)
    failed.error = 'No match found'
    failed.toolCall!.status = 'failed'

    const wrapper = mountPanel([runningBashStep('a', 'sleep 1', 7), failed])

    // Exactly one open pane, and it belongs to the failure — not to the bash.
    expect(wrapper.findAll('.activity-inline-details')).toHaveLength(1)
    expect(wrapper.findAll('.operation-block.is-expanded')).toHaveLength(1)
    expect(wrapper.find('.operation-block.is-expanded').classes()).toContain('status-failed')
  })

  it('keeps an awaiting-confirmation edit expanded inside a parallel batch', () => {    const awaiting = fileStep('needs-approval', 'awaiting-confirmation', 7)
    awaiting.toolCall!.requiresConfirmation = true

    const wrapper = mountPanel([runningBashStep('a', 'sleep 1', 7), awaiting])

    expect(wrapper.findAll('.operation-block.is-expanded')).toHaveLength(1)
    expect(wrapper.find('.operation-block.is-expanded').classes())
      .toContain('status-awaiting-confirmation')
  })
})

// 详情面板自己合上(bash 跑完)也是"自动"塌缩:发生在视口顶之上时必须把塌掉
// 的高度还给 scrollTop。用户自己点收起不补偿。
describe('StepsPanel auto-collapse scroll compensation', () => {
  const ROW_TOP = -300
  const ROW_OPEN_BOTTOM = -20
  const ROW_FOLDED_BOTTOM = -180

  function domRect(top: number, bottom: number): DOMRect {
    return {
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect
  }

  function setupPanel(steps: Step[], startScrollTop = 900) {
    let scrollTop = startScrollTop

    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    Object.defineProperty(scroller, 'scrollHeight', { value: 4000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = next
      },
    })
    scroller.getBoundingClientRect = () => domRect(0, 800)

    const host = document.createElement('div')
    scroller.appendChild(host)
    document.body.appendChild(scroller)

    const wrapper = mount(StepsPanel, {
      props: { steps, intentScope: 'steps-m1' },
      attachTo: host,
      global: {
        plugins: [createPinia()],
        stubs: {
          FartCallItem: { template: '<div class="fart-stub" />' },
          ToolActivityDetails: { template: '<div class="detail-stub" />' },
        },
      },
    })

    // 行高跟着真实 DOM 状态走:详情面板在 = 280px,合上 = 120px。
    const row = wrapper.find('[data-activity-panel-key]').element as HTMLElement
    row.getBoundingClientRect = () =>
      domRect(ROW_TOP, row.querySelector('.activity-inline-details') ? ROW_OPEN_BOTTOM : ROW_FOLDED_BOTTOM)

    return {
      wrapper,
      getScrollTop: () => scrollTop,
      cleanup: () => {
        wrapper.unmount()
        scroller.remove()
      },
    }
  }

  afterEach(() => {
    clearExpansionIntents()
    document.body.innerHTML = ''
  })

  it('gives back the folded height when a resolved edit settles above the viewport', async () => {
    const panel = setupPanel([fileStep('a', 'awaiting-confirmation', 7)])
    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(true)

    await panel.wrapper.setProps({ steps: [fileStep('a', 'completed', 7)] })
    await nextTick()
    await nextTick()

    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(false)
    expect(panel.getScrollTop()).toBe(900 - 160)
    panel.cleanup()
  })

  it('does not compensate when the user folds the row themselves', async () => {
    const panel = setupPanel([fileStep('a', 'awaiting-confirmation', 7)])
    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(true)

    await panel.wrapper.find('.operation-row').trigger('click')
    await nextTick()
    await nextTick()

    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(false)
    expect(panel.getScrollTop()).toBe(900)
    panel.cleanup()
  })
})

// 补偿只兜"塌缩在视口顶之上"。行就在眼前时(用户正读着 bash 的输出),
// 合上等于把眼前的东西抽走 —— 那时候先挂起,别收。
describe('StepsPanel auto-collapse visibility gate', () => {
  // 展开时整行在视口里(200..480),合上后 200..240。
  const ROW_TOP = 200
  const ROW_OPEN_BOTTOM = 480
  const ROW_FOLDED_BOTTOM = 240

  function setupVisiblePanel(steps: Step[], options: { following?: boolean } = {}) {
    const following = ref(options.following ?? false)

    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    Object.defineProperty(scroller, 'scrollHeight', { value: 4000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true })
    scroller.getBoundingClientRect = () => verticalRect(0, 800)

    const host = document.createElement('div')
    scroller.appendChild(host)
    document.body.appendChild(scroller)

    const wrapper = mount(StepsPanel, {
      props: { steps, intentScope: 'steps-gate' },
      attachTo: host,
      global: {
        plugins: [createPinia()],
        provide: { [CHAT_FOLLOW_STATE_KEY as symbol]: computed(() => following.value) },
        stubs: {
          FartCallItem: { template: '<div class="fart-stub" />' },
          ToolActivityDetails: { template: '<div class="detail-stub" />' },
        },
      },
    })

    const row = wrapper.find('[data-activity-panel-key]').element as HTMLElement
    row.getBoundingClientRect = () =>
      verticalRect(ROW_TOP, row.querySelector('.activity-inline-details') ? ROW_OPEN_BOTTOM : ROW_FOLDED_BOTTOM)

    return {
      wrapper,
      following,
      cleanup: () => {
        wrapper.unmount()
        scroller.remove()
      },
    }
  }

  beforeEach(() => {
    clearExpansionIntents()
    MockIntersectionObserver.reset()
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearExpansionIntents()
    document.body.innerHTML = ''
  })

  it('keeps a settled row open while the user is looking at it', async () => {
    const panel = setupVisiblePanel([fileStep('a', 'awaiting-confirmation', 7)])
    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(true)

    await panel.wrapper.setProps({ steps: [fileStep('a', 'completed', 7)] })
    await nextTick()

    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(true)
    expect(MockIntersectionObserver.instances).toHaveLength(1)
    panel.cleanup()
  })

  it('folds the row once it scrolls out of the viewport', async () => {
    const panel = setupVisiblePanel([fileStep('a', 'awaiting-confirmation', 7)])
    await panel.wrapper.setProps({ steps: [fileStep('a', 'completed', 7)] })
    await nextTick()
    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(true)

    MockIntersectionObserver.last.emit(false)
    await nextTick()

    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(false)
    expect(MockIntersectionObserver.allDisconnected()).toBe(true)
    panel.cleanup()
  })

  it('folds the row once the user is pinned to the bottom again', async () => {
    const panel = setupVisiblePanel([fileStep('a', 'awaiting-confirmation', 7)])
    await panel.wrapper.setProps({ steps: [fileStep('a', 'completed', 7)] })
    await nextTick()
    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(true)

    panel.following.value = true
    await nextTick()

    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(false)
    panel.cleanup()
  })

  it('folds immediately while following the bottom — the gate never engages', async () => {
    const panel = setupVisiblePanel([fileStep('a', 'awaiting-confirmation', 7)], { following: true })

    await panel.wrapper.setProps({ steps: [fileStep('a', 'completed', 7)] })
    await nextTick()

    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(false)
    expect(MockIntersectionObserver.instances).toHaveLength(0)
    panel.cleanup()
  })

  it('lets a manual toggle cancel the pending fold', async () => {
    const panel = setupVisiblePanel([fileStep('a', 'awaiting-confirmation', 7)])
    await panel.wrapper.setProps({ steps: [fileStep('a', 'completed', 7)] })
    await nextTick()
    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(true)

    await panel.wrapper.find('.operation-row').trigger('click')
    await nextTick()

    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(false)
    expect(MockIntersectionObserver.allDisconnected()).toBe(true)

    // 挂起已作废:陈旧回调不得压过用户重新展开的意图。
    await panel.wrapper.find('.operation-row').trigger('click')
    MockIntersectionObserver.last.emit(false)
    await nextTick()
    expect(panel.wrapper.find('.activity-inline-details').exists()).toBe(true)
    panel.cleanup()
  })

  it('drops the pending fold on unmount', async () => {
    const panel = setupVisiblePanel([fileStep('a', 'awaiting-confirmation', 7)])
    await panel.wrapper.setProps({ steps: [fileStep('a', 'completed', 7)] })
    await nextTick()
    expect(MockIntersectionObserver.instances).toHaveLength(1)

    panel.cleanup()

    expect(MockIntersectionObserver.allDisconnected()).toBe(true)
  })
})

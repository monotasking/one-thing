// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import MessageBubble from '../MessageBubble.vue'
import StreamingCodeBlock from '../StreamingCodeBlock.vue'
import StreamingMarkdown from '../StreamingMarkdown.vue'
import StepsPanel from '../../StepsPanel.vue'
import type { ChatMessage, ContentPart, MessageAttachment, Step, ToolCall } from '@/types'
import { clearStreamingContentCache } from '@/stores/helpers/tool-step-view'

const platformApiMock = vi.hoisted(() => ({
  openImagePreview: vi.fn(),
  openImageGallery: vi.fn(),
}))

vi.mock('@/platform', () => ({
  platformApi: platformApiMock,
}))

function installRaf() {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number,
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
}

function installLocalStorage() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key)
    }),
    clear: vi.fn(() => {
      values.clear()
    }),
  })
}

async function advance(ms = 20) {
  await vi.advanceTimersByTimeAsync(ms)
  await nextTick()
}

const markdownStubs = {
  StreamingMarkdown: {
    name: 'StreamingMarkdown',
    props: ['content', 'isUser', 'isStreaming'],
    template: '<div data-renderer="streaming" :data-streaming="String(isStreaming)">{{ content }}</div>',
  },
  StaticMarkdown: {
    name: 'StaticMarkdown',
    props: ['content', 'isUser'],
    template: '<div data-renderer="static">{{ content }}</div>',
  },
  StepsPanel: { template: '<div />' },
  TextEditor: { template: '<textarea />' },
}

// Same stubs, but with the REAL StepsPanel: the key-stability assertions are
// about which DOM node survives inside it.
const { StepsPanel: _stubbedStepsPanel, ...markdownStubsBase } = markdownStubs
const toolTimelineStubs = {
  ...markdownStubsBase,
  ToolStepDetails: { template: '<div class="detail-stub" />' },
}

const messageItemStubs = {
  ...markdownStubs,
  ImagePreview: { template: '<div />' },
  MessageActions: { template: '<div />' },
  MessageError: { template: '<div />' },
  MessageSystem: { template: '<div />' },
  MessageThinking: { template: '<div />' },
  SelectionToolbar: { template: '<div />' },
}

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc1',
    toolId: 'edit',
    toolName: 'edit',
    arguments: { path: '/tmp/a.ts' },
    status: 'pending',
    timestamp: 0,
    changes: {
      diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n',
      filePath: '/tmp/a.ts',
      additions: 1,
      deletions: 1,
    },
    ...overrides,
  }
}

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: 'step1',
    type: 'tool-call',
    title: 'edit',
    status: 'awaiting-confirmation',
    timestamp: 0,
    toolCallId: 'tc1',
    toolCall: toolCall({ requiresConfirmation: true }),
    ...overrides,
  }
}

function imageAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: 'img1',
    fileName: 'screenshot.png',
    mimeType: 'image/png',
    size: 12,
    mediaType: 'image',
    base64Data: 'abc123',
    ...overrides,
  }
}

function fileAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: 'file1',
    fileName: 'notes.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    mediaType: 'document',
    base64Data: 'pdf123',
    ...overrides,
  }
}

describe('stream end visual stability', () => {
  beforeEach(() => {
    // MessageItem reads the chat store (steering retraction state) at setup.
    setActivePinia(createPinia())
    installRaf()
    installLocalStorage()
    clearStreamingContentCache()
    platformApiMock.openImagePreview.mockReset()
    platformApiMock.openImageGallery.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps freshly streamed assistant text on StreamingMarkdown after stream complete', async () => {
    const parts: ContentPart[] = [{ type: 'text', content: 'Hello there' }]
    const wrapper = mount(MessageBubble, {
      props: {
        role: 'assistant',
        content: 'Hello there',
        contentParts: parts,
        isStreaming: true,
      },
      global: { stubs: markdownStubs },
    })

    expect(wrapper.find('[data-renderer="streaming"]').exists()).toBe(true)
    expect(wrapper.find('[data-renderer="static"]').exists()).toBe(false)

    await wrapper.setProps({ isStreaming: false })
    await nextTick()

    expect(wrapper.find('[data-renderer="streaming"]').exists()).toBe(true)
    expect(wrapper.find('[data-renderer="streaming"]').attributes('data-streaming')).toBe('false')
    expect(wrapper.find('[data-renderer="static"]').exists()).toBe(false)
  })

  it('uses StaticMarkdown for cold completed assistant messages', () => {
    const parts: ContentPart[] = [{ type: 'text', content: 'Already complete' }]
    const wrapper = mount(MessageBubble, {
      props: {
        role: 'assistant',
        content: 'Already complete',
        contentParts: parts,
        isStreaming: false,
      },
      global: { stubs: markdownStubs },
    })

    expect(wrapper.find('[data-renderer="static"]').exists()).toBe(true)
    expect(wrapper.find('[data-renderer="streaming"]').exists()).toBe(false)
  })

  it('keeps word wrappers during settling and removes new-word animation classes', async () => {
    const wrapper = mount(StreamingMarkdown, {
      props: {
        content: 'Hello streaming world',
        isUser: false,
        isStreaming: true,
      },
    })
    await nextTick()

    expect(wrapper.findAll('[data-stream-word]').length).toBeGreaterThan(0)
    expect(wrapper.findAll('.stream-word.is-new').length).toBeGreaterThan(0)

    await wrapper.setProps({ isStreaming: false })
    await advance()

    expect(wrapper.findAll('[data-stream-word]').length).toBeGreaterThan(0)
    expect(wrapper.findAll('.stream-word.is-new')).toHaveLength(0)

    await advance(240)
    expect(wrapper.findAll('[data-stream-word]')).toHaveLength(0)
  })

  it('renders live markdown while preserving unchanged streamed DOM nodes', async () => {
    const wrapper = mount(StreamingMarkdown, {
      props: {
        content: '## Title\nHello **world** [docs](https://example.com)\n- first item',
        isUser: false,
        isStreaming: true,
      },
    })
    await nextTick()

    expect(wrapper.find('h2').text()).toBe('Title')
    expect(wrapper.find('a').attributes('href')).toBe('https://example.com')
    expect(wrapper.find('li').text()).toContain('first item')

    const paragraph = wrapper.find('p').element
    const strong = wrapper.find('strong').element
    const firstWord = wrapper.find('[data-stream-word]').element

    expect(wrapper.find('strong').text()).toBe('world')
    expect(wrapper.findAll('[data-stream-word]').length).toBeGreaterThan(0)

    await wrapper.setProps({
      content: '## Title\nHello **world** [docs](https://example.com)\n- first item again',
    })
    await advance(80)

    expect(wrapper.text()).toContain('again')
    expect(wrapper.find('p').element).toBe(paragraph)
    expect(wrapper.find('strong').element).toBe(strong)
    expect(wrapper.find('[data-stream-word]').element).toBe(firstWord)
    const newWords = wrapper.findAll('.stream-word.is-new').map(word => word.text())
    expect(newWords).toContain('again')
    expect(newWords).not.toContain('Hello')
    expect(newWords).not.toContain('world')
  })

  it('does not replace unchanged code line nodes when complete flips true', async () => {
    const wrapper = mount(StreamingCodeBlock, {
      props: {
        lang: 'ts',
        content: 'const a = 1\nconst b = 2',
        complete: false,
        isStreaming: true,
      },
    })
    await nextTick()
    await advance()

    const before = wrapper.findAll('[data-code-line]').map(line => line.element)
    await wrapper.setProps({ complete: true, isStreaming: false })
    await advance()
    const after = wrapper.findAll('[data-code-line]').map(line => line.element)

    expect(after).toHaveLength(before.length)
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
  })

  it('groups tool calls issued in the same turn', async () => {
    const wrapper = mount(StepsPanel, {
      props: {
        steps: [
          step({ id: 'step1', title: 'edit', turnIndex: 1, toolCall: toolCall({ id: 'tc1', toolName: 'edit' }) }),
          step({ id: 'step2', title: 'edit', turnIndex: 1, toolCall: toolCall({ id: 'tc2', toolName: 'edit' }) }),
        ],
      },
      global: {
        stubs: {
        },
      },
    })
    await nextTick()

    const groups = wrapper.findAll('.workflow-group')
    expect(groups).toHaveLength(1)
    expect(groups[0].find('.group-header-anchor > .group-header').exists()).toBe(true)
    expect(wrapper.find('.group-summary-text').text()).toBe('2 tools')
    expect(wrapper.find('.group-icons .tool-icon').exists()).toBe(true)
    expect(wrapper.find('.group-type-icon').exists()).toBe(false)
    expect(wrapper.find('.group-final-result').exists()).toBe(false)
  })

  it('does not group same-tool calls from different turns', async () => {
    const wrapper = mount(StepsPanel, {
      props: {
        steps: [
          step({ id: 'step1', title: 'edit', turnIndex: 1, toolCall: toolCall({ id: 'tc1', toolName: 'edit' }) }),
          step({ id: 'step2', title: 'edit', turnIndex: 2, toolCall: toolCall({ id: 'tc2', toolName: 'edit' }) }),
        ],
      },
      global: {
        stubs: {
        },
      },
    })
    await nextTick()

    expect(wrapper.findAll('.workflow-group')).toHaveLength(0)
    expect(wrapper.findAll('.operation-row')).toHaveLength(2)
  })

  it('does not repeat diff stats in expanded operation metadata', async () => {
    const wrapper = mount(StepsPanel, {
      props: {
        steps: [
          step({
            id: 'step1',
            status: 'completed',
            turnIndex: 1,
            toolCall: toolCall({ id: 'tc1', toolName: 'edit', status: 'completed', requiresConfirmation: false }),
          }),
          step({
            id: 'step2',
            status: 'completed',
            turnIndex: 1,
            toolCall: toolCall({ id: 'tc2', toolName: 'edit', status: 'completed', requiresConfirmation: false }),
          }),
        ],
      },
      global: {
        stubs: {
        },
      },
    })
    await nextTick()

    await wrapper.find('.group-header').trigger('click')
    await nextTick()

    const meta = wrapper.find('.tree-node-row .node-meta').text()
    expect(meta).toBe('+1 -1')
    expect(meta).not.toContain('(+1 -1)')
  })

  it('toggles collapsed and expanded states on click', async () => {
    const wrapper = mount(StepsPanel, {
      props: {
        steps: [
          step({
            id: 'step1',
            status: 'completed',
            turnIndex: 1,
            toolCall: toolCall({ id: 'tc1', status: 'completed', requiresConfirmation: false }),
          }),
          step({
            id: 'step2',
            status: 'completed',
            turnIndex: 1,
            toolCall: toolCall({ id: 'tc2', status: 'completed', requiresConfirmation: false }),
          }),
        ],
      },
      global: {
        stubs: {
        },
      },
    })
    await nextTick()

    expect(wrapper.find('.workflow-group').classes()).not.toContain('is-expanded')
    expect(wrapper.find('.group-timeline-tree').exists()).toBe(false)

    await wrapper.find('.group-header').trigger('click')
    await nextTick()

    expect(wrapper.find('.workflow-group').classes()).toContain('is-expanded')
    expect(wrapper.find('.group-timeline-tree').exists()).toBe(true)

    await wrapper.find('.group-header').trigger('click')
    await nextTick()

    expect(wrapper.find('.workflow-group').classes()).not.toContain('is-expanded')
    expect(wrapper.find('.group-timeline-tree').exists()).toBe(false)
  })

  it('renders vertical timeline checklist with node content when expanded', async () => {
    const wrapper = mount(StepsPanel, {
      props: {
        steps: [
          step({
            id: 'step1',
            status: 'completed',
            turnIndex: 1,
            toolCall: toolCall({ id: 'tc1', toolName: 'write', status: 'completed', requiresConfirmation: false }),
          }),
          step({
            id: 'step2',
            status: 'completed',
            turnIndex: 1,
            toolCall: toolCall({ id: 'tc2', toolName: 'write', status: 'completed', requiresConfirmation: false }),
          }),
        ],
      },
      global: {
        stubs: {
        },
      },
    })
    await nextTick()

    await wrapper.find('.group-header').trigger('click')
    await nextTick()

    const nodes = wrapper.findAll('.tree-node-row')
    expect(nodes).toHaveLength(2)
    expect(nodes[0].find('.node-target').attributes('aria-label')).toBe('Write(a.ts)')
    expect(nodes[0].find('.node-action').text().trim()).toBe('Write')
    expect(nodes[0].find('.node-target-name').text()).toBe('a.ts')
    expect(nodes[0].find('.node-target-name').classes()).toContain('file-link')
  })

  it('expands inline details when a step node is clicked', async () => {
    const wrapper = mount(StepsPanel, {
      props: {
        steps: [
          step({
            id: 'step1',
            status: 'completed',
            turnIndex: 1,
            toolCall: toolCall({ id: 'tc1', toolName: 'write', status: 'completed', requiresConfirmation: false }),
          }),
          step({
            id: 'step2',
            status: 'completed',
            turnIndex: 1,
            toolCall: toolCall({ id: 'tc2', toolName: 'write', status: 'completed', requiresConfirmation: false }),
          }),
        ],
      },
      global: {
        stubs: {
        },
      },
    })
    await nextTick()

    await wrapper.find('.group-header').trigger('click')
    await nextTick()

    await wrapper.find('.tree-node-row .node-target').trigger('click')
    await nextTick()

    expect(wrapper.find('.activity-inline-details').exists()).toBe(true)
  })

  it('shows failed tool summaries in groups and opens the failed edit detail', async () => {
    const wrapper = mount(StepsPanel, {
      props: {
        steps: [
          step({
            id: 'failed-edit-1',
            status: 'failed',
            turnIndex: 1,
            error: 'No matching text found in file',
            toolCall: toolCall({
              id: 'tc-failed-edit-1',
              toolName: 'edit',
              status: 'failed',
              requiresConfirmation: false,
              changes: undefined,
              arguments: { path: '/tmp/project/src/app.ts' },
            }),
          }),
          step({
            id: 'failed-edit-2',
            status: 'failed',
            turnIndex: 1,
            error: 'No matching text found in file',
            toolCall: toolCall({
              id: 'tc-failed-edit-2',
              toolName: 'edit',
              status: 'failed',
              requiresConfirmation: false,
              changes: undefined,
              arguments: { path: '/tmp/project/src/other.ts' },
            }),
          }),
        ],
      },
      global: {
        stubs: {
        },
      },
    })
    await nextTick()

    expect(wrapper.find('.workflow-group').classes()).toContain('is-expanded')
    expect(wrapper.findAll('.tree-node-row')).toHaveLength(2)
    expect(wrapper.findAll('.operation-failure')).toHaveLength(0)
    expect(wrapper.findAll('.node-error-summary')).toHaveLength(2)
    expect(wrapper.find('.node-error-summary').text()).toContain('No matching text found')
    // A failed edit opens itself: the engine reply carries the current file
    // text around the spot that did not match.
    expect(wrapper.findAll('.activity-inline-details')).toHaveLength(2)
  })

  it('keeps expanded tool calls when reopening a group', async () => {
    const wrapper = mount(StepsPanel, {
      props: {
        steps: [
          step({
            id: 'write-1',
            status: 'completed',
            turnIndex: 1,
            toolCall: toolCall({
              id: 'tc-write-1',
              toolName: 'write',
              status: 'completed',
              requiresConfirmation: false,
            }),
          }),
          step({
            id: 'write-2',
            status: 'completed',
            turnIndex: 1,
            toolCall: toolCall({
              id: 'tc-write-2',
              toolName: 'write',
              status: 'completed',
              requiresConfirmation: false,
            }),
          }),
        ],
      },
      global: {
        stubs: {
        },
      },
    })
    await nextTick()

    await wrapper.find('.group-header').trigger('click')
    await nextTick()
    await wrapper.find('.tree-node-row .node-target').trigger('click')
    await nextTick()

    expect(wrapper.find('.activity-inline-details').exists()).toBe(true)

    await wrapper.find('.group-header').trigger('click')
    await nextTick()
    await wrapper.find('.group-header').trigger('click')
    await nextTick()

    expect(wrapper.findAll('.tree-node-row')).toHaveLength(2)
    expect(wrapper.find('.activity-inline-details').exists()).toBe(true)
  })

  it('renders as a single flat row when there is only one tool call and expands it inline', async () => {
    const wrapper = mount(StepsPanel, {
      props: {
        steps: [
          step({
            id: 'step1',
            status: 'completed',
            toolCall: toolCall({ id: 'tc1', toolName: 'write', status: 'completed', requiresConfirmation: false }),
          }),
        ],
      },
      global: {
        stubs: {
        },
      },
    })
    await nextTick()

    expect(wrapper.find('.operation-row').exists()).toBe(true)
    expect(wrapper.find('.workflow-group').exists()).toBe(false)
    expect(wrapper.find('.operation-row .node-target').attributes('aria-label')).toBe('Write(a.ts)')
    expect(wrapper.find('.operation-row .node-action').text().trim()).toBe('Write')
    expect(wrapper.find('.operation-row .node-target-name').text()).toBe('a.ts')

    await wrapper.find('.operation-row .node-target').trigger('click')
    await nextTick()

    expect(wrapper.find('.activity-inline-details').exists()).toBe(true)
  })

  it('renders failed edit rows with filename and compact reason', async () => {
    const wrapper = mount(StepsPanel, {
      props: {
        steps: [
          step({
            id: 'failed-edit',
            status: 'failed',
            error: 'No matching text found in file',
            toolCall: toolCall({
              id: 'tc-failed-edit',
              status: 'failed',
              requiresConfirmation: false,
              changes: undefined,
              arguments: {
                path: '/tmp/project/src/app.ts',
                edits: [{ oldText: 'missing', newText: 'replacement' }],
              },
            }),
          }),
        ],
      },
      global: {
        stubs: {
        },
      },
    })
    await nextTick()

    expect(wrapper.find('.operation-row .node-target').attributes('aria-label')).toBe('Edit(app.ts)')
    expect(wrapper.find('.operation-row .node-action').text()).toBe('Edit')
    expect(wrapper.find('.operation-row .node-target-name').text()).toBe('app.ts')
    expect(wrapper.find('.operation-failure').exists()).toBe(false)
    expect(wrapper.find('.node-error-summary').text()).toContain('No matching text found')
    expect(wrapper.find('.group-final-result').exists()).toBe(false)
    expect(wrapper.find('.activity-inline-details').exists()).toBe(true)
  })

  it('renders attachment-only user messages without a bubble shell', async () => {
    const { default: MessageItem } = await import('../../MessageItem.vue')
    const message: ChatMessage = {
      id: 'm1',
      role: 'user',
      content: '',
      timestamp: 0,
      attachments: [imageAttachment(), fileAttachment()],
    }
    const wrapper = mount(MessageItem, {
      props: { message },
      global: { stubs: messageItemStubs },
    })

    // Attachments live outside the bubble; with no text there is no shell.
    expect(wrapper.find('.bubble').exists()).toBe(false)
    expect(wrapper.find('.attachment-thumb-img').attributes('src')).toBe('data:image/png;base64,abc123')
    expect(wrapper.find('.file-chip-name').text()).toBe('notes.pdf')
  })

  it('renders an image generation skeleton content part', async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: 'assistant',
        content: '',
        contentParts: [{ type: 'image-loading', label: 'Generating image' }],
        isStreaming: true,
      },
      global: { stubs: markdownStubs },
    })

    const skeleton = wrapper.find('.image-generation-skeleton')
    expect(skeleton.exists()).toBe(true)
    expect(skeleton.attributes('aria-label')).toBe('Generating image')
  })

  it('renders a plugin status line with its label and owner (R6)', async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: 'assistant',
        content: '',
        contentParts: [{ type: 'plugin-status', pluginId: 'log-monitor', id: 'scan', label: 'Scanning 3/40' }],
        isStreaming: true,
      },
      global: { stubs: markdownStubs },
    })

    const line = wrapper.find('.plugin-status-line')
    expect(line.exists()).toBe(true)
    expect(line.attributes('role')).toBe('status')
    expect(line.text()).toContain('Scanning 3/40')
    // 归属可见:用户要能看出这行字是谁在说。
    expect(line.text()).toContain('log-monitor')
  })

  it('renders two plugin statuses as separate cells (R6)', async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: 'assistant',
        content: '',
        contentParts: [
          { type: 'plugin-status', pluginId: 'a', id: 'x', label: 'A working' },
          { type: 'plugin-status', pluginId: 'b', id: 'x', label: 'B working' },
        ],
        isStreaming: true,
      },
      global: { stubs: markdownStubs },
    })

    // key 按 (pluginId, id) —— 两个插件用同一个 id 不能互相顶掉。
    expect(wrapper.findAll('.plugin-status-line')).toHaveLength(2)
  })

  it('renders no waiting row after data steps — the readout lives in the composer (2026-08-17)', async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: 'assistant',
        content: '',
        contentParts: [
          { type: 'data-steps', turnIndex: 1 },
          { type: 'waiting', turnIndex: 2 },
        ],
        steps: [step({ turnIndex: 1 })],
        isStreaming: true,
      },
      global: { stubs: markdownStubs },
    })

    expect(wrapper.find('.generation-waiting').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Waiting')
    // The steps rail still paints — only the waiting placeholder is silent.
    expect(wrapper.find('.process-rail').exists()).toBe(true)
  })

  it('summarizes inline thought headers from their reasoning content', async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: 'assistant',
        content: '',
        contentParts: [
          { type: 'reasoning', content: 'Validate syntax and inspect the final diff. Then report the patch.', turnIndex: 1 },
          { type: 'data-steps', turnIndex: 1 },
          { type: 'reasoning', content: 'Run the Lua parser to catch any syntax errors before finishing.', turnIndex: 2 },
        ],
        steps: [step({ turnIndex: 1 })],
        isStreaming: false,
      },
      global: { stubs: markdownStubs },
    })

    // Settled message: the whole process sits collapsed behind ONE work-group
    // header ("Worked · …"); thought panels appear after expanding it.
    const rail = wrapper.find('.process-rail')
    expect(rail.exists()).toBe(true)
    expect(rail.classes()).not.toContain('is-solo')
    expect(rail.find('.process-rail-title').text()).toContain('Worked')
    expect(rail.find('.process-rail-title').text()).toContain('思考 2 步')
    expect(wrapper.findAll('.inline-reasoning')).toHaveLength(0)

    await rail.find('.process-rail-header').trigger('click')

    const headers = wrapper.findAll('.inline-reasoning-header')
    const panels = wrapper.findAll('.inline-reasoning')
    expect(panels).toHaveLength(2)
    expect(panels[0].classes()).toContain('collapse-panel')
    expect(headers).toHaveLength(2)
    expect(headers[0].text()).toContain('Thought')
    // `.thought-detail-text` is ThoughtHeader's slot — the same one the
    // top-of-message thought renders (see ThoughtHeader.shared.test.ts).
    expect(headers[0].find('.thought-detail-text').text()).toBe('Validate syntax and inspect the final diff.')
    expect(headers[1].find('.thought-detail-text').text()).toBe('Run the Lua parser to catch any syntax errors before finishing.')
  })

  // ===== Render-key stability (messagelist 整改 · 第一步/第二步) =====

  it('keeps the tool row DOM node when its real step lands (no moving house)', async () => {
    const live = toolCall({
      id: 'tc-live',
      toolName: 'read',
      status: 'input-streaming',
      changes: undefined,
      arguments: { path: '/tmp/a.ts' },
    })
    const wrapper = mount(MessageBubble, {
      props: {
        role: 'assistant',
        content: '',
        contentParts: [{ type: 'tool-call', toolCalls: [live] }],
        steps: [],
        isStreaming: true,
      },
      global: { stubs: toolTimelineStubs },
    })
    await nextTick()

    // One panel, one row — the synthesized streaming-input step.
    expect(wrapper.findAll('.tool-activity-timeline')).toHaveLength(1)
    const rows = wrapper.findAll('.operation-row')
    expect(rows).toHaveLength(1)
    const rowEl = rows[0].element

    // The engine's real step arrives and a data-steps placeholder is appended.
    await wrapper.setProps({
      contentParts: [
        { type: 'tool-call', toolCalls: [live] },
        { type: 'data-steps', turnIndex: 1 },
      ],
      steps: [step({
        id: 'step-real',
        status: 'running',
        turnIndex: 1,
        toolCallId: 'tc-live',
        toolCall: toolCall({
          id: 'tc-live',
          toolName: 'read',
          status: 'executing',
          changes: undefined,
          arguments: { path: '/tmp/a.ts' },
        }),
      })],
    })
    await nextTick()

    // Still ONE panel and ONE row, and it is the very same element: the row
    // evolved in place instead of being re-created in a second StepsPanel.
    expect(wrapper.findAll('.tool-activity-timeline')).toHaveLength(1)
    const after = wrapper.findAll('.operation-row')
    expect(after).toHaveLength(1)
    expect(after[0].element).toBe(rowEl)
  })

  it('does not remount trailing parts when stream end splices transient indicators', async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: 'assistant',
        content: 'first',
        contentParts: [
          { type: 'text', content: 'first', turnIndex: 1 },
          { type: 'waiting', turnIndex: 1 },
          { type: 'text', content: 'second', turnIndex: 2 },
        ],
        isStreaming: true,
      },
      global: { stubs: markdownStubs },
    })
    await nextTick()

    // The waiting placeholder itself paints nothing (composer readout owns it).
    // No tool round → no work group: both text parts sit in the tail.
    expect(wrapper.find('.generation-waiting').exists()).toBe(false)
    const trailing = wrapper.findAll('.other-parts-container > .content')
    expect(trailing).toHaveLength(2)
    const firstEl = trailing[0].element
    const trailingEl = trailing[1].element

    // removeTransientIndicators splices the waiting part out at stream end.
    await wrapper.setProps({
      contentParts: [
        { type: 'text', content: 'first', turnIndex: 1 },
        { type: 'text', content: 'second', turnIndex: 2 },
      ],
      isStreaming: false,
    })
    await nextTick()

    expect(wrapper.find('.generation-waiting').exists()).toBe(false)
    const after = wrapper.findAll('.other-parts-container > .content')
    expect(after).toHaveLength(2)
    // A positional key would have shifted 2 → 1 here and remounted the block.
    expect(after[0].element).toBe(firstEl)
    expect(after[1].element).toBe(trailingEl)
  })

  it('draws no rail frame for a process group that renders nothing yet', async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: 'assistant',
        content: '',
        // data-steps placeholder arrived before any step did.
        contentParts: [{ type: 'data-steps', turnIndex: 1 }],
        steps: [],
        isStreaming: true,
      },
      global: { stubs: toolTimelineStubs },
    })
    await nextTick()

    // The rail shell is always mounted for an assistant turn, but with no
    // tool row it runs frameless: no header, no "Working" line, no border.
    expect(wrapper.find('.process-rail').classes()).toContain('is-solo')
    expect(wrapper.find('.process-rail-header').exists()).toBe(false)
  })

  it('hides opening waiting because MessageThinking owns that status', async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        role: 'assistant',
        content: '',
        contentParts: [{ type: 'waiting', turnIndex: 1 }],
        isStreaming: true,
      },
      global: { stubs: markdownStubs },
    })

    expect(wrapper.find('.generation-waiting').exists()).toBe(false)
  })

  it('opens image attachments from url-only sources', async () => {
    platformApiMock.openImagePreview.mockClear()
    const { default: MessageItem } = await import('../../MessageItem.vue')
    const message: ChatMessage = {
      id: 'm1',
      role: 'user',
      content: '',
      timestamp: 0,
      attachments: [imageAttachment({
        base64Data: undefined,
        url: 'media://session/image.png',
      })],
    }
    const wrapper = mount(MessageItem, {
      props: { message },
      global: { stubs: messageItemStubs },
    })

    await wrapper.find('.attachment-thumb-img').trigger('click')

    expect(platformApiMock.openImagePreview).toHaveBeenCalledWith(
      'media://session/image.png',
      'screenshot.png',
    )
  })

  it('does not open previews for non-image attachments', async () => {
    platformApiMock.openImagePreview.mockClear()
    const { default: MessageItem } = await import('../../MessageItem.vue')
    const message: ChatMessage = {
      id: 'm1',
      role: 'user',
      content: '',
      timestamp: 0,
      attachments: [fileAttachment()],
    }
    const wrapper = mount(MessageItem, {
      props: { message },
      global: { stubs: messageItemStubs },
    })

    expect(wrapper.find('.attachment-thumb-img').exists()).toBe(false)
    await wrapper.find('.file-chip').trigger('click')

    expect(platformApiMock.openImagePreview).not.toHaveBeenCalled()
  })

  it('routes attachment image opens through the Electron preview window', async () => {
    platformApiMock.openImagePreview.mockClear()
    const { default: MessageItem } = await import('../../MessageItem.vue')
    const message: ChatMessage = {
      id: 'm1',
      role: 'user',
      content: '',
      timestamp: 0,
      attachments: [imageAttachment()],
    }
    const wrapper = mount(MessageItem, {
      props: { message },
      global: { stubs: messageItemStubs },
    })

    await wrapper.find('.attachment-thumb-img').trigger('click')

    expect(platformApiMock.openImagePreview).toHaveBeenCalledWith(
      'data:image/png;base64,abc123',
      'screenshot.png',
    )
  })

  it('does not show waiting when streamed content only exists in content parts', async () => {
    const { default: MessageItem } = await import('../../MessageItem.vue')
    const message: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: 0,
      isStreaming: true,
      contentParts: [{ type: 'text', content: 'answer from content parts', turnIndex: 1 }],
    }
    const wrapper = mount(MessageItem, {
      props: { message },
      global: {
        stubs: {
          ...markdownStubs,
          ImagePreview: { template: '<div />' },
          MessageActions: { template: '<div />' },
          MessageError: { template: '<div />' },
          MessageSystem: { template: '<div />' },
          SelectionToolbar: { template: '<div />' },
          StepsPanel: { template: '<div />' },
        },
      },
    })

    // The waiting/thinking line is MessageThinking's `.thinking-status-row`
    // (its label now comes from the shared ThoughtHeader).
    expect(wrapper.find('.thinking-status-row').exists()).toBe(false)
    expect(wrapper.text()).toContain('answer from content parts')
  })

  it('replaces waiting with streamed content when MessageItem receives a new message object', async () => {
    const { default: MessageItem } = await import('../../MessageItem.vue')
    const waitingMessage: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: 0,
      isStreaming: true,
      contentParts: [{ type: 'waiting', turnIndex: 1 }],
    }
    const wrapper = mount(MessageItem, {
      props: { message: waitingMessage },
      global: {
        stubs: {
          ...markdownStubs,
          ImagePreview: { template: '<div />' },
          MessageActions: { template: '<div />' },
          MessageError: { template: '<div />' },
          MessageSystem: { template: '<div />' },
          SelectionToolbar: { template: '<div />' },
          StepsPanel: { template: '<div />' },
        },
      },
    })

    // Waiting is a composer-side readout now: the message shows nothing yet.
    expect(wrapper.text()).not.toContain('Waiting')

    await wrapper.setProps({
      message: {
        ...waitingMessage,
        content: 'streamed answer',
        contentParts: [{ type: 'text', content: 'streamed answer', turnIndex: 1 }],
      },
    })

    expect(wrapper.text()).not.toContain('Waiting')
    expect(wrapper.text()).toContain('streamed answer')
  })
})

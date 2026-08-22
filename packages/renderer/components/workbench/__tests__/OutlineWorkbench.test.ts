// @vitest-environment happy-dom
/**
 * 右栏「Contents」页签 —— 承自 `components/chat/__tests__/ChatSidePanel.test.ts`
 * 的 contents 那一组(L3:大纲栏并入右栏,用例跟着搬,不跟着删)。
 */
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OutlineWorkbench from '../OutlineWorkbench.vue'
import { resetOutlineRailHost } from '@/composables/useOutlineRail'

const sessionsStore = vi.hoisted(() => ({
  isNewChatDraftId: vi.fn((sessionId: string) => sessionId.startsWith('draft:')),
}))

const chatStore = vi.hoisted(() => ({
  sessionUserMarkers: new Map<string, unknown[]>(),
  loadUserMessageMarkers: vi.fn(async (_sessionId: string) => []),
}))

const segmentsMock = vi.fn(async (_sessionId: string) => ({
  success: true,
  segments: [] as unknown[],
}))

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => sessionsStore,
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => chatStore,
}))

// P4c 第五批:目录读面走 `sessions` RPC 域(`sessionsApi.getSegments({ sessionId })`)。
vi.mock('@/platform/sessions-client', () => ({
  sessionsApi: {
    getSegments: ({ sessionId }: { sessionId: string }) => segmentsMock(sessionId),
  },
}))

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

const segment = {
  id: 's1',
  origin: 'inferred',
  kind: 'task',
  title: 'Fix the parser',
  detail: 'off-by-one in the lexer',
  files: [{ path: 'src/parser.ts', added: 2, removed: 1 }],
  startMessageId: 'm7',
  startedAt: 0,
  turnCount: 2,
  revision: 1,
}

const marker = { id: 'u1', seq: 1, timestamp: 5, preview: 'please fix the parser' }

describe('OutlineWorkbench', () => {
  beforeEach(() => {
    const storage: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage[key] = String(value)
      }),
      removeItem: vi.fn((key: string) => {
        delete storage[key]
      }),
    })
    chatStore.sessionUserMarkers = new Map()
    chatStore.loadUserMessageMarkers.mockClear()
    segmentsMock.mockClear()
    segmentsMock.mockResolvedValue({ success: true, segments: [] })
    resetOutlineRailHost()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetOutlineRailHost()
  })

  it('loads segments and user markers on mount', async () => {
    segmentsMock.mockResolvedValue({ success: true, segments: [segment] })

    const wrapper = mount(OutlineWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    expect(segmentsMock).toHaveBeenCalledWith('session-1')
    expect(chatStore.loadUserMessageMarkers).toHaveBeenCalledWith('session-1')
    expect(wrapper.text()).toContain('Fix the parser')
  })

  it('opens the newest topic and jumps via its user messages', async () => {
    segmentsMock.mockResolvedValue({ success: true, segments: [segment] })
    chatStore.sessionUserMarkers = new Map([['session-1', [marker]]])

    const wrapper = mount(OutlineWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    // The last (here: only) topic is expanded by default, showing the user
    // messages that drove it.
    const messageRow = wrapper.find('.topic-message-row')
    expect(messageRow.text()).toContain('please fix the parser')

    await messageRow.trigger('click')
    // 跳转走 `jump-to-source` —— 与 Media 面板共用工作台那条既有中继链。
    expect(wrapper.emitted('jump-to-source')?.[0]).toEqual([
      { sessionId: 'session-1', messageId: 'u1' },
    ])
  })

  it('falls back to a flat user-message list when no segments exist yet', async () => {
    segmentsMock.mockResolvedValue({ success: true, segments: [] })
    chatStore.sessionUserMarkers = new Map([['session-1', [marker]]])

    const wrapper = mount(OutlineWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    const row = wrapper.find('.outline-usermsg-row')
    expect(row.text()).toContain('please fix the parser')

    await row.trigger('click')
    expect(wrapper.emitted('jump-to-source')?.[0]).toEqual([
      { sessionId: 'session-1', messageId: 'u1' },
    ])
  })

  it('switches to the message outline and persists the mode', async () => {
    const wrapper = mount(OutlineWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    const messageOption = wrapper.findAll('.outline-mode-option')
      .find(button => button.text() === 'Message')
    expect(messageOption).toBeDefined()
    await messageOption!.trigger('click')
    await settle()

    expect(localStorage.setItem).toHaveBeenCalledWith('workbenchOutlineMode', 'message')
    expect(wrapper.find('.outline-rail-host').isVisible()).toBe(true)
    expect(wrapper.find('.outline-topics').exists()).toBe(false)
  })

  it('says nothing is recorded rather than showing a blank body', async () => {
    segmentsMock.mockResolvedValue({ success: true, segments: [] })

    const wrapper = mount(OutlineWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    expect(wrapper.text()).toContain('Nothing recorded yet')
  })

  it('survives the read failing', async () => {
    segmentsMock.mockRejectedValueOnce(new Error('nope'))

    const wrapper = mount(OutlineWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    expect(wrapper.text()).toContain('Nothing recorded yet')
  })

  it('reads nothing for a new chat draft', async () => {
    const wrapper = mount(OutlineWorkbench, { props: { sessionId: 'draft:one' } })
    await settle()

    expect(segmentsMock).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Nothing recorded yet')
  })

  it('shows the heading summary from window events only in message mode', async () => {
    localStorage.setItem('workbenchOutlineMode', 'message')

    const wrapper = mount(OutlineWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    window.dispatchEvent(new CustomEvent('assistant-outline:current-changed', {
      detail: { sessionId: 'other-session', label: 'Ignored heading', count: 3 },
    }))
    const outlineLive = () => wrapper.find('.outline-head-live').text()

    await settle()
    expect(wrapper.find('.outline-head-live').exists()).toBe(false)

    window.dispatchEvent(new CustomEvent('assistant-outline:current-changed', {
      detail: { sessionId: 'session-1', label: 'Current heading', count: 3 },
    }))
    await settle()
    expect(outlineLive()).toBe('Current heading')
  })

  /**
   * 大纲轨的落点(L3)。宿主登记在模块级 ref 上,聊天面的 MessageList 顺着它
   * teleport —— 这一条钉的正是"不经 prop 逐层透传"那条新链路的两端。
   */
  it('registers its rail host on mount and hands it back on unmount', async () => {
    const { useOutlineRail } = await import('@/composables/useOutlineRail')
    const { outlineRailHost } = useOutlineRail()

    const wrapper = mount(OutlineWorkbench, {
      props: { sessionId: 'session-1' },
      attachTo: document.body,
    })
    await settle()

    expect(outlineRailHost.value).toBe(wrapper.find('.outline-rail-host').element)

    wrapper.unmount()
    expect(outlineRailHost.value).toBeNull()
  })

  it('reloads the contents when the tab becomes the active one again', async () => {
    const wrapper = mount(OutlineWorkbench, {
      props: { sessionId: 'session-1', active: false },
    })
    await settle()
    expect(segmentsMock).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ active: true })
    await settle()
    expect(segmentsMock).toHaveBeenCalledTimes(2)
  })
})

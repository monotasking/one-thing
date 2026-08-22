// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Button from '../../common/Button.vue'
import ChatWindow from '../ChatWindow.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const mocks = vi.hoisted(() => {
  return {
    chatPanelSave: vi.fn(),
    chatPanelRestore: vi.fn().mockResolvedValue(true),
    chatPanelScrollToMessage: vi.fn().mockResolvedValue(true),
    sessionsStore: {
      currentSessionId: 'session-1',
      isLoading: false,
      sessions: [
        {
          id: 'session-1',
          name: 'Project chat',
          workingDirectory: '/repo',
        },
        {
          id: 'session-2',
          name: 'Second chat',
          workingDirectory: '/repo',
        },
      ],
      switchSession: vi.fn(),
      clearCurrentSession: vi.fn(),
      isNewChatDraftId: (sessionId: string) => sessionId.startsWith('draft:'),
      discardNewChatDraft: vi.fn(),
      getSessionItem: vi.fn((sessionId: string) =>
        mocks.sessionsStore.sessions.find((item: any) => item.id === sessionId),
      ),
    },
    // 外壳形态:这组用例全是直聊,所以走哪个档都该是旧壳(TabBar + ChatPanel)。
    settingsStore: {
      settings: { ui: { shellMode: 'workbench' }, general: {}, chat: {} } as Record<string, unknown>,
    },
  }
})

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => mocks.sessionsStore,
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => mocks.settingsStore,
}))

vi.mock('../SessionHeader.vue', () => ({
  default: {
    name: 'SessionHeader',
    components: { Button },
    props: ['sessionId', 'sessionName'],
    emits: ['openOutline'],
    template: `
      <div class="mock-session-header" :data-session="sessionId">
        <span class="mock-session-title">{{ sessionName }}</span>
        <Button
          unstyled
          class="mock-outline-toggle"
          @click="$emit('openOutline')"
        >
          contents
        </Button>
      </div>
    `,
  },
}))

// 房面(去复用重构 R1)在直聊上永不挂载,但它是 ChatWindow 的静态 import ——
// 与 ChatPanel 一样打桩,免得把 InputBox 的整条依赖链拖进这组直聊测试。
vi.mock('../room/RoomHeader.vue', () => ({
  default: { name: 'RoomHeader', template: '<div class="mock-room-header" />' },
}))

vi.mock('../room/RoomSurface.vue', () => ({
  default: { name: 'RoomSurface', template: '<div class="mock-room-surface" />' },
}))

vi.mock('../ChatPanel.vue', () => ({
  default: {
    name: 'ChatPanel',
    components: { Button },
    props: ['sessionId', 'active', 'footerTarget', 'outlineRailTarget'],
    emits: ['splitWithBranch', 'openFile'],
    setup(_props: unknown, { expose }: { expose: (exposed: Record<string, unknown>) => void }) {
      expose({
        focusInput: vi.fn(),
        saveSnapshotForCurrentSession: mocks.chatPanelSave,
        restoreSnapshotForCurrentSession: mocks.chatPanelRestore,
        scrollToMessage: mocks.chatPanelScrollToMessage,
      })
      return {}
    },
    template: `
      <div class="mock-chat-panel" :data-active="active">
        <Button unstyled class="open-file" @click="$emit('openFile', '/repo/src/a.ts')">open file</Button>
      </div>
    `,
  },
}))

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function installElectronAPI() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      getAppState: vi.fn().mockResolvedValue({}),
      saveUIState: vi.fn().mockResolvedValue({ success: true }),
      // P4c 第五批:会话域走通用 RPC 通道,LRU 那两条因此不再是 electronAPI 上的方法。
      rpcInvoke: vi.fn(async (request: { domain: string; method: string }) => {
        if (request.domain === 'sessions' && request.method === 'getCacheStats') {
          return { ok: true, data: { size: 0, maxSize: 10, cachedSessionIds: [] } }
        }
        if (request.domain === 'sessions' && request.method === 'evictCache') {
          return { ok: true, data: { success: true } }
        }
        return { ok: false, error: { message: `unstubbed RPC ${request.domain}.${request.method}` } }
      }),
      closeWindow: vi.fn().mockResolvedValue({ success: true }),
    },
  })
}

describe('ChatWindow 单会话外壳', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    installElectronAPI()
    setActivePinia(createPinia())
    // ChatWindow renders whatever its workspace leaf holds; seed the store
    // the way hydration would.
    useWorkspaceStore().openSession('session-1')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('画的是它那一格里坐着的那条会话', async () => {
    const wrapper = mount(ChatWindow)
    await settle()

    expect(wrapper.find('.mock-session-header').attributes('data-session')).toBe('session-1')
  })

  /**
   * 多页签与「关闭会话」都已退役(U2,product-two-forms-chatgpt-shell.md D4/D5):
   * 顶栏上不该再有关**页签**的入口,ChatWindow 也不该再暴露页签操作。
   *
   * 注意这不含「关闭分栏」—— 那颗按钮由 header 的 `canClose` 画出、走 `close`
   * 事件(见 SessionHeader.close.test.ts / ChatContainer.search.test.ts)。
   */
  it('顶栏没有关页签的入口,ChatWindow 不再暴露页签操作', async () => {
    const wrapper = mount(ChatWindow)
    await settle()

    expect(wrapper.find('.close-tab-btn').exists()).toBe(false)
    const vm = wrapper.vm as unknown as Record<string, unknown>
    expect(vm.selectTabByIndex).toBeUndefined()
    expect(vm.closeActiveTab).toBeUndefined()
    expect(vi.mocked((window as any).electronAPI.closeWindow)).not.toHaveBeenCalled()
  })

  it('再开一条会话 = 换掉这一格的靶子,不是叠一张签', async () => {
    const workspace = useWorkspaceStore()
    const wrapper = mount(ChatWindow)
    await settle()

    workspace.openSession('session-2')
    await settle()

    expect(wrapper.find('.mock-session-header').attributes('data-session')).toBe('session-2')
    expect([...workspace.openSessionIds]).toEqual(['session-2'])
  })

  it('provides a left-column footer region to host the chat composer', async () => {
    const wrapper = mount(ChatWindow)
    await settle()

    const footer = wrapper.find('.layout-container-main .chat-footer')
    const chatPanel = wrapper.findComponent({ name: 'ChatPanel' })

    expect(footer.exists()).toBe(true)
    expect(wrapper.find('.layout-container-footer .chat-footer').exists()).toBe(false)
    expect(chatPanel.props('active')).toBe(true)
    expect(chatPanel.props('footerTarget')).toBe(footer.element)
    expect(chatPanel.props('sessionId')).toBe('session-1')
  })

  /**
   * L3:大纲栏退役之后,轨的宿主不再由 prop 一路传进来 —— 它登记在
   * `composables/useOutlineRail.ts` 那枚模块级 ref 上,这一层只回答
   * "轮不轮得到我"(聚焦的那一格才拿得到)。
   */
  it('takes the outline rail host from the shared ref, and only when focused', async () => {
    const { setOutlineRailHost, resetOutlineRailHost } = await import('@/composables/useOutlineRail')
    const host = document.createElement('div')
    setOutlineRailHost(host)

    const focused = mount(ChatWindow, { props: { panelFocused: true } })
    await settle()
    expect(focused.findComponent({ name: 'ChatPanel' }).props('outlineRailTarget')).toBe(host)

    const blurred = mount(ChatWindow, { props: { panelFocused: false } })
    await settle()
    expect(blurred.findComponent({ name: 'ChatPanel' }).props('outlineRailTarget')).toBeNull()

    resetOutlineRailHost()
  })

  it('asks for the right-hand Contents tab from the header button', async () => {
    const wrapper = mount(ChatWindow)
    await settle()

    await wrapper.find('.mock-outline-toggle').trigger('click')
    expect(wrapper.emitted('openOutline')).toHaveLength(1)
  })

  it('emits file opens for the app-level right workbench (文件不进工作区树)', async () => {
    const wrapper = mount(ChatWindow)
    await settle()

    await wrapper.find('.open-file').trigger('click')
    await settle()

    expect(wrapper.emitted('openFile')).toEqual([['/repo/src/a.ts']])
    expect(mocks.chatPanelSave).not.toHaveBeenCalled()
    expect(mocks.chatPanelRestore).not.toHaveBeenCalled()
  })

  it('scrolls to a target message', async () => {
    const wrapper = mount(ChatWindow)
    await settle()

    const result = await (wrapper.vm as unknown as { scrollToMessage: (messageId: string) => Promise<boolean> })
      .scrollToMessage('message-1')
    await settle()

    expect(result).toBe(true)
    expect(mocks.chatPanelRestore).not.toHaveBeenCalled()
    expect(mocks.chatPanelScrollToMessage).toHaveBeenCalledWith('message-1')
  })

})

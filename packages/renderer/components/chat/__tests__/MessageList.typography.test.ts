// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MessageList from '../MessageList.vue'

const mocks = vi.hoisted(() => ({
  chatStore: {
    getSessionPageState: vi.fn(() => undefined),
    getScrollVersion: vi.fn(() => 0),
    getSnapshot: vi.fn(() => null),
    handlePermissionRequest: vi.fn(),
    loadMessagesAround: vi.fn().mockResolvedValue(false),
    loadOlderMessages: vi.fn().mockResolvedValue(false),
    loadUserMessageMarkers: vi.fn(),
    sessionUserMarkers: new Map(),
  },
  sessionsStore: {
    currentSessionId: 'session-1',
    sessions: [{ id: 'session-1', name: 'Test', messageCount: 1 }],
    sessionGoals: new Map(),
    sessionGoalHistory: new Map(),
    createBranch: vi.fn(),
    switchSession: vi.fn(),
  },
  settingsStore: {
    settings: {
      general: {},
      chat: {},
    },
  },
  platformApi: {
    capabilities: {
      shellTools: true,
    },
    emitCommand: vi.fn().mockResolvedValue({ success: true }),
    executeTool: vi.fn().mockResolvedValue({ success: true, result: '' }),
    getPendingPermissions: vi.fn().mockResolvedValue({ success: true, pending: [] }),
    updateMessageThinkingTime: vi.fn().mockResolvedValue({ success: true }),
    updateToolCall: vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => mocks.chatStore,
}))

// 待审批账本(架构收敛 C4 §5):MessageList 只说"这个会话上屏了",拉取与投影归它。
vi.mock('@/stores/collabBoard', () => ({
  useCollabBoardStore: () => ({ ensurePendingForSession: vi.fn() }),
}))


vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => mocks.sessionsStore,
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => mocks.settingsStore,
}))

vi.mock('@/platform', () => ({
  platformApi: mocks.platformApi,
}))

vi.mock('@/composables/usePermissionShortcuts', () => ({
  usePermissionShortcuts: vi.fn(),
}))

vi.mock('@/composables/useFollowScroll', async () => {
  const { ref } = await import('vue')
  return {
    shouldShowScrollToBottomButton: vi.fn(() => false),
    // 跟底状态的只读出口:这些用例不走可见性门,provide 空转即可。
    provideChatFollowState: vi.fn(),
    useFollowScroll: () => ({
      allowOneScroll: vi.fn(),
      checkReattach: vi.fn(),
      isSwitching: vi.fn(() => false),
      isFollowing: ref(true),
      onScroll: vi.fn(),
      onWheel: vi.fn(),
      snapToBottom: vi.fn(),
    }),
  }
})

vi.mock('@/composables/useMessageScrollCoordinator', () => ({
  useMessageScrollCoordinator: () => ({
    clear: vi.fn(),
    isAnchored: vi.fn(() => false),
    onLayoutChange: vi.fn(),
    setAnchor: vi.fn(),
    setTail: vi.fn(),
    writeScrollTop: vi.fn(),
  }),
}))

vi.mock('../MessageItem.vue', () => ({
  default: {
    name: 'MessageItem',
    props: ['message'],
    template: '<div class="mock-message-item">{{ message.content }}</div>',
  },
}))

vi.mock('../EmptyState.vue', () => ({
  default: {
    name: 'EmptyState',
    template: '<div class="mock-empty-state" />',
  },
}))

vi.mock('../AssistantMessageNavRail.vue', () => ({
  default: {
    name: 'AssistantMessageNavRail',
    template: '<div class="mock-assistant-nav" />',
  },
}))

vi.mock('../UserMessageNavRail.vue', () => ({
  default: {
    name: 'UserMessageNavRail',
    template: '<div class="mock-user-nav" />',
  },
}))

vi.mock('../assistant-message-outline', () => ({
  ASSISTANT_OUTLINE_ANCHOR_ATTR: 'data-assistant-outline-anchor',
  buildAssistantMessageOutlineMarkers: vi.fn(() => []),
  shouldShowAssistantMessageOutline: vi.fn(() => false),
}))

function mountMessageList(messages = [{
  id: 'msg-1',
  role: 'assistant',
  content: 'Hello',
  timestamp: Date.now(),
}] as any[]) {
  return mount(MessageList, {
    props: {
      messages,
      sessionId: 'session-1',
    },
    global: {
      stubs: {
        Teleport: true,
        Transition: false,
      },
    },
  })
}

describe('MessageList typography density', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.chatStore.sessionUserMarkers.clear()
    mocks.settingsStore.settings = {
      general: {},
      chat: {},
    }
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now())
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        getPendingPermissions: vi.fn().mockResolvedValue({ success: true, pending: [] }),
      },
    })
  })

  it('keeps comfortable message density as the chat default', () => {
    const wrapper = mountMessageList()

    expect(wrapper.find('.message-list').classes()).toContain('density-comfortable')
    expect(wrapper.find('.message-list-wrapper').attributes('style')).toContain('--message-line-height-px: 24px')
  })

  it('uses the shared Scrollbar as the message scroll host', () => {
    const wrapper = mountMessageList()
    const messageList = wrapper.find('.message-list')

    expect(messageList.classes()).toContain('scrollbar')
    expect(messageList.find('.scrollbar-content .message-list-content').exists()).toBe(true)
  })

  it('keeps a content-width measurement anchor for empty chats', () => {
    const wrapper = mountMessageList([])
    const anchor = wrapper.find('.scrollbar-content .message-list-content--empty')

    expect(wrapper.find('.mock-empty-state').exists()).toBe(true)
    expect(anchor.exists()).toBe(true)
    expect(anchor.attributes('aria-hidden')).toBe('true')
  })

  it('lets explicit chat font size and line height override density defaults', () => {
    mocks.settingsStore.settings = {
      general: {
        messageListDensity: 'compact',
        messageLineHeight: 1.7,
      },
      chat: {
        chatFontSize: 18,
      },
    }

    const wrapper = mountMessageList()
    const style = wrapper.find('.message-list-wrapper').attributes('style')

    expect(wrapper.find('.message-list').classes()).toContain('density-compact')
    expect(style).toContain('--message-font-size: 18px')
    expect(style).toContain('--message-line-height: 1.7')
    expect(style).toContain('--message-line-height-px: 31px')
  })

  it('anchors the bottom sentinel only while following an active stream', async () => {
    const wrapper = mountMessageList()

    expect(wrapper.find('.message-list').classes()).not.toContain('stream-following')

    await wrapper.setProps({
      messages: [{
        id: 'msg-1',
        role: 'assistant',
        content: 'Hello',
        timestamp: Date.now(),
        isStreaming: true,
      } as any],
    })

    expect(wrapper.find('.message-list').classes()).toContain('stream-following')
  })
})

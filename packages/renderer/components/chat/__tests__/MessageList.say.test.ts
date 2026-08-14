// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MessageList from '../MessageList.vue'

/**
 * **say 分流门已拆**(去复用重构 R3,docs/design/im-workbench-layout.md §8.4)。
 *
 * C2′ 曾把 say 组件树挂在 `MessageList` 内部(`saySurfaceActive`)。R1 之后房 /
 * 私聊在 workbench 下整条走 `ChatWindow → RoomSurface`,`MessageList` 只由
 * `ChatPanel` 挂载、`ChatPanel` 只由 `ChatWindow` 的 `v-else` 挂载 —— 那道门恒为
 * false,是死代码,R3 拆掉。
 *
 * 这一组因此反过来钉两件事:
 *  1. **全库只剩一处 say 树挂载点**(`RoomSurface`):`MessageList` 上再也长不出
 *     第二棵,哪怕把它硬塞进一个 workbench + 房间的场;
 *  2. **classic 逐像素回滚闸仍然成立**:classic 下房会话走的就是这条旧壳,
 *     分组 / 折叠 / 时间胶囊那一整套房分支是**活代码**,一条都没被清理掉。
 */
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
    isRoomGroupCollapsed: vi.fn(() => false),
    toggleRoomGroupCollapsed: vi.fn(),
    expandRoomGroup: vi.fn(),
  },
  sessionsStore: {
    currentSessionId: 'room-1',
    sessions: [{ id: 'room-1', name: 'Team', kind: 'room', messageCount: 3 }] as unknown[],
    sessionGoals: new Map(),
    sessionGoalHistory: new Map(),
    createBranch: vi.fn(),
    switchSession: vi.fn(),
  },
  settingsStore: {
    settings: { ui: { shellMode: 'workbench' }, general: {}, chat: {} } as Record<string, unknown>,
  },
  platformApi: {
    capabilities: { shellTools: true },
    emitCommand: vi.fn().mockResolvedValue({ success: true }),
    executeTool: vi.fn().mockResolvedValue({ success: true, result: '' }),
    getPendingPermissions: vi.fn().mockResolvedValue({ success: true, pending: [] }),
    openImagePreview: vi.fn(),
    updateMessageThinkingTime: vi.fn().mockResolvedValue({ success: true }),
    updateToolCall: vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('@/stores/chat', () => ({ useChatStore: () => mocks.chatStore }))
// 待审批账本(架构收敛 C4 §5):MessageList 只说"这个会话上屏了",拉取与投影归它。
vi.mock('@/stores/collabBoard', () => ({
  useCollabBoardStore: () => ({ ensurePendingForSession: vi.fn() }),
}))
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => mocks.sessionsStore }))
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => mocks.settingsStore }))
vi.mock('@/platform', () => ({ platformApi: mocks.platformApi }))

vi.mock('@/composables/usePermissionShortcuts', () => ({ usePermissionShortcuts: vi.fn() }))

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
    isTail: vi.fn(() => false),
    onLayoutChange: vi.fn(),
    setAnchor: vi.fn(),
    setTail: vi.fn(),
    writeScrollTop: vi.fn(),
  }),
}))

vi.mock('../MessageItem.vue', () => ({
  default: {
    name: 'MessageItem',
    props: ['message', 'roomMode'],
    template: '<div class="mock-message-item" :data-id="message.id" />',
  },
}))

vi.mock('../EmptyState.vue', () => ({
  default: { name: 'EmptyState', template: '<div class="mock-empty-state" />' },
}))
vi.mock('../AssistantMessageNavRail.vue', () => ({
  default: { name: 'AssistantMessageNavRail', template: '<div class="mock-assistant-nav" />' },
}))
vi.mock('../UserMessageNavRail.vue', () => ({
  default: { name: 'UserMessageNavRail', template: '<div class="mock-user-nav" />' },
}))
vi.mock('../assistant-message-outline', () => ({
  ASSISTANT_OUTLINE_ANCHOR_ATTR: 'data-assistant-outline-anchor',
  buildAssistantMessageOutlineMarkers: vi.fn(() => []),
  shouldShowAssistantMessageOutline: vi.fn(() => false),
}))

const T0 = new Date('2026-07-31T09:00:00').getTime()
const MINUTE = 60 * 1000

const ROOM_MESSAGES = [
  { id: 'm1', role: 'user', content: '@小林 结论呢', timestamp: T0 },
  { id: 'm2', role: 'assistant', agentId: 'a1', content: '## 结论\n\n通过。', timestamp: T0 + MINUTE },
  { id: 'm3', role: 'assistant', agentId: 'a1', content: '剩下的坑在多 profile。', timestamp: T0 + 2 * MINUTE },
]

function mountList(messages: unknown[] = ROOM_MESSAGES) {
  return mount(MessageList, {
    props: { messages: messages as never, sessionId: 'room-1' },
    global: { stubs: { Teleport: true, Transition: false } },
  })
}

describe('MessageList 上不再有第二棵 say 树(R3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.settingsStore.settings = { ui: { shellMode: 'workbench' }, general: {}, chat: {} }
    mocks.sessionsStore.sessions = [{ id: 'room-1', name: 'Team', kind: 'room', messageCount: 3 }]
  })

  it.each([
    ['workbench(生产上到不了这里,门拆了也长不出来)', 'workbench'],
    ['classic(房走旧壳 —— 逐像素回滚闸)', 'classic'],
  ])('房会话 + %s:一律既有 MessageItem 树,say 行零条', (_label, shellMode) => {
    mocks.settingsStore.settings = { ui: { shellMode }, general: {}, chat: {} }
    const wrapper = mountList()

    expect(wrapper.findAll('.say-row')).toHaveLength(0)
    expect(wrapper.findAll('.say-flow')).toHaveLength(0)
    expect(wrapper.findAll('.mock-message-item')).toHaveLength(3)
    // 房的行盒与 gap table 是活代码:classic 下的房就靠它排版
    expect(wrapper.findAll('.message-list-row')).toHaveLength(3)
  })

  it.each([
    ['直聊', 'chat'],
    ['工作会话', 'work'],
    ['无 kind 的普通会话', undefined],
  ])('%s 照旧走既有组件树', (_label, kind) => {
    mocks.sessionsStore.sessions = [{ id: 'room-1', name: 'S', kind, messageCount: 3 }]
    const wrapper = mountList()

    expect(wrapper.findAll('.say-row')).toHaveLength(0)
    expect(wrapper.findAll('.mock-message-item')).toHaveLength(3)
  })

  it('排版恒走用户的密度/字号档 —— 聊天面那档 13/1.72 已随门一起搬去 RoomSurface', () => {
    const style = mountList().find('.message-list-wrapper').attributes('style')

    // comfortable(15 × 24/15 = 24px),不是 say 档的 13 / 22px
    expect(style).toContain('--message-line-height-px: 24px')
    expect(style).not.toContain('--message-font-size: 13px')
    expect(style).not.toContain('--chat-turn-gap')
  })

  it('用户显式选过字号仍然照他的来(退让闸拆门后没被误伤)', () => {
    mocks.settingsStore.settings = {
      ui: { shellMode: 'workbench' },
      general: {},
      chat: { chatFontSize: 18 },
    }
    const style = mountList().find('.message-list-wrapper').attributes('style')

    expect(style).toContain('--message-font-size: 18px')
    expect(style).not.toContain('--chat-turn-gap')
  })
})

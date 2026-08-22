// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MessageList from '../MessageList.vue'

const mocks = await vi.hoisted(async () => {
  // Stand-in for the store's per-session collapsed ledger (P1-2): the component
  // only ever asks "is this key folded", so a Set is the whole contract — but it
  // has to be REACTIVE, because the real ledger is a ref'd Map and the fold is
  // only a feature if the list repaints when it changes.
  const { reactive } = await import('vue')
  const collapsed = reactive(new Set<string>())
  return {
  collapsed,
  chatStore: {
    getSessionPageState: vi.fn(() => undefined),
    getScrollVersion: vi.fn(() => 0),
    getSnapshot: vi.fn(() => null),
    handlePermissionRequest: vi.fn(),
    loadMessagesAround: vi.fn().mockResolvedValue(false),
    loadOlderMessages: vi.fn().mockResolvedValue(false),
    loadUserMessageMarkers: vi.fn(),
    sessionUserMarkers: new Map(),
    isRoomGroupCollapsed: vi.fn((_sessionId: string, key: string) => collapsed.has(key)),
    toggleRoomGroupCollapsed: vi.fn((_sessionId: string, key: string) => {
      if (!collapsed.delete(key)) collapsed.add(key)
    }),
    expandRoomGroup: vi.fn((_sessionId: string, key: string) => collapsed.delete(key)),
  },
  sessionsStore: {
    currentSessionId: 'room-1',
    sessions: [{ id: 'room-1', name: 'Team', kind: 'room', messageCount: 3 }],
    sessionGoals: new Map(),
    sessionGoalHistory: new Map(),
    createBranch: vi.fn(),
    switchSession: vi.fn(),
  },
  settingsStore: {
    // classic 是逐像素回滚闸:房间在 classic 下仍然走既有 MessageItem 组件树,
    // 本文件钉的全部是那棵树的行为。workbench 下房间改走 say-only 新树
    // (C2′,见 MessageList.say.test.ts),外壳形态因此必须显式写死 ——
    // resolveShellMode 的默认值是 workbench。
    settings: { ui: { shellMode: 'classic' }, general: {}, chat: {} },
  },
  platformApi: {
    capabilities: { shellTools: true },
    executeTool: vi.fn().mockResolvedValue({ success: true, result: '' }),
    getPendingPermissions: vi.fn().mockResolvedValue({ success: true, pending: [] }),
    updateMessageThinkingTime: vi.fn().mockResolvedValue({ success: true }),
    updateToolCall: vi.fn().mockResolvedValue({ success: true }),
  },
  }
})

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
    props: [
      'message',
      'roomMode',
      'dmMode',
      'groupHead',
      'groupTail',
      'groupCollapsible',
      'groupCollapsed',
      'groupMessageCount',
    ],
    emits: ['reply', 'jumpToMessage', 'toggleGroup'],
    template:
      '<div class="mock-message-item" :data-room-mode="roomMode" :data-dm-mode="dmMode" :data-group-head="groupHead" :data-group-tail="groupTail"'
      + ' :data-collapsible="groupCollapsible" :data-collapsed="groupCollapsed" :data-count="groupMessageCount"'
      + ' :data-id="message.id"'
      + ' @click="$emit(\'reply\', { messageId: message.id, authorLabel: \'小李\', excerpt: message.content })">'
      + '<button class="mock-fold" @click.stop="$emit(\'toggleGroup\', message.id)" /></div>',
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

// Local NOON today: Date.now() + relative offsets crosses midnight in the
// 23:4x–23:59 window and the capsule flips from 今天 to an absolute date.
// Noon keeps every offset same-day against the component's real clock.
const T0 = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime() })()
const MINUTE = 60 * 1000

function mountList(messages: unknown[]) {
  return mount(MessageList, {
    props: { messages: messages as never, sessionId: 'room-1' },
    global: { stubs: { Teleport: true, Transition: false } },
  })
}

function flags(wrapper: ReturnType<typeof mountList>) {
  return wrapper.findAll('.mock-message-item').map(item => ({
    head: item.attributes('data-group-head'),
    tail: item.attributes('data-group-tail'),
    room: item.attributes('data-room-mode'),
  }))
}

describe('MessageList room presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.collapsed.clear()
    mocks.sessionsStore.sessions = [{ id: 'room-1', name: 'Team', kind: 'room', messageCount: 3 }]
  })

  it('passes room grouping flags for a same-agent run', () => {
    const wrapper = mountList([
      { id: 'm1', role: 'assistant', agentId: 'a1', content: '一', timestamp: T0 },
      { id: 'm2', role: 'assistant', agentId: 'a1', content: '二', timestamp: T0 + MINUTE },
      { id: 'm3', role: 'assistant', agentId: 'a2', content: '三', timestamp: T0 + 2 * MINUTE },
    ])

    expect(flags(wrapper)).toEqual([
      { head: 'true', tail: 'false', room: 'true' },
      { head: 'false', tail: 'true', room: 'true' },
      { head: 'true', tail: 'true', room: 'true' },
    ])
    expect(wrapper.findAll('.room-time-capsule')).toHaveLength(0)
  })

  it('inserts a time capsule as its own row, one row per message still', () => {
    const wrapper = mountList([
      { id: 'm1', role: 'assistant', agentId: 'a1', content: '一', timestamp: T0 },
      { id: 'm2', role: 'assistant', agentId: 'a1', content: '二', timestamp: T0 + 11 * MINUTE },
    ])

    const capsules = wrapper.findAll('.room-time-capsule')
    expect(capsules).toHaveLength(1)
    expect(capsules[0].text()).toMatch(/今天 \d{2}:\d{2}/)
    expect(wrapper.findAll('.message-list-row')).toHaveLength(2)
    expect(flags(wrapper)).toEqual([
      { head: 'true', tail: 'true', room: 'true' },
      { head: 'true', tail: 'true', room: 'true' },
    ])
  })

  it('hands a picked quote up to the composer owner (W7 §3.5 A)', async () => {
    const wrapper = mountList([
      { id: 'm1', role: 'assistant', agentId: 'a1', content: '先做接口', timestamp: T0 },
    ])

    await wrapper.find('.mock-message-item').trigger('click')
    expect(wrapper.emitted('replyTo')?.[0]).toEqual([
      { messageId: 'm1', authorLabel: '小李', excerpt: '先做接口' },
    ])
  })

  it('bands every row of the gap table exactly once (W15 §3.6)', () => {
    const wrapper = mountList([
      { id: 'm1', role: 'user', content: '大家看看', timestamp: T0 },
      { id: 'm2', role: 'assistant', agentId: 'a1', content: '一', timestamp: T0 + MINUTE },
      { id: 'm3', role: 'assistant', agentId: 'a1', content: '二', timestamp: T0 + MINUTE },
      { id: 'm4', role: 'system', content: '任务「接口」已开始执行', timestamp: T0 + MINUTE },
      { id: 'm5', role: 'assistant', agentId: 'a1', content: '三', timestamp: T0 + MINUTE },
    ])

    // undefined = the default turn band; only the exceptions carry a class.
    expect(wrapper.findAll('.message-list-row').map(row => row.classes().slice(1))).toEqual([
      [],
      [],
      ['room-row--stacked'],
      ['room-row--notice'],
      [],
    ])
    expect(wrapper.find('.message-list').classes()).toContain('is-room')
  })

  // ── Utterance folding (P1-2, todo #6) ──
  const BURST = [
    { id: 'u1', role: 'user', content: '大家看看', timestamp: T0 },
    { id: 'm1', role: 'assistant', agentId: 'a1', content: '一', timestamp: T0 + MINUTE },
    { id: 'm2', role: 'assistant', agentId: 'a1', content: '二', timestamp: T0 + MINUTE },
    { id: 'm3', role: 'assistant', agentId: 'a1', content: '三', timestamp: T0 + MINUTE },
    { id: 'm9', role: 'assistant', agentId: 'a2', content: '收到', timestamp: T0 + 2 * MINUTE },
  ]

  it('offers the toggle on a multi-message head only, with a live count', () => {
    const wrapper = mountList(BURST)
    expect(wrapper.findAll('.mock-message-item').map(item => ({
      id: item.attributes('data-id'),
      collapsible: item.attributes('data-collapsible'),
      count: item.attributes('data-count'),
    }))).toEqual([
      { id: 'u1', collapsible: 'false', count: '0' },
      { id: 'm1', collapsible: 'true', count: '3' },
      { id: 'm2', collapsible: 'false', count: '0' },
      { id: 'm3', collapsible: 'false', count: '0' },
      { id: 'm9', collapsible: 'false', count: '0' },
    ])
  })

  it('removes the folded rows from the DOM and leaves the head as the block', async () => {
    const wrapper = mountList(BURST)
    await wrapper.findAll('.mock-fold')[1].trigger('click')

    expect(mocks.chatStore.toggleRoomGroupCollapsed).toHaveBeenCalledWith('room-1', 'm1')
    expect(wrapper.findAll('.mock-message-item').map(item => item.attributes('data-id')))
      .toEqual(['u1', 'm1', 'm9'])
    const head = wrapper.findAll('.mock-message-item')[1]
    expect(head.attributes('data-collapsed')).toBe('true')
    expect(head.attributes('data-count')).toBe('3')
    // Folded, the head is the block's last row: it must take the turn gap and
    // the footer, or it reads as "stacked, more coming" with nothing coming.
    expect(head.attributes('data-group-tail')).toBe('true')
    expect(head.attributes('data-group-head')).toBe('true')
  })

  it('keeps the gap table banded once per surviving row', async () => {
    const wrapper = mountList(BURST)
    await wrapper.findAll('.mock-fold')[1].trigger('click')
    // No `room-row--stacked` survives: the rows that carried it are gone, and
    // the two heads left both sit on the default turn band.
    expect(wrapper.findAll('.message-list-row').map(row => row.classes().slice(1)))
      .toEqual([[], [], []])
  })

  it('does not revoke the fold when the burst grows, but retells the count', async () => {
    const wrapper = mountList(BURST)
    await wrapper.findAll('.mock-fold')[1].trigger('click')

    await wrapper.setProps({
      messages: [
        ...BURST,
        { id: 'm4', role: 'assistant', agentId: 'a1', content: '四', timestamp: T0 + 3 * MINUTE },
      ] as never,
    })

    // m4 joins a2's turn? No — a2 spoke last, so m4 opens its own group and the
    // folded block is untouched: still one visible head, still saying 3.
    const ids = wrapper.findAll('.mock-message-item').map(item => item.attributes('data-id'))
    expect(ids).toEqual(['u1', 'm1', 'm9', 'm4'])
    expect(wrapper.findAll('.mock-message-item')[1].attributes('data-count')).toBe('3')

    // Now grow the folded block itself: the fold survives, the count moves.
    await wrapper.setProps({
      messages: [
        ...BURST.slice(0, 4),
        { id: 'm5', role: 'assistant', agentId: 'a1', content: '五', timestamp: T0 + MINUTE },
        BURST[4],
      ] as never,
    })
    const head = wrapper.findAll('.mock-message-item')[1]
    expect(head.attributes('data-id')).toBe('m1')
    expect(head.attributes('data-collapsed')).toBe('true')
    expect(head.attributes('data-count')).toBe('4')
    expect(wrapper.findAll('.mock-message-item').map(item => item.attributes('data-id')))
      .toEqual(['u1', 'm1', 'm9'])
  })

  it('unfolds before jumping to a row a fold had removed', async () => {
    const wrapper = mountList(BURST)
    await wrapper.findAll('.mock-fold')[1].trigger('click')
    expect(wrapper.findAll('.mock-message-item')).toHaveLength(3)

    // A quote jump aimed at m3 (inside the folded block) has to reveal it, or
    // the scroll silently does nothing.
    wrapper.findAllComponents({ name: 'MessageItem' })[2].vm.$emit('jumpToMessage', 'm3')
    await wrapper.vm.$nextTick()
    expect(mocks.chatStore.expandRoomGroup).toHaveBeenCalledWith('room-1', 'm1')
    expect(wrapper.findAll('.mock-message-item').map(item => item.attributes('data-id')))
      .toEqual(['u1', 'm1', 'm2', 'm3', 'm9'])
  })

  it('never folds outside a room: no toggle on an ordinary session', () => {
    mocks.sessionsStore.sessions = [{ id: 'room-1', name: 'Chat', kind: 'chat', messageCount: 3 }]
    const wrapper = mountList(BURST)
    expect(wrapper.findAll('.mock-message-item').map(item => item.attributes('data-collapsible')))
      .toEqual(['false', 'false', 'false', 'false', 'false'])
  })

  it('leaves ordinary sessions untouched: no capsules, every message a solo group', () => {
    mocks.sessionsStore.sessions = [{ id: 'room-1', name: 'Chat', kind: 'chat', messageCount: 2 }]
    const wrapper = mountList([
      { id: 'm1', role: 'assistant', agentId: 'a1', content: '一', timestamp: T0 },
      { id: 'm2', role: 'assistant', agentId: 'a1', content: '二', timestamp: T0 + 11 * MINUTE },
    ])

    expect(wrapper.findAll('.room-time-capsule')).toHaveLength(0)
    expect(flags(wrapper)).toEqual([
      { head: 'true', tail: 'true', room: 'false' },
      { head: 'true', tail: 'true', room: 'false' },
    ])
    // The gap table must not engage outside a room: no marker class, no bands.
    expect(wrapper.find('.message-list').classes()).not.toContain('is-room')
    expect(wrapper.findAll('.message-list-row').map(row => row.classes().slice(1))).toEqual([[], []])
  })

  /**
   * 托管私聊房(agent-im-dm.md §4.3):房间排版原样,只多递一面 dm 旗给每一行 ——
   * 署名收不收由 MessageItem 决定,列表只负责说"这是一对一"。
   */
  it('只有单成员 dm 房才竖起 dm 旗,群聊和普通会话都不竖', () => {
    const dmRoom = [{
      id: 'room-1',
      name: '小李',
      kind: 'room',
      messageCount: 2,
      room: { dm: true, memberAgentIds: ['a1'] },
    }]
    mocks.sessionsStore.sessions = dmRoom as unknown as typeof mocks.sessionsStore.sessions
    const dm = mountList([
      { id: 'm1', role: 'assistant', agentId: 'a1', content: '一', timestamp: T0 },
    ])
    expect(dm.find('.mock-message-item').attributes('data-dm-mode')).toBe('true')
    // 房间排版本身没被 dm 关掉。
    expect(dm.find('.mock-message-item').attributes('data-room-mode')).toBe('true')

    // 双成员 dm 房是 P3 的 agent 互聊 —— 走群那一路,不是一对一。
    mocks.sessionsStore.sessions = [{
      id: 'room-1',
      name: '小李 ⇄ 小王',
      kind: 'room',
      messageCount: 2,
      room: { dm: true, memberAgentIds: ['a1', 'a2'] },
    }] as unknown as typeof mocks.sessionsStore.sessions
    const pair = mountList([
      { id: 'm1', role: 'assistant', agentId: 'a1', content: '一', timestamp: T0 },
    ])
    expect(pair.find('.mock-message-item').attributes('data-dm-mode')).toBe('false')

    mocks.sessionsStore.sessions = [{ id: 'room-1', name: 'Team', kind: 'room', messageCount: 2 }]
    const group = mountList([
      { id: 'm1', role: 'assistant', agentId: 'a1', content: '一', timestamp: T0 },
    ])
    expect(group.find('.mock-message-item').attributes('data-dm-mode')).toBe('false')
  })
})

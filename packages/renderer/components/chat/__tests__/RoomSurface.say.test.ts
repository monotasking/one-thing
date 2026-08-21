// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RoomSurface from '../room/RoomSurface.vue'

/**
 * 聊天面(say-only)的**唯一**挂载点 —— 去复用重构 R3。
 *
 * 这一组原本钉在 `MessageList.say.test.ts` 上(C2′ 时期 say 树挂在 MessageList
 * 内部)。R1 把房 / 私聊整条移到 `RoomSurface`、R3 拆掉 MessageList 那道死门之后,
 * 同样的断言必须跟着搬到真正渲染 say 的那一面上,否则拆门就是拆掉了覆盖率。
 *
 * 钉三件事:
 *  1. **署名只有一套**:连发合并,不重复头像与名字;
 *  2. **正文交给既有 markdown 渲染链**,不是新写的渲染器;
 *  3. **执行入口**(W3):拿不到 workSessionId 就不画,派出去的事件带真 id;
 *  4. 排版是聊天面档 13 / 1.72,派生行高与之同源;滚动锚点仍是
 *     `data-message-id` / `data-index`。
 */
const mocks = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  board: undefined as unknown,
  messages: [] as unknown[],
  /** undefined = 用户从未动过字号(出厂默认),聊天面档生效。 */
  chatFontSize: undefined as number | undefined,
}))

vi.mock('@/platform', () => ({
  platformApi: {
    emitCommand: vi.fn(),
    openImagePreview: vi.fn(),
  },
}))
vi.mock('@/platform/collab-client', () => ({
  collabApi: { messageReact: vi.fn() },
}))

// 房面只在 workbench 下挂载;这里给排版退让闸(shouldUseSayTypography)喂一份
// 出厂默认的设置——用户没有显式排版选择,聊天面档因此生效。真 store 在模块
// 作用域读 localStorage,测试里不能直接引。
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    settings: {
      ui: { shellMode: 'workbench' },
      general: {},
      chat: { chatFontSize: mocks.chatFontSize },
    },
  }),
}))

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => ({ currentSessionId: 'room-1', sessions: [mocks.session] }),
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    inspectorOpen: false,
    getSessionPageState: () => undefined,
    getScrollVersion: () => 0,
    getSnapshot: () => null,
    saveSnapshot: vi.fn(),
    loadInitialMessagePage: vi.fn(),
    loadOlderMessages: vi.fn().mockResolvedValue(false),
    loadNewerMessages: vi.fn().mockResolvedValue(false),
  }),
}))

// 提问账本(E2):composer 上方那条提问栏位自己读它,房面只给 sessionId。
vi.mock('@/stores/interactions', () => ({
  useInteractionsStore: () => ({
    ensureForSession: vi.fn(),
    pendingFor: () => [],
    respond: vi.fn(),
    decline: vi.fn(),
  }),
}))
vi.mock('@/stores/collabBoard', () => ({
  useCollabBoardStore: () => ({ ensureSubscribed: vi.fn(), boardFor: () => mocks.board }),
}))

vi.mock('@/stores/agents', () => ({
  useAgentsStore: () => ({
    agents: [{ id: 'a1', name: '小林', avatar: '🙂' }],
    displayAgent: (agentId?: string | null) => ({
      id: agentId || '',
      name: agentId === 'a1' ? '小林' : '成员',
      title: '架构',
      avatar: '🙂',
      avatarImage: '',
      color: '#a33',
      kind: 'agent',
      status: 'active',
    }),
    openAgentSpace: vi.fn(),
  }),
}))

vi.mock('@/composables/useChatSession', () => ({
  useChatSession: () => ({
    messages: ref(mocks.messages),
    isLoading: ref(false),
    isGenerating: ref(false),
    sendMessage: vi.fn(),
    steerMessage: vi.fn(),
    queueFollowUpMessage: vi.fn(),
    stopGeneration: vi.fn(),
  }),
}))

// markdown 渲染链本身不在本组测试的射程里(它由 message/ 那边的测试负责);
// 这里只要证明**正文确实交给了它**,而不是 say 树自己写了一个渲染器。
vi.mock('../message/MessageMarkdown.vue', () => ({
  default: {
    name: 'MessageMarkdown',
    props: ['content', 'isUser', 'live', 'isStreaming'],
    template: '<div class="mock-markdown">{{ content }}</div>',
  },
}))

vi.mock('../InputBox.vue', () => ({
  default: {
    name: 'InputBox',
    props: ['placeholder', 'sessionId', 'isLoading'],
    setup(_props: unknown, { expose }: { expose: (api: Record<string, unknown>) => void }) {
      expose({
        focus: vi.fn(),
        insertPromptReference: vi.fn(),
        clearInput: vi.fn(),
        restoreSnapshot: vi.fn(),
        getMessageInput: () => '',
        getQuotedText: () => '',
        getAttachments: () => [],
      })
      return {}
    },
    template: '<div class="mock-input-box" />',
  },
}))
vi.mock('../CollabTypingLine.vue', () => ({
  default: { name: 'CollabTypingLine', template: '<div class="mock-typing" />' },
}))
vi.mock('../BackgroundJobsStatusBar.vue', () => ({
  default: { name: 'BackgroundJobsStatusBar', template: '<div class="mock-jobs" />' },
}))
vi.mock('../ComposerReplyBar.vue', () => ({
  default: { name: 'ComposerReplyBar', template: '<div class="mock-reply" />' },
}))

const T0 = new Date('2026-07-31T09:00:00').getTime()
const MINUTE = 60 * 1000

const ROOM_MESSAGES = [
  { id: 'm1', role: 'user', content: '@小林 结论呢', timestamp: T0 },
  { id: 'm2', role: 'assistant', agentId: 'a1', content: '## 结论\n\n通过。', timestamp: T0 + MINUTE },
  { id: 'm3', role: 'assistant', agentId: 'a1', content: '剩下的坑在多 profile。', timestamp: T0 + 2 * MINUTE },
]

function mountSurface() {
  return mount(RoomSurface, { props: { sessionId: 'room-1' } })
}

describe('RoomSurface — say 聊天面', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.board = undefined
    mocks.messages = ROOM_MESSAGES
    mocks.chatFontSize = undefined
    mocks.session = { id: 'room-1', name: '浏览器重构', kind: 'room', room: { memberAgentIds: ['a1', 'a2'] } }
  })

  it('署名只有一套:连发的第二条不重复头像与名字', () => {
    const wrapper = mountSurface()
    const rows = wrapper.findAll('.say-row')

    expect(rows).toHaveLength(3)
    expect(rows.map(row => row.classes().includes('is-head'))).toEqual([true, true, false])
    expect(wrapper.findAll('.say-sig')).toHaveLength(2)
    expect(wrapper.findAll('.say-sig-name').map(name => name.text())).toEqual(['我', '小林'])
    // 旧树的署名/头像列一个都不在
    expect(wrapper.find('.collab-sender').exists()).toBe(false)
    expect(wrapper.find('.room-avatar-col').exists()).toBe(false)
    // 行内工具卡那一整套也不在(§8.2)
    expect(wrapper.find('.message-list-row').exists()).toBe(false)
  })

  it('正文交给既有 markdown 渲染链,不是新写的渲染器', () => {
    const bodies = mountSurface().findAll('.mock-markdown').map(node => node.text())

    expect(bodies).toHaveLength(3)
    expect(bodies[1]).toContain('## 结论')
  })

  it('滚动锚点靠的还是 data-message-id / data-index,逐字段照旧', () => {
    const rows = mountSurface().findAll('.say-row')

    expect(rows.map(row => row.attributes('data-message-id'))).toEqual(['m1', 'm2', 'm3'])
    expect(rows.map(row => row.attributes('data-index'))).toEqual(['0', '1', '2'])
  })

  it('排版走聊天面档:13 / 1.72,派生行高与之同源', () => {
    const style = mountSurface().find('.room-flow').attributes('style')

    expect(style).toContain('--message-font-size: 13px')
    expect(style).toContain('--message-line-height: 1.72')
    // 13 × 1.72 = 22.36 → 22px
    expect(style).toContain('--message-line-height-px: 22px')
    expect(style).toContain('--chat-turn-gap: 10px')
  })

  /**
   * 退让闸(R3 收口时补回)。这道闸原本长在 `MessageList` 上,房面脱离旧壳后
   * 一度失联 —— `flowStyles` 变成无条件写档,手动把字号调大过的人进房会被按
   * 回 13px。判据是「与出厂默认值不同」而不是「有值」(density/fontSize 在
   * defaults 里本来就有值)。
   */
  it('用户显式调过字号 → 整档退让,房面不再按聊天面档写死', () => {
    mocks.chatFontSize = 17
    const style = mountSurface().find('.room-flow').attributes('style')

    expect(style ?? '').not.toContain('--message-font-size')
    expect(style ?? '').not.toContain('--chat-turn-gap')
  })

  it('字号仍是出厂默认 → 不算显式选择,聊天面档照常生效', () => {
    mocks.chatFontSize = 15
    const style = mountSurface().find('.room-flow').attributes('style')

    expect(style).toContain('--message-font-size: 13px')
  })

  it('看板上没有带工作台会话的 doing 卡 → 执行入口整个不画', () => {
    expect(mountSurface().find('.say-thread-entry').exists()).toBe(false)
  })

  it('卡还没开过工作台(workSessionIds 空)→ 仍然不画,不派空事件', () => {
    mocks.board = {
      tasks: [{ id: 'task-1', title: '换核验证', status: 'doing', assigneeAgentId: 'a1', workSessionIds: [], updatedAt: T0 }],
    }

    expect(mountSurface().find('.say-thread-entry').exists()).toBe(false)
  })

  it('拿得到 workSessionId → 只在该 agent 最后一段发言末行画一处,派已定契约事件', async () => {
    mocks.board = {
      tasks: [{
        id: 'task-1',
        title: '换核验证',
        status: 'doing',
        assigneeAgentId: 'a1',
        workSessionIds: ['work-0', 'work-9'],
        updatedAt: T0,
      }],
    }

    const wrapper = mountSurface()
    const entries = wrapper.findAll('.say-thread-entry')
    expect(entries).toHaveLength(1)
    // 末行 = m3
    expect(entries[0].element.closest('.say-row')?.getAttribute('data-message-id')).toBe('m3')

    const events: CustomEvent[] = []
    const listener = (event: Event) => events.push(event as CustomEvent)
    window.addEventListener('onething:open-thread', listener)
    await entries[0].trigger('click')
    window.removeEventListener('onething:open-thread', listener)

    // 尾条 workSessionId = 当前那次执行
    expect(events).toHaveLength(1)
    expect(events[0].detail).toEqual({ workSessionId: 'work-9', title: '换核验证', taskId: 'task-1' })
  })
})

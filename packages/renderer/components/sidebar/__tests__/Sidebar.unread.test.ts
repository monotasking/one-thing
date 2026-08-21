// @vitest-environment happy-dom
/**
 * 侧栏未读徽标(docs/design/agent-im-dm.md §6 P4 / D9)。
 *
 * 三处显隐:联系人行(该 agent 的私聊房)、群聊行、「私下」行;外加收起状态下的
 * 「私下」组头替组内那些看不见的行说话。
 *
 * 组件里**不做判定**:未读永远问 store 的 `isUnreadSession`(联系人行只多一步
 * agent → 房 的翻译)。所以这里 mock 掉那一个函数,验证的是"徽标听不听话",
 * 判定本身在 stores/__tests__/sessions-read-marks.test.ts。
 */
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Sidebar from '../Sidebar.vue'

const mocks = vi.hoisted(() => ({
  capabilities: { collabRooms: true },
  formMode: 'collab' as string,
  unread: new Set<string>(),
  dmRooms: new Map<string, { id: string }>(),
  sessionsStore: {
    sessions: [] as Array<Record<string, unknown>>,
    currentSessionId: '',
    groupRoomSessions: [] as Array<Record<string, unknown>>,
    agentPairDmRoomSessions: [] as Array<Record<string, unknown>>,
    agentSessions: [] as Array<Record<string, unknown>>,
    filteredSessions: [] as Array<Record<string, unknown>>,
    sidebarSessions: [] as Array<Record<string, unknown>>,
    radioSessions: [] as Array<Record<string, unknown>>,
    findUserDmRoom: (agentId: string) => mocks.dmRooms.get(agentId),
    isUnreadSession: (sessionId: string) => mocks.unread.has(sessionId),
    loadSessions: vi.fn(async () => {}),
    isNewChatDraftId: () => false,
    updateSessionPin: vi.fn(),
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
  },
  colleagues: [
    { id: 'default', name: '主助理', avatar: '🙂' },
    { id: 'fe', name: '小李', title: '工程师', avatar: '🔧' },
  ],
}))

vi.mock('@/platform', () => ({
  platformApi: {
    get capabilities() { return mocks.capabilities },
  },
}))
vi.mock('@/platform/collab-client', () => ({
  collabApi: {
    dmRoomEnsure: vi.fn(async () => ({ success: true, roomSessionId: 'agent-dm-fe' })),
  },
}))
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => mocks.sessionsStore,
}))
// 项目名册:左栏的项目分组把它与会话推导出来的项目并成一份。这些用例不验
// 项目,给一份空名册即可(空名册 = 只剩推导那一半,即老口径)。
vi.mock('@/stores/projects', () => ({
  useProjectsStore: () => ({ entries: [], load: vi.fn(async () => {}), add: vi.fn(), remove: vi.fn() }),
}))
// 空间(space):这些用例不验空间过滤,给一份"只有默认空间、切换器不画"的
// 降级态即可 —— 与 web 端拿不到 /api/spaces 时是同一份口径。
vi.mock('@/stores/spaces', () => ({
  DEFAULT_SPACE_ID: 'default',
  useSpacesStore: () => ({
    spaces: [{ id: 'default', name: '默认空间', createdAt: 0 }],
    currentSpaceId: 'default',
    showSwitcher: false,
    load: vi.fn(async () => {}),
    switchTo: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
  }),
  sessionBelongsToSpace: () => true,
}))
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ isSessionGenerating: () => false }),
}))
vi.mock('@/stores/workspace', () => ({
  // 形态的归属在 workspace store(D7)—— 侧栏只是读它。这些用例验的是协作
  // 形态里的那三格,所以钉在 collab 上。
  useWorkspaceStore: () => ({
    openSession: vi.fn(),
    get formMode() { return mocks.formMode },
    get availableFormModes() { return mocks.capabilities.collabRooms ? ['chat', 'collab'] : ['chat'] },
    setFormMode: (mode: string) => {
      if (mode === 'collab' && !mocks.capabilities.collabRooms) return
      mocks.formMode = mode
    },
  }),
}))
/*
 * 这一组验的是未读徽标本身。以前它靠 `shellMode: 'classic'`(四区一起平铺)
 * 一次性把联系人 / 群 / 会话都摆出来;形态开关退役后左栏只有 rail 一种形态,
 * 一次只画一类,所以改成把类别落点直接种在 localStorage 上 —— 见下面的
 * `RAIL_KEY`。验的东西一个没变。
 */
vi.mock('@/stores/agents', () => ({
  DEFAULT_AGENT_ID: 'default',
  useAgentsStore: () => ({
    get agents() { return mocks.colleagues },
    get colleagues() { return mocks.colleagues },
    hasLoaded: true,
    loadAgents: vi.fn(async () => []),
    requestAgentDetail: vi.fn(),
  }),
}))
/* 方案三把「进行中」的取数提到了 Sidebar 这一层,所以这一份 store 在 classic 下
   也会被 new 出来 —— 门是 `enabled` 参数,关着时一次 IPC 都不发。 */
vi.mock('@/stores/collabBoard', () => ({
  useCollabBoardStore: () => ({
    boards: {},
    ensureSubscribed: vi.fn(),
    load: vi.fn(async () => {}),
    hasPendingAsk: () => false,
    isRoomTurnActive: () => false,
    typingAgents: () => [],
  }),
}))
vi.mock('../useSessionOrganizer', () => ({
  useSessionOrganizer: () => ({
    getProjectGroupedSessions: () => [],
    toggleCollapse: vi.fn(),
  }),
  // 「消息」类的行尾时间用的是同一份格式化(不另起一套时间口径)。
  formatRelativeTime: (ts: number) => (ts ? `t${ts}` : ''),
}))

function mountSidebar() {
  return mount(Sidebar, {
    global: {
      stubs: {
        SidebarHeader: true,
        SidebarActionGroup: true,
        SessionList: true,
        RoomCreateDialog: true,
        CollapsePanel: true,
        Teleport: true,
      },
    },
  })
}

const ROOM = { id: 'room-1', name: '官网改版组' }
const PAIR = { id: 'agent-dm-room-fe--pm', name: '小李 ⇄ 小王' }

/**
 * 当前 rail 类别的落点(`sidebar-sections.ts` 的常量,这里刻意写死一份当围栏)。
 *
 * Node 25 自带的 Web Storage 全局在没有 `--localstorage-file` 时方法直接抛,
 * 组件里那两处 try/catch 会把读写整个吞掉 —— 于是种不进去。换一个能用的。
 */
const RAIL_KEY = 'onething:sidebar-rail-category'
const railStore = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => railStore.get(key) ?? null,
  setItem: (key: string, value: string) => { railStore.set(key, value) },
  removeItem: (key: string) => { railStore.delete(key) },
  clear: () => { railStore.clear() },
})

beforeEach(() => {
  // 联系人 / 群 / 「私下」三段都住在「通讯录」这一类里。
  railStore.set(RAIL_KEY, 'contacts')
  mocks.capabilities.collabRooms = true
  mocks.formMode = 'collab'
  mocks.unread.clear()
  mocks.dmRooms.clear()
  mocks.sessionsStore.currentSessionId = ''
  mocks.sessionsStore.groupRoomSessions = []
  mocks.sessionsStore.agentPairDmRoomSessions = []
})

describe('侧栏未读徽标', () => {
  it('全读完时一枚点都不画(首启不爆徽标的可见面)', () => {
    mocks.dmRooms.set('fe', { id: 'agent-dm-fe' })
    mocks.sessionsStore.groupRoomSessions = [ROOM]
    mocks.sessionsStore.agentPairDmRoomSessions = [PAIR]
    const wrapper = mountSidebar()
    expect(wrapper.findAll('.sidebar-unread-dot')).toHaveLength(0)
  })

  it('联系人行:TA 的私聊房未读才亮,没建过房的联系人不亮', () => {
    mocks.dmRooms.set('fe', { id: 'agent-dm-fe' })
    mocks.unread.add('agent-dm-fe')
    const wrapper = mountSidebar()

    const rows = wrapper.findAll('.sidebar-contact-item')
    expect(rows.map(row => row.find('.sidebar-room-name').text())).toEqual(['主助理', '小李'])
    // 主助理还没聊过(没有房),不该有点;小李那行有。
    expect(rows[0].find('.sidebar-unread-dot').exists()).toBe(false)
    expect(rows[1].find('.sidebar-unread-dot').exists()).toBe(true)
    expect(rows[1].classes()).toContain('has-unread')
  })

  it('群聊行:未读的群亮点,读过的不亮', () => {
    mocks.sessionsStore.groupRoomSessions = [ROOM, { id: 'room-2', name: '选品组' }]
    mocks.unread.add('room-2')
    const wrapper = mountSidebar()

    const rows = wrapper.findAll('.sidebar-room-item:not(.sidebar-contact-item):not(.sidebar-subgroup-item)')
    expect(rows[0].find('.sidebar-unread-dot').exists()).toBe(false)
    expect(rows[1].find('.sidebar-unread-dot').exists()).toBe(true)
  })

  it('「私下」:收起时组头替组内说话,展开后改由各行自己说', async () => {
    mocks.sessionsStore.agentPairDmRoomSessions = [PAIR]
    mocks.unread.add(PAIR.id)
    const wrapper = mountSidebar()

    const toggle = wrapper.find('.sidebar-subgroup')
    expect(toggle.find('.sidebar-unread-dot').exists()).toBe(true)

    await toggle.trigger('click')
    // 展开后组头闭嘴,点落到那一行上 —— 同一件事不画两遍。
    expect(wrapper.find('.sidebar-subgroup').find('.sidebar-unread-dot').exists()).toBe(false)
    expect(wrapper.find('.sidebar-subgroup-item').find('.sidebar-unread-dot').exists()).toBe(true)
  })

  it('「私下」组头:组内全读完就不亮', () => {
    mocks.sessionsStore.agentPairDmRoomSessions = [PAIR]
    const wrapper = mountSidebar()
    expect(wrapper.find('.sidebar-subgroup').find('.sidebar-unread-dot').exists()).toBe(false)
  })
})

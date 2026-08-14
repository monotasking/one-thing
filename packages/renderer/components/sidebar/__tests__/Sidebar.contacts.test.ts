// @vitest-environment happy-dom
/**
 * 侧栏「联系人」区(docs/design/agent-im-dm.md §4.1 / D1)。
 *
 * 通讯录取的是名册(社交面 `colleagues`)而不是会话列表 —— 没聊过的同事也得
 * 站在那儿,不然"第一次找小李"就没有入口。点一下 = `ensureCollabDmRoom`
 * 幂等建房 + 打开;失败(退休 / service / web 端没有 rooms)必须看得见。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Sidebar from '../Sidebar.vue'

const mocks = vi.hoisted(() => {
  const colleagues: Array<{
    id: string
    name: string
    title?: string
    avatar?: string
  }> = [
    { id: 'fe', name: '小李', title: '工程师', avatar: '🔧' },
    { id: 'default', name: '主助理', avatar: '🙂' },
    { id: 'pm', name: '小王', title: '产品经理', avatar: '📐' },
  ]
  return {
    capabilities: { collabRooms: true },
    formMode: 'collab' as string,
    ensureCollabDmRoom: vi.fn(async (_agentId: string): Promise<{
      success: boolean
      roomSessionId?: string
      error?: string
    }> => ({ success: true, roomSessionId: 'agent-dm-fe' })),
    openSession: vi.fn(),
    loadSessions: vi.fn(async () => {}),
    requestAgentDetail: vi.fn(),
    openAgentSpace: vi.fn(),
    openAgentManager: vi.fn(),
    loadAgents: vi.fn(async () => []),
    sessionsStore: {
      sessions: [] as Array<Record<string, unknown>>,
      currentSessionId: '',
      groupRoomSessions: [] as Array<Record<string, unknown>>,
      agentPairDmRoomSessions: [] as Array<Record<string, unknown>>,
      agentSessions: [] as Array<Record<string, unknown>>,
      filteredSessions: [] as Array<Record<string, unknown>>,
      sidebarSessions: [] as Array<Record<string, unknown>>,
      radioSessions: [] as Array<Record<string, unknown>>,
      findUserDmRoom: vi.fn((_agentId: string) => undefined as undefined | { id: string }),
      isUnreadSession: vi.fn((_sessionId: string) => false),
      loadSessions: vi.fn(async () => {}),
      isNewChatDraftId: () => false,
      updateSessionPin: vi.fn(),
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
    },
    colleagues,
  }
})

vi.mock('@/platform', () => ({
  platformApi: {
    get capabilities() { return mocks.capabilities },
    ensureCollabDmRoom: (agentId: string) => mocks.ensureCollabDmRoom(agentId),
  },
}))
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => {
    mocks.sessionsStore.loadSessions = mocks.loadSessions
    return mocks.sessionsStore
  },
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
    openSession: mocks.openSession,
    get formMode() { return mocks.formMode },
    get availableFormModes() { return mocks.capabilities.collabRooms ? ['chat', 'collab'] : ['chat'] },
    setFormMode: (mode: string) => {
      if (mode === 'collab' && !mocks.capabilities.collabRooms) return
      mocks.formMode = mode
    },
  }),
}))
/*
 * 这一组验的是联系人区的行为。以前它靠 `shellMode: 'classic'`(四区一起平铺)
 * 把联系人区直接摆出来;形态开关退役后左栏只有 rail 一种形态,一次只画一类,
 * 所以改成把类别落点直接种在 localStorage 上 —— 见下面的 `RAIL_KEY`。
 */
vi.mock('@/stores/agents', () => ({
  DEFAULT_AGENT_ID: 'default',
  useAgentsStore: () => ({
    get agents() { return mocks.colleagues },
    get colleagues() { return mocks.colleagues },
    hasLoaded: true,
    loadAgents: mocks.loadAgents,
    requestAgentDetail: mocks.requestAgentDetail,
    openAgentSpace: mocks.openAgentSpace,
    openAgentManager: mocks.openAgentManager,
  }),
}))
/* 方案三把「进行中」的取数提到了 Sidebar 这一层(rail 的徽标在别的类别被选中时
   也得算),所以这一份 store 在 classic 下也会被 new 出来 —— 门是 `enabled`
   参数,关着的时候一次订阅、一次补齐都不发(Sidebar.workbench.test.ts 钉住)。 */
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

/**
 * The sidebar now hangs three `ContextMenu`s (workspace / session / contact) —
 * the session one stopped being `SessionContextMenu` when P1 folded that
 * parallel implementation into the shared kernel. Pick the one that is actually
 * showing instead of the first in document order.
 */
function openMenu(wrapper: ReturnType<typeof mountSidebar>) {
  const menu = wrapper.findAllComponents({ name: 'ContextMenu' })
    .find(candidate => candidate.props('show') === true)
  if (!menu) throw new Error('no ContextMenu is open')
  return menu
}

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
  // 同事与群两段都住在「通讯录」这一类里。
  railStore.set(RAIL_KEY, 'contacts')
  mocks.capabilities.collabRooms = true
  mocks.formMode = 'collab'
  mocks.ensureCollabDmRoom.mockReset()
  mocks.ensureCollabDmRoom.mockResolvedValue({ success: true, roomSessionId: 'agent-dm-fe' })
  mocks.openSession.mockReset()
  mocks.loadSessions.mockReset()
  mocks.requestAgentDetail.mockReset()
  mocks.openAgentSpace.mockReset()
  mocks.sessionsStore.currentSessionId = ''
  mocks.sessionsStore.groupRoomSessions = []
  mocks.sessionsStore.agentPairDmRoomSessions = []
  mocks.sessionsStore.findUserDmRoom = vi.fn(() => undefined)
})

/**
 * 「私下」= 双成员 dm 房(agent 互聊,§4.1/D4)。群聊区**里**的折叠子分组:
 * 透明制要求它看得见(不是暗通道),而它又是旁支,所以默认收起。
 */
describe('Sidebar 群聊区 ·「私下」折叠分组', () => {
  const PAIR = { id: 'agent-dm-room-fe--pm', name: '小李 ⇄ 小王' }

  it('没有 agent 互聊房时,分组整块不渲染', () => {
    const wrapper = mountSidebar()
    expect(wrapper.find('.sidebar-subgroup').exists()).toBe(false)
  })

  it('默认收起:只有一行折叠头 + 计数,房间行要点开才出现', async () => {
    mocks.sessionsStore.agentPairDmRoomSessions = [PAIR]
    const wrapper = mountSidebar()

    const toggle = wrapper.find('.sidebar-subgroup')
    expect(toggle.exists()).toBe(true)
    expect(toggle.find('.sidebar-subgroup-label').text()).toBe('私下')
    expect(toggle.find('.sidebar-subgroup-count').text()).toBe('1')
    expect(wrapper.find('.sidebar-subgroup-item').exists()).toBe(false)

    await toggle.trigger('click')
    const rows = wrapper.findAll('.sidebar-subgroup-item')
    expect(rows).toHaveLength(1)
    expect(rows[0].find('.sidebar-room-name').text()).toBe('小李 ⇄ 小王')
  })

  it('房间行走与群聊行同一条打开链路', async () => {
    mocks.sessionsStore.agentPairDmRoomSessions = [PAIR]
    const wrapper = mountSidebar()
    await wrapper.find('.sidebar-subgroup').trigger('click')
    await wrapper.find('.sidebar-subgroup-item').trigger('click')
    expect(mocks.openSession).toHaveBeenCalledWith(PAIR.id)
  })

  it('群聊区那一列不受影响:普通群仍然直接铺在外面', () => {
    mocks.sessionsStore.groupRoomSessions = [{ id: 'room-1', name: '官网改版组' }]
    mocks.sessionsStore.agentPairDmRoomSessions = [PAIR]
    const wrapper = mountSidebar()
    const plain = wrapper.findAll('.sidebar-room-item:not(.sidebar-contact-item):not(.sidebar-subgroup-item)')
    expect(plain.map(row => row.find('.sidebar-room-name').text())).toEqual(['官网改版组'])
  })
})

describe('Sidebar 联系人区', () => {
  it('把名册画成联系人行:头像 + 名字 + 职位,主助理置顶', () => {
    const wrapper = mountSidebar()
    const rows = wrapper.findAll('.sidebar-contact-item')
    expect(rows).toHaveLength(3)
    // D1/M5:主助理是第一位联系人,其余保持名册顺序。
    expect(rows.map(row => row.find('.sidebar-room-name').text()))
      .toEqual(['主助理', '小李', '小王'])
    expect(rows[1].find('.sidebar-contact-title').text()).toBe('工程师')
    // 没有职位的一行不该凭空长出一个空标签。
    expect(rows[0].find('.sidebar-contact-title').exists()).toBe(false)
    expect(rows[1].text()).toContain('🔧')
  })

  it('点一下 = 幂等建房 → 刷新列表 → 打开那间房', async () => {
    const wrapper = mountSidebar()
    await wrapper.findAll('.sidebar-contact-item')[1].trigger('click')
    await flushPromises()

    expect(mocks.ensureCollabDmRoom).toHaveBeenCalledWith('fe')
    // 新建的房要先进列表,openSession 才认得它(RoomCreateDialog 同款动线)。
    expect(mocks.loadSessions).toHaveBeenCalled()
    expect(mocks.openSession).toHaveBeenCalledWith('agent-dm-fe')
    expect(wrapper.find('.sidebar-contacts-error').exists()).toBe(false)
  })

  it('建房被拒:一行墨说出来,绝不静默无反应', async () => {
    mocks.ensureCollabDmRoom.mockResolvedValue({ success: false, error: '这个 agent 已退休' })
    const wrapper = mountSidebar()
    await wrapper.findAll('.sidebar-contact-item')[1].trigger('click')
    await flushPromises()

    expect(mocks.openSession).not.toHaveBeenCalled()
    expect(wrapper.find('.sidebar-contacts-error').text()).toBe('这个 agent 已退休')
  })

  it('已经聊过的联系人才点亮 —— 房是惰性建的', async () => {
    mocks.sessionsStore.findUserDmRoom = vi.fn((agentId: string) =>
      agentId === 'fe' ? { id: 'agent-dm-fe' } : undefined)
    mocks.sessionsStore.currentSessionId = 'agent-dm-fe'
    const wrapper = mountSidebar()
    const rows = wrapper.findAll('.sidebar-contact-item')
    expect(rows[1].classes()).toContain('is-active')
    expect(rows[0].classes()).not.toContain('is-active')
  })

  it('右键两条岔开:「配置 Agent」进管理页,「打开空间」进右栏', async () => {
    const wrapper = mountSidebar()
    await wrapper.findAll('.sidebar-contact-item')[1].trigger('contextmenu')

    const menu = openMenu(wrapper)
    expect(menu.props('items')).toEqual([
      { id: 'agent-space', label: '打开空间' },
      { id: 'configure-agent', label: '配置 Agent' },
    ])
    expect(menu.props('show')).toBe(true)

    /* 「配置 Agent」是名册面的动作(新建/退休/恢复/通览),仍去管理页;
       点头像与「打开空间」才落右栏(agent-space-workbench.md P1)。 */
    menu.vm.$emit('select', 'configure-agent')
    await wrapper.vm.$nextTick()
    expect(mocks.openAgentManager).toHaveBeenCalledWith('fe', 'config')
    expect(mocks.openAgentSpace).not.toHaveBeenCalled()
  })

  /* 三入口归一(agent-im-chat-ui.md C3):右键必须真的把空间页停在那一面,
     否则用户点完还得自己再切一次 tab。 */
  it('「打开空间」带上 tab 意图,直接把空间页停在会话那一面', async () => {
    const wrapper = mountSidebar()
    await wrapper.findAll('.sidebar-contact-item')[1].trigger('contextmenu')

    const menu = openMenu(wrapper)
    menu.vm.$emit('select', 'agent-space')
    await wrapper.vm.$nextTick()
    expect(mocks.openAgentSpace).toHaveBeenCalledWith('fe', 'sessions')
  })

  /* §4.1「Agent 组」退役:基础设施转录放在通讯录层级是错位的,它整块搬进了
     履历页「群聊」栏。侧栏从此只剩 联系人 / 群聊 / 会话 三段。 */
  it('Agent 组已退役:哪怕有执行会话,侧栏也不再长出那一块', () => {
    mocks.sessionsStore.sessions = [
      { id: 'room-1', name: '官网改版组', kind: 'room', updatedAt: 5 },
      {
        id: 'agent-exec-fe-room-1',
        name: '[执行] 小李',
        kind: 'agent',
        agentId: 'fe',
        updatedAt: 5,
        collab: { roomSessionId: 'room-1' },
      },
    ]
    mocks.sessionsStore.agentSessions = [mocks.sessionsStore.sessions[1]]

    const wrapper = mountSidebar()
    expect(wrapper.find('.sidebar-agents').exists()).toBe(false)
    expect(wrapper.find('.sidebar-agent-exec').exists()).toBe(false)
    expect(wrapper.find('.sidebar-agent-detail').exists()).toBe(false)
    // 联系人区不受影响 —— 行为守恒只针对被退役的那一块。
    expect(wrapper.findAll('.sidebar-contact-item')).toHaveLength(3)

    mocks.sessionsStore.sessions = []
    mocks.sessionsStore.agentSessions = []
  })

  it('web 端整块不渲染:私聊是房,rooms 是 desktop-only 能力', () => {
    mocks.capabilities.collabRooms = false
    const wrapper = mountSidebar()
    expect(wrapper.find('.sidebar-contacts').exists()).toBe(false)
    expect(wrapper.findAll('.sidebar-contact-item')).toHaveLength(0)
  })
})

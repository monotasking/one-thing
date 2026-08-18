// @vitest-environment happy-dom
/**
 * 空间页「会话」面(docs/design/agent-im-dm.md §4.2 的履历四栏,在
 * agent-im-chat-ui.md §3.2 里升格为空间页的一面,改名「会话」)。
 *
 * 侧栏「Agent 组」退役后,一个 agent 的执行现场只剩这一个入口,所以这页要能
 * 回答四个问题:和你聊过什么 / 在哪些群 / 私下和谁聊过 / 干过哪些活。
 *
 * 三条纪律钉在这儿:
 *  - 四栏的**归类**不在组件里:它吃 store 的 `agentPresence` /
 *    `agentDirectChatSessions`(单点),组件只摆行 —— 所以这些用例喂的是
 *    presence,断言的是"摆对没有";
 *  - archived 的执行会话必须可达(履历是"干过什么",不是"还开着什么");
 *  - 卡标题现查、查不到退短号(Q4:状态永不入快照);
 *  - 退休的人照常有履历 —— 那正是"退休不是删除"要保住的东西。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import AgentsPanelContent from '../AgentsPanelContent.vue'

const mocks = vi.hoisted(() => ({
  agentsStore: null as any,
  settingsStore: null as any,
  sessionsStore: null as any,
  workspaceStore: null as any,
  boardStore: null as any,
  getTools: vi.fn().mockResolvedValue({ success: true, tools: [] }),
  ensureCollabDmRoom: vi.fn(),
}))

vi.mock('@/stores/agents', () => ({
  DEFAULT_AGENT_ID: 'default',
  useAgentsStore: () => mocks.agentsStore,
}))
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => mocks.settingsStore }))
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => mocks.sessionsStore }))
vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => mocks.workspaceStore }))
vi.mock('@/stores/collabBoard', () => ({ useCollabBoardStore: () => mocks.boardStore }))
vi.mock('@/platform', () => ({
  platformApi: {
    get getTools() { return mocks.getTools },
    ensureCollabDmRoom: (agentId: string) => mocks.ensureCollabDmRoom(agentId),
  },
}))

const AGENT = {
  id: 'fe',
  name: '小李',
  title: '工程师',
  systemPrompt: 'be useful',
  isDefault: false,
  createdAt: 1,
  updatedAt: 2,
}

const DM_ROOM = {
  id: 'agent-dm-fe',
  name: '小李',
  kind: 'room',
  updatedAt: 900,
  messageCount: 6,
  room: { dm: true, memberAgentIds: ['fe'] },
}
const GROUP_ROOM = { id: 'room-1', name: '官网改版组', kind: 'room', updatedAt: 800 }
const EXEC_IN_GROUP = {
  id: 'agent-exec-fe-room-1',
  name: '[执行] 小李',
  kind: 'agent',
  agentId: 'fe',
  updatedAt: 700,
  // 履历要看得见 archived 的执行会话 —— 它本来就骑着这个标志躲开所有列表。
  isArchived: true,
  collab: { roomSessionId: 'room-1' },
}
const DIRECT_CHAT = { id: 'chat-1', name: '排查登录', kind: 'chat', agentId: 'fe', updatedAt: 600 }
const WORK_SESSION = {
  id: 'work-9',
  name: '[任务] 修登录',
  kind: 'work',
  agentId: 'fe',
  updatedAt: 500,
  collab: { roomSessionId: 'room-1', taskId: 'task-abcdefgh-1' },
}
/** 别人的东西:一条都不该被这个 agent 的履历收进去。 */
const OTHER_AGENT_CHAT = { id: 'chat-x', name: '别人的会话', kind: 'chat', agentId: 'pm', updatedAt: 999 }

const ALL_SESSIONS = [DM_ROOM, GROUP_ROOM, EXEC_IN_GROUP, DIRECT_CHAT, WORK_SESSION, OTHER_AGENT_CHAT]

/** 真实 store 的口径由 `computeAgentPresence` 给;这里按同一规则手写夹具。 */
const FULL_PRESENCE = {
  dmRoomId: 'agent-dm-fe',
  roomSessionIds: ['room-1'],
  execSessionIds: ['agent-exec-fe-room-1'],
  workSessionIds: ['work-9'],
}
const EMPTY_PRESENCE = {
  dmRoomId: null,
  roomSessionIds: [],
  execSessionIds: [],
  workSessionIds: [],
}

async function mountPanel() {
  const wrapper = mount(AgentsPanelContent)
  await nextTick()
  await nextTick()
  await nextTick()
  return wrapper
}

function tabButton(wrapper: any, label: string) {
  return wrapper.findAll('.detail-tabs .mode-option').find((b: any) => b.text() === label)
}

function column(wrapper: any, label: string) {
  return wrapper
    .findAll('.history-column')
    .find((section: any) => section.find('.field-label').text() === label)
}

async function openHistory(wrapper: any) {
  await tabButton(wrapper, '会话')!.trigger('click')
  await nextTick()
}

beforeEach(() => {

  // 空间层(批 B9)从 ModelSelector / ThinkToggle / InputBox 一路读到这里,

  // 它住在 pinia 里 —— 独立挂载的组件测试也得有一个 pinia。

  setActivePinia(createPinia())
  mocks.getTools = vi.fn().mockResolvedValue({ success: true, tools: [] })
  mocks.ensureCollabDmRoom = vi.fn().mockResolvedValue({ success: true, roomSessionId: 'agent-dm-fe' })

  mocks.agentsStore = reactive({
    agents: [AGENT],
    activeAgents: [AGENT],
    retiredAgents: [],
    isLoading: false,
    error: null,
    defaultAgent: AGENT,
    pendingDetailAgentId: null,
    pendingDetailTab: null,
    requestAgentDetail: vi.fn(),
    consumeAgentDetailRequest: vi.fn().mockReturnValue(null),
    loadAgents: vi.fn().mockResolvedValue([AGENT]),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    restoreAgent: vi.fn(),
  })

  mocks.sessionsStore = reactive({
    sessions: ALL_SESSIONS,
    roomSessions: [DM_ROOM, GROUP_ROOM],
    groupRoomSessions: [GROUP_ROOM],
    agentPresence: vi.fn(() => FULL_PRESENCE),
    agentDirectChatSessions: vi.fn(() => [DIRECT_CHAT]),
    loadSessions: vi.fn().mockResolvedValue(undefined),
    createSessionWithoutSwitch: vi.fn(),
    updateSessionAgent: vi.fn().mockResolvedValue({ success: true }),
  })

  mocks.workspaceStore = reactive({ openSession: vi.fn() })
  mocks.boardStore = reactive({
    load: vi.fn().mockResolvedValue(undefined),
    findTask: vi.fn((taskId: string) =>
      taskId === 'task-abcdefgh-1' ? { roomSessionId: 'room-1', task: { title: '修登录' } } : undefined),
  })

  mocks.settingsStore = reactive({
    availableProviders: [],
    settings: {},
    loadProviders: vi.fn().mockResolvedValue([]),
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('空间页 · tab', () => {
  it('空间页四面并列,默认停在配置', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.findAll('.detail-tabs .mode-option').map((b: any) => b.text()))
      .toEqual(['配置', '会话', '文件', '搜索'])
    expect(wrapper.find('.agent-history').exists()).toBe(false)
  })

  it('切到会话:配置表单与 save 一起收起 —— 会话面是只读的一面', async () => {
    const wrapper = await mountPanel()
    await openHistory(wrapper)
    expect(wrapper.find('.agent-history').exists()).toBe(true)
    // save/cancel 随整张配置表单一起收起(表单现在是共享件 AgentConfigForm)。
    expect(wrapper.find('.agent-config-form').attributes('style')).toContain('display: none')
  })
})

describe('会话面 · 四栏归类', () => {
  it('与你的对话:私聊房置顶 + 直聊,别人的会话一条不收', async () => {
    const wrapper = await mountPanel()
    await openHistory(wrapper)

    const rows = column(wrapper, '与你的对话')!.findAll('.history-line')
    expect(rows.map((row: any) => row.find('.history-name').text())).toEqual(['小李', '排查登录'])
    expect(rows[0].text()).toContain('6 条')
    expect(wrapper.text()).not.toContain('别人的会话')
  })

  it('群聊:按房间现名署名的执行会话,archived 也照常可达', async () => {
    const wrapper = await mountPanel()
    await openHistory(wrapper)

    const rows = column(wrapper, '群聊')!.findAll('.history-line')
    expect(rows).toHaveLength(1)
    expect(rows[0].find('.history-name').text()).toBe('群「官网改版组」')
    expect(rows[0].attributes('aria-label')).toContain('只读转录')
  })

  it('私下:P3 前恒空,空态文案照常渲染', async () => {
    const wrapper = await mountPanel()
    await openHistory(wrapper)

    const section = column(wrapper, '私下')!
    expect(section.findAll('.history-line')).toHaveLength(0)
    expect(section.find('.field-hint').text()).toContain('私下聊过')
  })

  it('干过的活:按卡分组,卡标题从看板现查', async () => {
    const wrapper = await mountPanel()
    await openHistory(wrapper)

    const section = column(wrapper, '干过的活')!
    expect(section.find('.history-group-title').text()).toBe('修登录')
    expect(section.findAll('.history-line')).toHaveLength(1)
  })

  it('卡标题查不到就退到短号,绝不猜一个标题出来', async () => {
    mocks.boardStore.findTask = vi.fn(() => undefined)
    const wrapper = await mountPanel()
    await openHistory(wrapper)

    expect(column(wrapper, '干过的活')!.find('.history-group-title').text()).toBe('#task-abc')
  })

  it('进会话面自己补拉看板 —— 冷启动时标题否则全线落空', async () => {
    const wrapper = await mountPanel()
    await openHistory(wrapper)
    expect(mocks.boardStore.load).toHaveBeenCalledWith('room-1')
  })
})

describe('会话面 · 空态与跳转', () => {
  it('点一行就打开那条会话并合上面板', async () => {
    const wrapper = await mountPanel()
    await openHistory(wrapper)

    await column(wrapper, '群聊')!.find('.history-line').trigger('click')
    expect(mocks.workspaceStore.openSession).toHaveBeenCalledWith('agent-exec-fe-room-1')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('一条都没有:「还没和小李聊过 → 发起对话」,走 ensureCollabDmRoom 链路', async () => {
    mocks.sessionsStore.agentPresence = vi.fn(() => EMPTY_PRESENCE)
    mocks.sessionsStore.agentDirectChatSessions = vi.fn(() => [])
    const wrapper = await mountPanel()
    await openHistory(wrapper)

    const section = column(wrapper, '与你的对话')!
    expect(section.find('.field-hint').text()).toContain('还没和小李聊过')

    const start = section.findAll('.text-action').find((b: any) => b.text() === '发起对话')!
    await start.trigger('click')
    await flushPromises()

    expect(mocks.ensureCollabDmRoom).toHaveBeenCalledWith('fe')
    // 新建的房要先进列表,openSession 才认得它(侧栏联系人行同款动线)。
    expect(mocks.sessionsStore.loadSessions).toHaveBeenCalled()
    expect(mocks.workspaceStore.openSession).toHaveBeenCalledWith('agent-dm-fe')
  })

  it('建房被拒:一行墨说出来,绝不静默无反应', async () => {
    mocks.sessionsStore.agentPresence = vi.fn(() => EMPTY_PRESENCE)
    mocks.sessionsStore.agentDirectChatSessions = vi.fn(() => [])
    mocks.ensureCollabDmRoom = vi.fn().mockResolvedValue({ success: false, error: '这个 agent 已退休' })
    const wrapper = await mountPanel()
    await openHistory(wrapper)

    const section = column(wrapper, '与你的对话')!
    await section.findAll('.text-action').find((b: any) => b.text() === '发起对话')!.trigger('click')
    await flushPromises()

    expect(mocks.workspaceStore.openSession).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('这个 agent 已退休')
  })
})

describe('会话面 · 退休的人', () => {
  it('墓碑照样有履历 —— 那正是保留身份面的全部意义', async () => {
    const retired = { ...AGENT, status: 'retired' as const }
    mocks.agentsStore.agents = [retired]
    mocks.agentsStore.activeAgents = []
    mocks.agentsStore.retiredAgents = [retired]
    mocks.agentsStore.defaultAgent = retired

    const wrapper = await mountPanel()
    await openHistory(wrapper)

    expect(wrapper.find('.agent-history').exists()).toBe(true)
    expect(column(wrapper, '群聊')!.findAll('.history-line')).toHaveLength(1)
  })
})

describe('空间页 · 跳转意图', () => {
  it('右键「打开空间」带来的 tab 意图会被采纳,并被一起吃掉', async () => {
    mocks.agentsStore.consumeAgentDetailRequest = vi.fn(() => {
      mocks.agentsStore.pendingDetailAgentId = null
      mocks.agentsStore.pendingDetailTab = null
      return 'fe'
    })
    const wrapper = await mountPanel()

    mocks.agentsStore.pendingDetailTab = 'sessions'
    mocks.agentsStore.pendingDetailAgentId = 'fe'
    await nextTick()
    await nextTick()

    expect(wrapper.find('.agent-history').exists()).toBe(true)
    expect(mocks.agentsStore.pendingDetailAgentId).toBeNull()
  })
})

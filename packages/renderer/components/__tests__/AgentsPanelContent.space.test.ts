// @vitest-environment happy-dom
/**
 * Agent 空间页(docs/design/agent-im-chat-ui.md C3/§3.2,IM 化 P2)。
 *
 * 点头像进的是"我与 TA 的空间":先是**这个人**(资料块),再是聊过什么(会话)、
 * 放了什么(文件)、找什么(搜索)。Q5 拍板后中间那张联系人小卡退役,它的两个
 * 动作由资料块承接 —— 所以这一页要能顶得住:
 *
 *  - 资料块:大头像 + 名字 + 职位 + 说明,「发消息」走 collabApi.dmRoomEnsure(与
 *    联系人区同一条链路),退休的人禁用并挂墓碑;
 *  - 文件:私聊房 folder 走主进程列目录(folder 的位置只有它算得出),交付物
 *    读看板既有 evidence,还原不出绝对路径的行不给点;
 *  - 搜索:P2 只做本地过滤(会话名/群名/卡标题),并且明说全文搜索是后续能力
 *    —— 绝不做假全文。
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
  getTools: vi.fn(),
  dmRoomEnsure: vi.fn(),
  roomFolderList: vi.fn(),
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
  },
}))
vi.mock('@/platform/collab-client', () => ({
  collabApi: {
    get roomFolderList() { return mocks.roomFolderList },
    dmRoomEnsure: (request: { agentId: string }) => mocks.dmRoomEnsure(request),
  },
}))

const AGENT = {
  id: 'fe',
  name: '小李',
  title: '工程师',
  description: '前端,爱把东西做小。',
  avatar: '🔧',
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
const GROUP_ROOM = {
  id: 'room-1',
  name: '官网改版组',
  kind: 'room',
  updatedAt: 800,
  workingDirectory: '/w/site',
}
const EXEC_IN_GROUP = {
  id: 'agent-exec-fe-room-1',
  name: '[执行] 小李',
  kind: 'agent',
  agentId: 'fe',
  updatedAt: 700,
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

const ALL_SESSIONS = [DM_ROOM, GROUP_ROOM, EXEC_IN_GROUP, DIRECT_CHAT, WORK_SESSION]

const FULL_PRESENCE = {
  dmRoomId: 'agent-dm-fe',
  roomSessionIds: ['room-1'],
  execSessionIds: ['agent-exec-fe-room-1'],
  workSessionIds: ['work-9'],
}

const FOLDER_ENTRIES = [
  { relativePath: '方案.md', path: '/store/rooms/agent-dm-fe/方案.md', size: 2048, mtimeMs: 1700 },
  { relativePath: 'notes/草稿.txt', path: '/store/rooms/agent-dm-fe/notes/草稿.txt', size: 12, mtimeMs: 1600 },
]

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

async function openTab(wrapper: any, label: string) {
  await tabButton(wrapper, label)!.trigger('click')
  await flushPromises()
  await nextTick()
}

function column(wrapper: any, label: string) {
  return wrapper
    .findAll('.files-column')
    .find((section: any) => section.find('.field-label').text() === label)
}

beforeEach(() => {

  // 空间层(批 B9)从 ModelSelector / ThinkToggle / InputBox 一路读到这里,

  // 它住在 pinia 里 —— 独立挂载的组件测试也得有一个 pinia。

  setActivePinia(createPinia())
  mocks.getTools = vi.fn().mockResolvedValue({ success: true, tools: [] })
  mocks.dmRoomEnsure = vi.fn().mockResolvedValue({ success: true, roomSessionId: 'agent-dm-fe' })
  mocks.roomFolderList = vi.fn().mockResolvedValue({
    success: true,
    folder: '/store/rooms/agent-dm-fe',
    entries: FOLDER_ENTRIES,
    missing: false,
    truncated: false,
  })

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
    openAgentSpace: vi.fn(),
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
      taskId === 'task-abcdefgh-1'
        ? {
            roomSessionId: 'room-1',
            task: {
              title: '修登录',
              report: { summary: 'done', evidence: { files: ['src/login.ts', '/abs/report.md'] } },
            },
          }
        : undefined),
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

describe('空间页 · 资料块', () => {
  it('第一眼是这个人:头像 + 名字 + 职位 + 说明', async () => {
    const wrapper = await mountPanel()
    const profile = wrapper.find('.agent-profile')
    expect(profile.exists()).toBe(true)
    expect(profile.find('.profile-name').text()).toBe('小李')
    expect(profile.find('.profile-title').text()).toBe('工程师')
    expect(profile.text()).toContain('🔧')
    expect(wrapper.find('.profile-description').text()).toContain('爱把东西做小')
  })

  it('「发消息」走 collabApi.dmRoomEnsure —— 与联系人区同一条链路', async () => {
    const wrapper = await mountPanel()
    const send = wrapper.findAll('.agent-profile .text-action').find((b: any) => b.text() === '发消息')!
    await send.trigger('click')
    await flushPromises()

    expect(mocks.dmRoomEnsure).toHaveBeenCalledWith({ agentId: 'fe' })
    expect(mocks.sessionsStore.loadSessions).toHaveBeenCalled()
    expect(mocks.workspaceStore.openSession).toHaveBeenCalledWith('agent-dm-fe')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('「配置」把空间页切回配置那一面', async () => {
    const wrapper = await mountPanel()
    await openTab(wrapper, '会话')
    expect(wrapper.find('.agent-history').exists()).toBe(true)

    const configure = wrapper.findAll('.agent-profile .text-action').find((b: any) => b.text() === '配置')!
    await configure.trigger('click')
    await nextTick()
    expect(wrapper.find('.agent-history').exists()).toBe(false)
    expect(wrapper.find('.editor-footer').attributes('style') || '').not.toContain('display: none')
  })

  it('退休的人:墓碑照挂,「发消息」禁用 —— TA 不再接活,后端也会拒', async () => {
    const retired = { ...AGENT, status: 'retired' as const }
    mocks.agentsStore.agents = [retired]
    mocks.agentsStore.activeAgents = []
    mocks.agentsStore.retiredAgents = [retired]
    mocks.agentsStore.defaultAgent = retired

    const wrapper = await mountPanel()
    expect(wrapper.find('.profile-tombstone').text()).toContain('已注销')
    const send = wrapper.findAll('.agent-profile .text-action').find((b: any) => b.text() === '发消息')!
    expect(send.attributes('disabled')).toBeDefined()
  })

  it('草稿 agent 没有资料块也没有四面 —— 还不是一个人', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('.agents-new').trigger('click')
    await nextTick()
    expect(wrapper.find('.agent-profile').exists()).toBe(false)
    expect(wrapper.find('.detail-tabs').exists()).toBe(false)
  })
})

describe('空间页 · 四面切换', () => {
  it('四面并列,一次只画一面', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.findAll('.detail-tabs .mode-option').map((b: any) => b.text()))
      .toEqual(['配置', '会话', '文件', '搜索'])

    await openTab(wrapper, '文件')
    expect(wrapper.find('.agent-files').exists()).toBe(true)
    expect(wrapper.find('.agent-history').exists()).toBe(false)
    expect(wrapper.find('.agent-search').exists()).toBe(false)

    await openTab(wrapper, '搜索')
    expect(wrapper.find('.agent-search').exists()).toBe(true)
    expect(wrapper.find('.agent-files').exists()).toBe(false)
  })

  it('只读的三面都收起 save —— cancel/save 属于配置那一面', async () => {
    const wrapper = await mountPanel()
    for (const tab of ['会话', '文件', '搜索']) {
      await openTab(wrapper, tab)
      expect(wrapper.find('.agent-config-form').attributes('style')).toContain('display: none')
    }
  })

  it('跳转意图认得新 tab 名:寄存 files 就停在文件面', async () => {
    mocks.agentsStore.consumeAgentDetailRequest = vi.fn(() => {
      mocks.agentsStore.pendingDetailAgentId = null
      mocks.agentsStore.pendingDetailTab = null
      return 'fe'
    })
    const wrapper = await mountPanel()

    mocks.agentsStore.pendingDetailTab = 'files'
    mocks.agentsStore.pendingDetailAgentId = 'fe'
    await nextTick()
    await flushPromises()

    expect(wrapper.find('.agent-files').exists()).toBe(true)
  })
})

describe('空间页 · 文件面', () => {
  it('私聊房 folder 按房间 id 列目录,行上是相对路径 + 大小', async () => {
    const wrapper = await mountPanel()
    await openTab(wrapper, '文件')

    expect(mocks.roomFolderList).toHaveBeenCalledWith({ roomSessionId: 'agent-dm-fe' })
    const rows = column(wrapper, '私聊文件')!.findAll('.history-line')
    expect(rows.map((row: any) => row.find('.history-name').text()))
      .toEqual(['方案.md', 'notes/草稿.txt'])
    expect(rows[0].text()).toContain('2 KB')
  })

  it('点一行走既有 openFile 链路(不自己造第二条开文件的路)', async () => {
    const opened: string[] = []
    const listener = (event: Event) => {
      opened.push((event as CustomEvent<{ filePath?: string }>).detail?.filePath || '')
    }
    window.addEventListener('onething:collab-open-file', listener)
    try {
      const wrapper = await mountPanel()
      await openTab(wrapper, '文件')
      await column(wrapper, '私聊文件')!.find('.history-line').trigger('click')

      expect(opened).toEqual(['/store/rooms/agent-dm-fe/方案.md'])
      expect(wrapper.emitted('close')).toBeTruthy()
    } finally {
      window.removeEventListener('onething:collab-open-file', listener)
    }
  })

  it('目录还没建过是空态,不是错误', async () => {
    mocks.roomFolderList = vi.fn().mockResolvedValue({
      success: true, folder: '/store/rooms/agent-dm-fe', entries: [], missing: true, truncated: false,
    })
    const wrapper = await mountPanel()
    await openTab(wrapper, '文件')

    expect(column(wrapper, '私聊文件')!.find('.field-hint').text()).toContain('还没有放过东西')
  })

  it('列不到就说一句,绝不静默空白', async () => {
    mocks.roomFolderList = vi.fn().mockResolvedValue({ success: false, error: '不支持' })
    const wrapper = await mountPanel()
    await openTab(wrapper, '文件')

    expect(column(wrapper, '私聊文件')!.find('.field-hint').text()).toContain('不支持')
  })

  it('交付物按卡分组:相对路径拿群工作目录还原,绝对路径原样', async () => {
    // 还原后的绝对路径以前挂在行的 title 上,P5 拆原生 tooltip 后只剩点击链路可观测,
    // 于是改成逐行点、收 openFile 事件 —— 断的仍是「还原成了什么路径」。
    const opened: string[] = []
    const listener = (event: Event) => {
      opened.push((event as CustomEvent<{ filePath?: string }>).detail?.filePath || '')
    }
    window.addEventListener('onething:collab-open-file', listener)
    try {
      const wrapper = await mountPanel()
      await openTab(wrapper, '文件')

      const section = column(wrapper, '交付物')!
      expect(section.find('.history-group-title').text()).toBe('修登录')
      const rows = section.findAll('.history-line')
      expect(rows).toHaveLength(2)
      for (const row of rows) await row.trigger('click')

      expect(opened).toEqual(['/w/site/src/login.ts', '/abs/report.md'])
    } finally {
      window.removeEventListener('onething:collab-open-file', listener)
    }
  })

  it('群没有工作目录:相对路径的那一行不给点,而不是点了打不开', async () => {
    mocks.sessionsStore.sessions = ALL_SESSIONS.map(session =>
      session.id === 'room-1' ? { ...session, workingDirectory: '' } : session)
    const wrapper = await mountPanel()
    await openTab(wrapper, '文件')

    const rows = column(wrapper, '交付物')!.findAll('.history-line')
    expect(rows[0].element.tagName).toBe('SPAN')
    expect(rows[0].classes()).toContain('is-inert')
    // 绝对路径那条照常可点。
    expect(rows[1].element.tagName).toBe('BUTTON')
  })
})

describe('空间页 · 搜索面', () => {
  it('空词不出结果,并且明说全文搜索是后续能力', async () => {
    const wrapper = await mountPanel()
    await openTab(wrapper, '搜索')

    expect(wrapper.find('.agent-search').text()).toContain('消息全文搜索是后续能力')
    expect(wrapper.findAll('.agent-search .history-line')).toHaveLength(0)
  })

  it('本地过滤命中会话名,点一行开那条会话', async () => {
    const wrapper = await mountPanel()
    await openTab(wrapper, '搜索')

    await wrapper.find('.agent-search input').setValue('排查')
    await nextTick()

    const rows = wrapper.findAll('.agent-search .history-line')
    expect(rows).toHaveLength(1)
    expect(rows[0].find('.history-name').text()).toBe('排查登录')

    await rows[0].trigger('click')
    expect(mocks.workspaceStore.openSession).toHaveBeenCalledWith('chat-1')
  })

  it('卡标题也在范围里 —— 「干过的活」那一栏的行靠它被找到', async () => {
    const wrapper = await mountPanel()
    await openTab(wrapper, '搜索')

    await wrapper.find('.agent-search input').setValue('修登录')
    await nextTick()

    const rows = wrapper.findAll('.agent-search .history-line')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('修登录')
  })

  it('搜不到就是搜不到,不编一条结果出来', async () => {
    const wrapper = await mountPanel()
    await openTab(wrapper, '搜索')

    await wrapper.find('.agent-search input').setValue('压根没有这个东西')
    await nextTick()

    expect(wrapper.findAll('.agent-search .history-line')).toHaveLength(0)
    expect(wrapper.find('.agent-search').text()).toContain('没有匹配的会话')
  })
})

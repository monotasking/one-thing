// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import AgentSpace from '../AgentSpace.vue'

/**
 * 右栏空间页的契约(agent-space-workbench.md P2):
 *  - 四面**就地**渲染,一次都不许 `openAgentSpace` 跳去 Agents 管理页;
 *  - 行的落点自己不导航,一律往上转给宿主。
 */

const mocks = vi.hoisted(() => ({
  openAgentSpace: vi.fn(),
  ensureCollabDmRoom: vi.fn(async () => ({ success: true, roomSessionId: 'agent-dm-lin' })),
  loadSessions: vi.fn(async () => {}),
  /** 主区此刻看得见的会话 —— 私聊已经摊在主区时,就地那一层不再画第二遍。 */
  visibleSessionIds: new Set<string>(),
  agent: {
    id: 'lin',
    name: '小林',
    title: '架构',
    avatar: '🧭',
    description: '盯架构边界与迁移。',
    systemPrompt: 'you are 小林',
  } as Record<string, unknown>,
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    availableProviders: [],
    settings: { ai: { providers: {} } },
    loadProviders: vi.fn(async () => {}),
    getModelDisplayName: (id: string) => id,
  }),
}))

vi.mock('@/stores/agents', () => ({
  DEFAULT_AGENT_ID: 'default',
  useAgentsStore: () => ({
    agents: [mocks.agent],
    openAgentSpace: mocks.openAgentSpace,
    findAgent: (id: string) => (id === 'lin' ? mocks.agent : null),
    displayAgent: (id: string) =>
      id === 'lin'
        ? { ...mocks.agent, kind: 'colleague', status: 'active' }
        : { id, name: '已注销', kind: 'colleague', status: 'retired' },
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
  }),
}))

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => ({
    sessions: [],
    groupRoomSessions: [],
    agentPresence: () => ({ dmRoomId: '', roomSessionIds: [], execSessionIds: [], workSessionIds: [] }),
    agentDirectChatSessions: () => [],
    loadSessions: mocks.loadSessions,
  }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: () => ({
    get visibleSessionIds() { return mocks.visibleSessionIds },
  }),
}))

// 就地那一层是整棵既有聊天面(ThreadChatDetail → ChatPanel)—— 这里只验它挂上了、
// 挂的是哪一间房,聊天面本身有它自己的测试。
vi.mock('@/components/workbench/ThreadChatDetail.vue', () => ({
  default: {
    name: 'ThreadChatDetail',
    props: ['sessionId', 'tag', 'title'],
    template: '<div class="mock-dm" :data-session="sessionId" :data-tag="tag">{{ title }}</div>',
  },
}))

vi.mock('@/stores/collabBoard', () => ({
  useCollabBoardStore: () => ({ load: vi.fn(), findTask: () => null }),
}))

vi.mock('@/platform', () => ({
  platformApi: {
    ensureCollabDmRoom: mocks.ensureCollabDmRoom,
    getTools: vi.fn(async () => ({ success: true, tools: [] })),
    listCollabRoomFolder: vi.fn(async () => ({ success: true, entries: [] })),
  },
}))

vi.mock('@/components/common/AgentAvatar.vue', () => ({
  default: { name: 'AgentAvatar', props: ['avatar', 'avatarImage', 'size'], template: '<i class="mock-avatar" />' },
}))

function mountSpace(props: Record<string, unknown> = {}) {
  return mount(AgentSpace, { props: { agentId: 'lin', ...props } })
}

async function openFace(wrapper: ReturnType<typeof mountSpace>, label: string) {
  const tab = wrapper.findAll('.space-tab').find(node => node.text() === label)
  await tab!.trigger('click')
}

describe('AgentSpace — 右栏的空间页', () => {
  beforeEach(() => {
    // 空间层(批 B9)从 ModelSelector / ThinkToggle / InputBox 一路读到这里,
    // 它住在 pinia 里 —— 独立挂载的组件测试也得有一个 pinia。
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mocks.visibleSessionIds.clear()
  })

  it('资料块是这个人:名字 / 职位 / 说明', () => {
    const wrapper = mountSpace()
    expect(wrapper.find('.space-name').text()).toBe('小林')
    expect(wrapper.find('.space-subtitle').text()).toBe('架构 · 同事')
    expect(wrapper.find('.space-desc').text()).toContain('盯架构边界')
  })

  // D8 的「大脑」加在**末尾**,默认落点一个字节不变:把落点搬过去是另一个产品
  // 决定,不该顺手夹带在"加一个 tab"里。
  it('五面并列,默认仍停在配置 —— 配置是就地的真表单', () => {
    const wrapper = mountSpace()
    expect(wrapper.findAll('.space-tab').map(node => node.text()))
      .toEqual(['配置', '会话', '文件', '搜索', '大脑'])
    expect(wrapper.find('.agent-config-form').exists()).toBe(true)
  })

  it('切面全部就地渲染,一次都不跳去管理页', async () => {
    const wrapper = mountSpace()

    await openFace(wrapper, '会话')
    expect(wrapper.find('.agent-history').exists()).toBe(true)

    await openFace(wrapper, '文件')
    expect(wrapper.find('.agent-files').exists()).toBe(true)

    await openFace(wrapper, '搜索')
    expect(wrapper.find('.agent-search').exists()).toBe(true)

    expect(mocks.openAgentSpace).not.toHaveBeenCalled()
  })

  it('initialTab 决定进来停在哪一面', () => {
    const wrapper = mountSpace({ initialTab: 'files' })
    expect(wrapper.find('.agent-files').exists()).toBe(true)
    expect(wrapper.find('.agent-config-form').exists()).toBe(false)
  })

  /**
   * 2026-08-01 用户拍板:「我点击发消息,直接就在成员这个 tab 这里打开和他的
   * 私聊对话,别再跑到其他地方」。旧行为(emit 给宿主去主区开页签)只在私聊
   * 已经摊在主区时才保留 —— 见下一条。
   */
  it('「发消息」= 就地展开私聊,不把人甩去主区', async () => {
    const wrapper = mountSpace()
    const send = wrapper.findAll('.space-actions .text-action')[0]
    await send.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mocks.ensureCollabDmRoom).toHaveBeenCalledWith('lin')
    expect(wrapper.emitted('open-session')).toBeUndefined()
    expect(wrapper.find('.mock-dm').attributes('data-session')).toBe('agent-dm-lin')
    expect(wrapper.find('.mock-dm').attributes('data-tag')).toBe('私聊')
    // 资料面让位,返回键换成"回这个人的空间"。
    expect(wrapper.find('.space-hero').exists()).toBe(false)
    expect(wrapper.find('.space-back').text()).toContain('小林')
  })

  it('返回键回到资料面(对话不再占着这一格)', async () => {
    const wrapper = mountSpace()
    await wrapper.findAll('.space-actions .text-action')[0].trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.find('.space-back').trigger('click')
    expect(wrapper.find('.mock-dm').exists()).toBe(false)
    expect(wrapper.find('.space-hero').exists()).toBe(true)
  })

  /** 同一段对话在一屏里画两遍既费地方又分不清该在哪一边说话。 */
  it('这间私聊已经摊在主区时只聚焦主区,不在右栏再画一遍', async () => {
    mocks.visibleSessionIds.add('agent-dm-lin')
    const wrapper = mountSpace()
    await wrapper.findAll('.space-actions .text-action')[0].trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(wrapper.emitted('open-session')?.[0]).toEqual(['agent-dm-lin'])
    expect(wrapper.find('.mock-dm').exists()).toBe(false)
  })

  /** 上一位的私聊留在屏幕上、头顶却写着下一位的名字,是最坏的一种串台。 */
  it('换人 = 换对话:agentId 一变就退回资料面', async () => {
    const wrapper = mountSpace()
    await wrapper.findAll('.space-actions .text-action')[0].trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(wrapper.find('.mock-dm').exists()).toBe(true)

    await wrapper.setProps({ agentId: 'ghost' })
    expect(wrapper.find('.mock-dm').exists()).toBe(false)
  })

  it('在忙时多一颗「看线程」,点了把工作会话交给宿主', async () => {
    const wrapper = mountSpace({
      work: { taskId: 'task-1', title: 'castlabs 换核', shortId: '#task-1', sessionId: 'work-9' },
    })
    expect(wrapper.find('.space-subtitle').text()).toContain('在忙 castlabs 换核')

    const thread = wrapper.findAll('.space-actions .text-action')[1]
    await thread.trigger('click')
    expect(wrapper.emitted('open-thread')?.[0]).toEqual(['work-9', 'castlabs 换核'])
  })

  it('没有可返回的列表时不画「返回成员」', () => {
    expect(mountSpace().find('.space-back').exists()).toBe(false)
    expect(mountSpace({ showBack: true }).find('.space-back').exists()).toBe(true)
  })

  it('查无此人:配置面给一句话,而不是一张按了没反应的空表单', () => {
    const wrapper = mountSpace({ agentId: 'ghost' })
    expect(wrapper.find('.space-name').text()).toBe('已注销')
    expect(wrapper.find('.agent-config-form').exists()).toBe(false)
    expect(wrapper.find('.space-empty').text()).toContain('已经不在名册里')
  })
})

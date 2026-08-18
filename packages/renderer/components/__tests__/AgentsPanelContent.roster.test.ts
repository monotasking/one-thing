// @vitest-environment happy-dom
/**
 * Agents 名册面套上共享骨架之后的那一层(P4b,计划 agile-watching-abelson.md P4)。
 *
 * 这里盯的是**壳**,不是生命周期(那在 lifecycle.test.ts):
 *  1. 控制条 = compact 搜索 + 一颗「新建」主按钮(原来那颗 `+ new agent` 文字动作);
 *  2. 名册按状态分组,组头是共享的 LedgerGroupHeader(标签 + 计数);
 *  3. 行是 44px 账线行:首列状态点 + 名/副行两行体;
 *  4. 状态条报总数,搜索时先报筛出多少。
 *
 * 分组标签是「在职 / 已退休」而不是设计稿的「运行中 / 空闲」—— store 里没有
 * "正在跑"这一维数据,这条断言就是那个裁决的守卫:哪天真接上了运行态,改的是
 * 这里而不是悄悄多出一组。
 */
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import AgentsPanelContent from '../AgentsPanelContent.vue'
import { destroyUiOverlayHost } from '@/services/ui-overlay-host'

const mocks = vi.hoisted(() => ({
  agentsStore: null as any,
  settingsStore: null as any,
  sessionsStore: null as any,
  workspaceStore: null as any,
}))

vi.mock('@/stores/agents', () => ({
  DEFAULT_AGENT_ID: 'default',
  useAgentsStore: () => mocks.agentsStore,
}))
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => mocks.settingsStore }))
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => mocks.sessionsStore }))
vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => mocks.workspaceStore }))
vi.mock('@/platform', () => ({
  platformApi: { getTools: vi.fn().mockResolvedValue({ success: true, tools: [] }) },
}))

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lily',
    name: '小李',
    systemPrompt: 'be useful',
    isDefault: false,
    createdAt: 1,
    updatedAt: Date.UTC(2026, 7, 9),
    ...overrides,
  }
}

const DEFAULT = agent({ id: 'default', name: 'Default Agent', isDefault: true })
const LILY = agent()
const WEN = agent({ id: 'wen', name: '小文', title: '文案' })
const GONE = agent({ id: 'gone', name: '老王', status: 'retired' })

function seedStore(agents: Array<Record<string, unknown>>) {
  mocks.agentsStore = reactive({
    agents,
    activeAgents: agents.filter(item => item.status !== 'retired'),
    retiredAgents: agents.filter(item => item.status === 'retired'),
    isLoading: false,
    error: null,
    defaultAgent: DEFAULT,
    pendingDetailAgentId: null,
    requestAgentDetail: vi.fn(),
    consumeAgentDetailRequest: vi.fn().mockReturnValue(null),
    loadAgents: vi.fn().mockResolvedValue(agents),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    restoreAgent: vi.fn(),
  })
}

async function mountPanel() {
  const wrapper = mount(AgentsPanelContent)
  for (let index = 0; index < 3; index++) await nextTick()
  return wrapper
}

async function search(wrapper: any, value: string) {
  const input = wrapper.find('.agents-search input')
  await input.setValue(value)
  await nextTick()
}

beforeEach(() => {

  // 空间层(批 B9)从 ModelSelector / ThinkToggle / InputBox 一路读到这里,

  // 它住在 pinia 里 —— 独立挂载的组件测试也得有一个 pinia。

  setActivePinia(createPinia())
  mocks.settingsStore = reactive({
    availableProviders: [],
    settings: {},
    loadProviders: vi.fn().mockResolvedValue(undefined),
  })
  mocks.sessionsStore = reactive({
    sessions: [],
    roomSessions: [],
    groupRoomSessions: [],
    createSessionWithoutSwitch: vi.fn(),
    updateSessionAgent: vi.fn().mockResolvedValue({ success: true }),
  })
  mocks.workspaceStore = reactive({ openSession: vi.fn() })
})

afterEach(() => {
  destroyUiOverlayHost()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('AgentsPanelContent — 共享骨架外壳', () => {
  it('控制条 = compact 搜索 + 「新建」主按钮', async () => {
    seedStore([DEFAULT, LILY])
    const wrapper = await mountPanel()

    const controls = wrapper.find('.panel-shell-controls')
    expect(controls.exists()).toBe(true)
    expect(controls.find('.filter-search.is-compact').exists()).toBe(true)

    const create = controls.find('.agents-new')
    expect(create.exists()).toBe(true)
    expect(create.text()).toContain('新建')

    await create.trigger('click')
    await nextTick()
    expect(wrapper.find('.editor-title h3').text()).toBe('New Agent')
  })

  it('名册按状态分组,组头走共享的账线分组头', async () => {
    seedStore([DEFAULT, LILY, GONE])
    const wrapper = await mountPanel()

    const headers = wrapper.findAll('.ledger-group-header')
    expect(headers.map((header: any) => header.find('.lgh-label').text())).toEqual(['在职', '已退休'])
    expect(headers.map((header: any) => header.find('.lgh-count').text())).toEqual(['2', '1'])
  })

  it('一位都没退休时只剩一组', async () => {
    seedStore([DEFAULT, LILY])
    const wrapper = await mountPanel()
    expect(wrapper.findAll('.ledger-group-header')).toHaveLength(1)
  })

  it('行 = 首列状态点 + 名/副行两行体', async () => {
    seedStore([DEFAULT, LILY])
    const wrapper = await mountPanel()

    const row = wrapper.findAll('.agent-row').find((item: any) => item.text().includes('小李'))!
    expect(row.find('.row-dot').exists()).toBe(true)
    expect(row.find('.row-body .row-name').text()).toBe('小李')
    expect(row.find('.row-body .row-meta').text()).toContain('上次更新')
  })

  it('状态条报总数;搜索之后先报筛出多少,且名字与职位都算数', async () => {
    seedStore([DEFAULT, LILY, WEN, GONE])
    const wrapper = await mountPanel()

    expect(wrapper.find('.panel-shell-status').text()).toContain('4 个 agent')

    await search(wrapper, '文案')
    expect(wrapper.findAll('.agent-row')).toHaveLength(1)
    expect(wrapper.find('.agent-row .row-name').text()).toBe('小文')
    expect(wrapper.find('.panel-shell-status').text()).toContain('筛出 1 · 共 4 个 agent')

    // 退休的也在搜索面里 —— 名册是唯一还找得到他们的地方。
    await search(wrapper, '老王')
    expect(wrapper.findAll('.agent-row.is-retired')).toHaveLength(1)

    await search(wrapper, '查无此人')
    expect(wrapper.findAll('.agent-row')).toHaveLength(0)
    expect(wrapper.text()).toContain('没有匹配')
  })
})

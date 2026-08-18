// @vitest-environment happy-dom
/**
 * Agents 管理页的生命周期入口 —— docs/design/agent-domain-model.md §3.2 / §8。
 *
 * A2 把 UI 的「删除」改成了退休,而这个面板是这两个动作的**唯一**入口:
 * 社交面既不该出现退休按钮,也不该出现恢复按钮。这里盯四件事:
 *
 *  1. 在职的 agent 只给「退休」;
 *  2. 已退休的只给「恢复在职」——「退休」不再出现(点第二次没有意义);
 *  3. default 主助理两条都不给(后端也硬拒,UI 只是不让人白点);
 *  4. 已退休的 agent 照旧列在名册里(分组 + 「已注销」徽标),否则就没有任何
 *     地方还看得见它、点得到恢复。
 */
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import AgentsPanelContent from '../AgentsPanelContent.vue'
import { confirmStack, settleConfirm } from '@/composables/useConfirm'
import { destroyUiOverlayHost } from '@/services/ui-overlay-host'

/**
 * P2 replaced the native `confirm()` with the promise service, so the test
 * answers the queued ask instead of stubbing a global. The rendered dialog is
 * covered by `composables/__tests__/useConfirm.test.ts`.
 */
async function answerConfirm(accepted: boolean): Promise<string> {
  await vi.waitFor(() => expect(confirmStack.value.length).toBeGreaterThan(0))
  const ask = confirmStack.value[confirmStack.value.length - 1]
  const text = `${ask.options.title ?? ''}\n${ask.options.message ?? ''}`
  settleConfirm(ask.id, accepted)
  await nextTick()
  await nextTick()
  return text
}

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
    updatedAt: 2,
    ...overrides,
  }
}

const DEFAULT = agent({ id: 'default', name: 'Default Agent', isDefault: true })
const LILY = agent()
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
    deleteAgent: vi.fn().mockResolvedValue('retired'),
    restoreAgent: vi.fn().mockResolvedValue(agent({ id: 'gone', name: '老王' })),
  })
}

async function mountPanel() {
  const wrapper = mount(AgentsPanelContent)
  for (let index = 0; index < 3; index++) await nextTick()
  return wrapper
}

function headerAction(wrapper: any, label: string) {
  return wrapper
    .findAll('.editor-header .text-action')
    .find((button: any) => button.text().includes(label))
}

/** Clicks the roster row whose name matches, so the editor points at that agent. */
async function selectRow(wrapper: any, name: string) {
  const row = wrapper
    .findAll('.agent-row .row-line')
    .find((button: any) => button.text().includes(name))
  expect(row, `roster row not found: ${name}`).toBeTruthy()
  await row.trigger('click')
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
  confirmStack.value = []
  destroyUiOverlayHost()
  document.body.innerHTML = ''
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('AgentsPanelContent — 退休 / 恢复入口', () => {
  it('在职的 agent 只给「退休」,点下去走的是删除通道并按 outcome 报账', async () => {
    seedStore([DEFAULT, LILY])
    const wrapper = await mountPanel()

    await selectRow(wrapper, '小李')
    expect(headerAction(wrapper, '恢复在职')).toBeFalsy()

    const retire = headerAction(wrapper, '退休')
    expect(retire).toBeTruthy()
    await retire.trigger('click')

    // 确认文案说的是退休,不是「删了就没了」。
    expect(await answerConfirm(true)).toContain('退休')
    await vi.waitFor(() => expect(mocks.agentsStore.deleteAgent).toHaveBeenCalled())
    expect(mocks.agentsStore.deleteAgent).toHaveBeenCalledWith('lily')
    expect(wrapper.text()).toContain('已退休(记录保留)')
  })

  it('一句取消就什么都不做', async () => {
    seedStore([DEFAULT, LILY])
    const wrapper = await mountPanel()

    await selectRow(wrapper, '小李')
    await headerAction(wrapper, '退休').trigger('click')
    await answerConfirm(false)
    expect(mocks.agentsStore.deleteAgent).not.toHaveBeenCalled()
  })

  it('从未被引用的 agent 被真删时,文案说的是删除', async () => {
    seedStore([DEFAULT, LILY])
    const wrapper = await mountPanel()
    mocks.agentsStore.deleteAgent.mockResolvedValue('deleted')

    await selectRow(wrapper, '小李')
    await headerAction(wrapper, '退休').trigger('click')
    await answerConfirm(true)

    await vi.waitFor(() => expect(wrapper.text()).toContain('已删除(从未被引用)'))
  })

  it('已退休的 agent:名册里灰着一行「已注销」,入口换成恢复', async () => {
    seedStore([DEFAULT, GONE])
    const wrapper = await mountPanel()

    // 4:退休不是删除 —— 它还在名册上,才点得到恢复。
    const retiredRow = wrapper.find('.agent-row.is-retired')
    expect(retiredRow.exists()).toBe(true)
    expect(retiredRow.text()).toContain('老王')
    expect(retiredRow.text()).toContain('已注销')

    await selectRow(wrapper, '老王')
    expect(headerAction(wrapper, '退休')).toBeFalsy()

    const restore = headerAction(wrapper, '恢复在职')
    expect(restore).toBeTruthy()
    await restore.trigger('click')
    await nextTick()

    expect(mocks.agentsStore.restoreAgent).toHaveBeenCalledWith('gone')
    expect(wrapper.text()).toContain('已恢复在职')
  })

  it('default 主助理两条入口都不给', async () => {
    seedStore([DEFAULT, LILY])
    const wrapper = await mountPanel()

    await selectRow(wrapper, 'Default Agent')
    expect(headerAction(wrapper, '退休')).toBeFalsy()
    expect(headerAction(wrapper, '恢复在职')).toBeFalsy()
  })

  it('一位都没退休时不画「已退休」那一栏', async () => {
    seedStore([DEFAULT, LILY])
    const wrapper = await mountPanel()
    expect(wrapper.find('.agent-row.is-retired').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('已退休 ·')
  })
})

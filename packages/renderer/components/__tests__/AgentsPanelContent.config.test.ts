// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import AgentsPanelContent from '../AgentsPanelContent.vue'

const mocks = vi.hoisted(() => ({
  agentsStore: null as any,
  settingsStore: null as any,
  sessionsStore: null as any,
  workspaceStore: null as any,
  getTools: null as any,
}))

vi.mock('@/stores/agents', () => ({
  DEFAULT_AGENT_ID: 'default',
  useAgentsStore: () => mocks.agentsStore,
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => mocks.settingsStore,
}))

/* The 私聊 / TA 的群聊 entries (P1-3) read the session list and open sessions. */
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => mocks.sessionsStore,
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: () => mocks.workspaceStore,
}))

vi.mock('@/platform', () => ({
  platformApi: {
    get getTools() {
      return mocks.getTools
    },
  },
}))

function makeAgent(overrides: Record<string, unknown> = {}) {
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

async function mountPanel() {
  // attachTo: the ledger dropdowns are teleported `<Select>`s (P3) — their
  // panels render into document.body and the combobox has to be in the
  // document for the pointer plumbing to reach it.
  const wrapper = mount(AgentsPanelContent, { attachTo: document.body })
  await nextTick()
  await nextTick()
  await nextTick()
  return wrapper
}

/** Opens the `<Select>` with this aria-label and clicks the option by text. */
async function pickOption(wrapper: any, ariaLabel: string, optionText: string) {
  const combobox = document.querySelector<HTMLElement>(`[role="combobox"][aria-label="${ariaLabel}"]`)
  if (!combobox) throw new Error(`no Select labelled "${ariaLabel}"`)
  combobox.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await nextTick()

  const option = [...document.querySelectorAll<HTMLElement>('.app-select-dropdown .app-select-option')]
    .find(node => node.textContent?.includes(optionText))
  if (!option) throw new Error(`no option "${optionText}" in "${ariaLabel}"`)
  option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await nextTick()
  await nextTick()
}

/** Current display text of the `<Select>` with this aria-label. */
function selectText(ariaLabel: string) {
  return document.querySelector(`[role="combobox"][aria-label="${ariaLabel}"]`)?.textContent?.trim()
}

/** Clicks the "allowlist" / "follow global" mode buttons. */
function modeButton(wrapper: any, label: string) {
  return wrapper
    .findAll('.mode-option')
    .find((button: any) => button.text() === label)
}

function toolButton(wrapper: any, name: string) {
  return wrapper
    .findAll('.tool-line')
    .find((button: any) => button.text().includes(name))
}

function saveButton(wrapper: any) {
  return wrapper
    .findAll('.editor-footer .text-action')
    .find((button: any) => button.text().includes('save'))
}

describe('AgentsPanelContent tool + model configuration', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  beforeEach(() => {

    // 空间层(批 B9)从 ModelSelector / ThinkToggle / InputBox 一路读到这里,

    // 它住在 pinia 里 —— 独立挂载的组件测试也得有一个 pinia。

    setActivePinia(createPinia())
    mocks.getTools = vi.fn().mockResolvedValue({
      success: true,
      tools: [
        { id: 'read', name: 'read', description: 'Read a file', enabled: true },
        { id: 'write', name: 'write', description: 'Write a file', enabled: true },
        { id: 'retired', name: 'retired', description: '', enabled: false },
      ],
    })

    const agent = makeAgent()
    mocks.agentsStore = reactive({
      agents: [agent],
      // 管理页按 status 分两栏(域模型 §3.2);这个夹具只有在职的一位。
      activeAgents: [agent],
      retiredAgents: [],
      isLoading: false,
      error: null,
      defaultAgent: agent,
      pendingDetailAgentId: null,
      requestAgentDetail: vi.fn(),
      consumeAgentDetailRequest: vi.fn().mockReturnValue(null),
      loadAgents: vi.fn().mockResolvedValue([agent]),
      createAgent: vi.fn(),
      updateAgent: vi.fn().mockImplementation(async (_id: string, updates: any) => ({
        ...agent,
        ...updates,
      })),
      deleteAgent: vi.fn().mockResolvedValue('retired'),
      restoreAgent: vi.fn(),
    })

    mocks.sessionsStore = reactive({
      sessions: [],
      roomSessions: [],
      groupRoomSessions: [],
      createSessionWithoutSwitch: vi.fn(),
      updateSessionAgent: vi.fn().mockResolvedValue({ success: true }),
    })

    mocks.workspaceStore = reactive({
      openSession: vi.fn(),
    })

    mocks.settingsStore = reactive({
      availableProviders: [
        { id: 'claude', name: 'Claude', requiresApiKey: true },
        { id: 'deepseek', name: 'DeepSeek', requiresApiKey: true },
      ],
      settings: {
        ai: {
          providers: {
            claude: { apiKey: 'sk-live', model: 'sonnet', selectedModels: ['sonnet', 'opus'] },
            deepseek: { apiKey: '', model: '', selectedModels: ['deepseek-chat'] },
          },
        },
      },
      loadProviders: vi.fn().mockResolvedValue(undefined),
      getModelDisplayName: (id: string) => id,
    })
  })

  /**
   * The picture-avatar field (docs/design/todo2-fix-plan.md P2). The pick path
   * needs a real canvas and is left to真机; what is pinned here is the pair of
   * things a wrong wiring would silently break: the field must LOAD from the
   * agent, and 「clear」 must reach the store as an explicit null — `undefined`
   * means "leave alone" to patchOptional, so a user who removes their picture
   * would watch it come back.
   */
  describe('picture avatar', () => {
    function avatarImageAction(wrapper: any, label: string) {
      return wrapper
        .findAll('.avatar-image-row .text-action')
        .find((button: any) => button.text() === label)
    }

    it('shows the stored picture and offers to replace it', async () => {
      mocks.agentsStore.agents[0].avatar = '🔧'
      mocks.agentsStore.agents[0].avatarImage = 'a1b2c3.png'
      const wrapper = await mountPanel()

      expect(wrapper.find('.avatar-image-preview').element.tagName).toBe('IMG')
      expect(avatarImageAction(wrapper, 'replace')).toBeTruthy()
      expect(avatarImageAction(wrapper, 'choose')).toBeFalsy()
    })

    it('offers only「choose」and shows the emoji when there is no picture', async () => {
      mocks.agentsStore.agents[0].avatar = '🔧'
      const wrapper = await mountPanel()

      expect(wrapper.find('.avatar-image-preview').element.tagName).toBe('SPAN')
      expect(wrapper.find('.avatar-image-preview').text()).toBe('🔧')
      expect(avatarImageAction(wrapper, 'choose')).toBeTruthy()
      expect(avatarImageAction(wrapper, 'clear')).toBeFalsy()
    })

    it('sends an explicit null on clear, leaving the emoji standing', async () => {
      mocks.agentsStore.agents[0].avatar = '🔧'
      mocks.agentsStore.agents[0].avatarImage = 'a1b2c3.png'
      const wrapper = await mountPanel()

      await avatarImageAction(wrapper, 'clear')!.trigger('click')
      expect(wrapper.find('.avatar-image-preview').element.tagName).toBe('SPAN')

      await saveButton(wrapper)!.trigger('click')
      await nextTick()

      expect(mocks.agentsStore.updateAgent).toHaveBeenCalledWith(
        'lily',
        expect.objectContaining({ avatarImage: null, avatar: '🔧' }),
      )
    })
  })

  it('defaults to following the global tool set and hides the picker', async () => {
    const wrapper = await mountPanel()

    expect(modeButton(wrapper, 'follow global')!.classes()).toContain('is-on')
    expect(wrapper.find('.tool-grid').exists()).toBe(false)
    expect(wrapper.text()).toContain('all tools')
  })

  it('states that work sessions always union the board tool', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.text()).toContain('Work sessions always add the board tool')
  })

  it('lists only globally enabled tools once allowlist mode is on', async () => {
    const wrapper = await mountPanel()
    await modeButton(wrapper, 'allowlist')!.trigger('click')

    const names = wrapper.findAll('.tool-line').map(button => button.text())
    expect(names.some(name => name.includes('read'))).toBe(true)
    expect(names.some(name => name.includes('write'))).toBe(true)
    expect(names.some(name => name.includes('retired'))).toBe(false)
  })

  it('refuses to save an empty allowlist', async () => {
    const wrapper = await mountPanel()
    await modeButton(wrapper, 'allowlist')!.trigger('click')
    await saveButton(wrapper)!.trigger('click')
    await nextTick()

    expect(mocks.agentsStore.updateAgent).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Pick at least one tool')
  })

  it('saves the picked tool ids on the agents update channel', async () => {
    const wrapper = await mountPanel()
    await modeButton(wrapper, 'allowlist')!.trigger('click')
    await toolButton(wrapper, 'read')!.trigger('click')
    await saveButton(wrapper)!.trigger('click')
    await nextTick()

    expect(mocks.agentsStore.updateAgent).toHaveBeenCalledWith(
      'lily',
      expect.objectContaining({ tools: ['read'] }),
    )
  })

  it('sends null tools when switching back to follow global', async () => {
    mocks.agentsStore.agents[0].tools = ['read']
    mocks.agentsStore.defaultAgent = mocks.agentsStore.agents[0]

    const wrapper = await mountPanel()
    expect(modeButton(wrapper, 'allowlist')!.classes()).toContain('is-on')

    await modeButton(wrapper, 'follow global')!.trigger('click')
    await saveButton(wrapper)!.trigger('click')
    await nextTick()

    expect(mocks.agentsStore.updateAgent).toHaveBeenCalledWith(
      'lily',
      expect.objectContaining({ tools: null }),
    )
  })

  it('keeps an allowlisted id that no longer resolves to a live tool', async () => {
    mocks.agentsStore.agents[0].tools = ['read', 'ghost']
    mocks.agentsStore.defaultAgent = mocks.agentsStore.agents[0]

    const wrapper = await mountPanel()
    expect(toolButton(wrapper, 'ghost')).toBeTruthy()
    expect(wrapper.text()).toContain('unavailable')
  })

  it('auto-completes the pair when a provider is picked, then saves it', async () => {
    const wrapper = await mountPanel()

    await pickOption(wrapper, 'Model provider', 'Claude')

    await saveButton(wrapper)!.trigger('click')
    await nextTick()

    expect(mocks.agentsStore.updateAgent).toHaveBeenCalledWith(
      'lily',
      expect.objectContaining({ model: { providerId: 'claude', modelId: 'sonnet' } }),
    )
  })

  it('clears an existing binding back to the session default', async () => {
    mocks.agentsStore.agents[0].model = { providerId: 'claude', modelId: 'opus' }
    mocks.agentsStore.defaultAgent = mocks.agentsStore.agents[0]

    const wrapper = await mountPanel()
    expect(selectText('Model')).toBe('opus')

    const clear = wrapper
      .findAll('.text-action')
      .find(button => button.text() === 'clear')
    await clear!.trigger('click')
    await saveButton(wrapper)!.trigger('click')
    await nextTick()

    expect(mocks.agentsStore.updateAgent).toHaveBeenCalledWith(
      'lily',
      expect.objectContaining({ model: null }),
    )
  })

  it('drops a stale model id when the provider changes', async () => {
    mocks.agentsStore.agents[0].model = { providerId: 'claude', modelId: 'opus' }
    mocks.agentsStore.defaultAgent = mocks.agentsStore.agents[0]

    const wrapper = await mountPanel()
    await pickOption(wrapper, 'Model provider', 'DeepSeek')

    await saveButton(wrapper)!.trigger('click')
    await nextTick()

    expect(mocks.agentsStore.updateAgent).toHaveBeenCalledWith(
      'lily',
      expect.objectContaining({ model: { providerId: 'deepseek', modelId: 'deepseek-chat' } }),
    )
  })

  it('warns without blocking when the bound provider has no key', async () => {
    const wrapper = await mountPanel()

    await pickOption(wrapper, 'Model provider', 'DeepSeek')
    expect(wrapper.text()).toContain('no API key')

    await saveButton(wrapper)!.trigger('click')
    await nextTick()
    expect(mocks.agentsStore.updateAgent).toHaveBeenCalled()
  })

  /* Selects are addressed by aria-label: Model provider / Model / Approvals /
     Turn budget (see pickOption). */
  describe('boundaries', () => {
    it('sends null for both when the agent inherits', async () => {
      const wrapper = await mountPanel()

      await saveButton(wrapper)!.trigger('click')
      await nextTick()

      expect(mocks.agentsStore.updateAgent).toHaveBeenCalledWith(
        'lily',
        expect.objectContaining({ permissionMode: null, maxTurns: null }),
      )
    })

    it('sends the picked approval mode and turn budget', async () => {
      const wrapper = await mountPanel()

      await pickOption(wrapper, 'Approvals', 'ask every time')
      await pickOption(wrapper, 'Turn budget', 'long task (300)')

      await saveButton(wrapper)!.trigger('click')
      await nextTick()

      expect(mocks.agentsStore.updateAgent).toHaveBeenCalledWith(
        'lily',
        expect.objectContaining({ permissionMode: 'normal', maxTurns: 300 }),
      )
    })

    it('shows a hand-written turn budget instead of rounding it away', async () => {
      mocks.agentsStore.agents[0].maxTurns = 42
      mocks.agentsStore.defaultAgent = mocks.agentsStore.agents[0]

      const wrapper = await mountPanel()
      expect(wrapper.text()).toContain('custom (42)')

      await saveButton(wrapper)!.trigger('click')
      await nextTick()

      expect(mocks.agentsStore.updateAgent).toHaveBeenCalledWith(
        'lily',
        expect.objectContaining({ maxTurns: 42 }),
      )
    })
  })

  /**
   * 私聊 + TA 的群聊 (docs/design/todo2-fix-plan.md P1-3).
   *
   * 侧栏的 Agent 行只通向「执行现场」——一个禁输入的基础设施视图。要跟 agent
   * 说话的出口落在详情页,并且必须是**普通**会话:私聊走 exec 会话就等于把用户
   * 的话塞进 agent 的回合历史。
   */
  describe('conversations', () => {
    function privateChatButton(wrapper: any) {
      return wrapper
        .findAll('.agent-conversations .text-action')
        .find((button: any) => button.text().includes('私聊'))
    }

    it('reuses the agent\'s most recent ordinary chat instead of piling up empties', async () => {
      mocks.sessionsStore.sessions = [
        { id: 'chat-old', agentId: 'lily', kind: 'chat', updatedAt: 10 },
        { id: 'chat-new', agentId: 'lily', updatedAt: 90 },
        { id: 'chat-other', agentId: 'someone-else', updatedAt: 999 },
      ]

      const wrapper = await mountPanel()
      await privateChatButton(wrapper)!.trigger('click')
      await nextTick()

      expect(mocks.workspaceStore.openSession).toHaveBeenCalledWith('chat-new')
      expect(mocks.sessionsStore.createSessionWithoutSwitch).not.toHaveBeenCalled()
      expect(wrapper.emitted('close')).toBeTruthy()
    })

    it('never reuses an execution/room/work session as the private chat', async () => {
      mocks.sessionsStore.sessions = [
        { id: 'agent-exec-lily-room-1', agentId: 'lily', kind: 'agent', updatedAt: 900 },
        { id: 'work-1', agentId: 'lily', kind: 'work', updatedAt: 800 },
        { id: 'archived-1', agentId: 'lily', kind: 'chat', updatedAt: 700, isArchived: true },
      ]
      mocks.sessionsStore.createSessionWithoutSwitch.mockResolvedValue({ id: 'chat-fresh' })

      const wrapper = await mountPanel()
      await privateChatButton(wrapper)!.trigger('click')
      await nextTick()

      expect(mocks.sessionsStore.createSessionWithoutSwitch).toHaveBeenCalledWith('小李')
      expect(mocks.sessionsStore.updateSessionAgent).toHaveBeenCalledWith('chat-fresh', 'lily')
      expect(mocks.workspaceStore.openSession).toHaveBeenCalledWith('chat-fresh')
    })

    it('says so when the new session could not be bound, rather than pretending', async () => {
      mocks.sessionsStore.createSessionWithoutSwitch.mockResolvedValue({ id: 'chat-fresh' })
      mocks.sessionsStore.updateSessionAgent.mockResolvedValue({ success: false, error: 'bridge down' })

      const wrapper = await mountPanel()
      await privateChatButton(wrapper)!.trigger('click')
      await nextTick()

      expect(wrapper.text()).toContain('bridge down')
    })

    it('lists the rooms the agent belongs to, PM membership included', async () => {
      // 「群」这一路吃的是拆分后的普通群(agent-im-dm.md §4.1):和 TA 的一对一
      // 私聊是另一种关系,列进群聊里会读成"和自己开了个群"。
      mocks.sessionsStore.groupRoomSessions = [
        { id: 'room-1', name: '官网改版组', updatedAt: 10, room: { memberAgentIds: ['lily', 'qa'] } },
        { id: 'room-2', name: '风控评审组', updatedAt: 90, room: { memberAgentIds: ['qa'], pmAgentId: 'lily' } },
        { id: 'room-3', name: '与我无关组', updatedAt: 99, room: { memberAgentIds: ['qa'] } },
      ]
      // 私聊房只进全量那一路,进不了群列表 —— 这条钉住"不吃 roomSessions"。
      mocks.sessionsStore.roomSessions = [
        ...mocks.sessionsStore.groupRoomSessions,
        { id: 'agent-dm-lily', name: '莉莉', updatedAt: 100, room: { dm: true, memberAgentIds: ['lily'] } },
      ]

      const wrapper = await mountPanel()
      const rooms = wrapper.findAll('.agent-room-line')

      expect(rooms.map(row => row.text())).toEqual(['群「风控评审组」PM', '群「官网改版组」'])

      await rooms[1]!.trigger('click')
      expect(mocks.workspaceStore.openSession).toHaveBeenCalledWith('room-1')
      expect(wrapper.emitted('close')).toBeTruthy()
    })

    it('says nothing is there rather than showing an empty room list', async () => {
      const wrapper = await mountPanel()
      expect(wrapper.find('.agent-room-line').exists()).toBe(false)
      expect(wrapper.text()).toContain('还没有加入任何群聊')
    })

    it('hides both entries for a draft agent — it has no id and no sessions yet', async () => {
      const wrapper = await mountPanel()
      await wrapper.find('.agents-new').trigger('click')
      await nextTick()

      expect(wrapper.find('.agent-conversations').exists()).toBe(false)
    })

    it('opens on the agent the sidebar asked for, and consumes the request', async () => {
      const qa = makeAgent({ id: 'qa', name: '小研' })
      mocks.agentsStore.agents.push(qa)
      mocks.agentsStore.pendingDetailAgentId = 'qa'
      mocks.agentsStore.consumeAgentDetailRequest.mockImplementation(() => {
        mocks.agentsStore.pendingDetailAgentId = null
        return 'qa'
      })

      const wrapper = await mountPanel()

      expect(mocks.agentsStore.consumeAgentDetailRequest).toHaveBeenCalled()
      expect(mocks.agentsStore.pendingDetailAgentId).toBeNull()
      expect(wrapper.find('.editor-title h3').text()).toBe('小研')
      expect(wrapper.find('.agents-layout').classes()).toContain('detail-active')
    })
  })
})

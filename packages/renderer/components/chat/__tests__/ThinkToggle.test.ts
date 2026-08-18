// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import ThinkToggle from '../ThinkToggle.vue'

const mocks = vi.hoisted(() => ({
  settingsStore: null as any,
  sessionsStore: null as any,
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => mocks.settingsStore,
}))

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => mocks.sessionsStore,
}))

// The picker ranks an agent's model binding above an unpinned session model;
// these cases have no agent, so the composable is stubbed out rather than
// dragging a Pinia instance in for a constant null.
vi.mock('@/composables/useSessionAgentModel', () => ({
  useSessionAgentModel: () => ({ value: null }),
}))

vi.mock('../../common/Tooltip.vue', () => ({
  default: {
    name: 'Tooltip',
    props: ['text'],
    template: '<span><slot /></span>',
  },
}))

function createSettings(provider: 'codex' | 'deepseek' = 'codex', serviceTierByModel?: Record<string, string>) {
  const model = provider === 'codex' ? 'gpt-5.5' : 'deepseek-v4'
  return {
    ai: {
      provider,
      providers: {
        [provider]: {
          apiKey: '',
          model,
          selectedModels: [model],
          serviceTierByModel,
        },
      },
    },
  } as any
}

function createCodexModel() {
  return {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    providerMetadata: {
      codex: {
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [
          { effort: 'minimal' },
          { effort: 'low' },
          { effort: 'medium' },
          { effort: 'high' },
          { effort: 'xhigh' },
        ],
        serviceTiers: [
          { id: 'fast', name: 'Fast', description: 'Priority processing.' },
          { id: 'flex', name: 'Flex', description: 'Flexible processing.' },
        ],
      },
    },
  } as any
}

function setup(provider: 'codex' | 'deepseek' = 'codex', serviceTierByModel?: Record<string, string>) {
  const settings = createSettings(provider, serviceTierByModel)
  const model = provider === 'codex' ? 'gpt-5.5' : 'deepseek-v4'
  mocks.settingsStore = reactive({
    settings,
    getCachedModels: vi.fn((providerId: string) => providerId === 'codex' ? [createCodexModel()] : []),
    saveSettings: vi.fn(async (newSettings: any) => {
      mocks.settingsStore.settings = newSettings
    }),
    updateModel: vi.fn(),
    saveAIProviderDefault: vi.fn(async (provider: string, model: string) => {
      mocks.settingsStore.settings.ai.provider = provider
      mocks.settingsStore.settings.ai.providers[provider] = {
        ...mocks.settingsStore.settings.ai.providers[provider],
        model,
      }
    }),
    updateProviderThinking: vi.fn(async (
      provider: string,
      model: string,
      patch: { enabled?: boolean; effort?: string; serviceTier?: string | null },
    ) => {
      const current = mocks.settingsStore.settings.ai.providers[provider] ?? {}
      const nextConfig = { ...current }
      if (patch.enabled !== undefined) {
        nextConfig.thinkingByModel = { ...(current.thinkingByModel ?? {}), [model]: patch.enabled }
      }
      if (patch.effort !== undefined) {
        nextConfig.thinkingEffortByModel = { ...(current.thinkingEffortByModel ?? {}), [model]: patch.effort }
      }
      if (patch.serviceTier !== undefined) {
        const serviceTierMap = { ...(current.serviceTierByModel ?? {}) }
        if (patch.serviceTier) serviceTierMap[model] = patch.serviceTier
        else delete serviceTierMap[model]
        nextConfig.serviceTierByModel = serviceTierMap
      }
      mocks.settingsStore.settings = {
        ...mocks.settingsStore.settings,
        ai: {
          ...mocks.settingsStore.settings.ai,
          providers: {
            ...mocks.settingsStore.settings.ai.providers,
            [provider]: nextConfig,
          },
        },
      }
    }),
  })
  mocks.sessionsStore = reactive({
    currentSessionId: 'session-1',
    sessions: [{
      id: 'session-1',
      lastProvider: provider,
      lastModel: model,
    }],
    getSessionItem: vi.fn((sessionId: string) => mocks.sessionsStore.sessions.find((item: any) => item.id === sessionId)),
    updateSessionModel: vi.fn(async (sessionId: string, nextProvider: string, nextModel: string) => {
      const session = mocks.sessionsStore.sessions.find((item: any) => item.id === sessionId)
      if (session) {
        session.lastProvider = nextProvider
        session.lastModel = nextModel
      }
      return { success: true }
    }),
  })
}

async function openPanel(wrapper: ReturnType<typeof mount>) {
  await wrapper.find('.app-select-control').trigger('click')
  await nextTick()
}

function panelText(): string {
  return document.body.textContent ?? ''
}

async function clickPanelOption(label: string) {
  const options = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.app-select-option'))
  const option = options.find((item) =>
    item.querySelector('.think-option-text')?.textContent?.trim() === label
      || item.textContent?.trim() === label)
  expect(option).toBeTruthy()
  option?.click()
  await nextTick()
}

describe('ThinkToggle', () => {
  beforeEach(() => {
  	// 空间层(批 B9)从 ModelSelector/ThinkToggle/InputBox 一路读到这里,
  	// 它住在 pinia 里 —— 独立挂载的组件测试也得有一个 pinia。
  	setActivePinia(createPinia());
    setup()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.textContent = ''
  })

  it('renders Codex as one compact dropdown with thinking and speed groups', async () => {
    const wrapper = mount(ThinkToggle, {
      attachTo: document.body,
      props: { sessionId: 'session-1' },
    })

    expect(wrapper.findAll('.think-select')).toHaveLength(1)
    expect(wrapper.find('.think-value').text()).toBe('Medium')

    await openPanel(wrapper)

    expect(panelText()).toContain('Thinking')
    expect(panelText()).toContain('Speed')
    expect(panelText()).toContain('Off')
    expect(panelText()).toContain('X High')
    expect(panelText()).toContain('Auto')
    expect(panelText()).toContain('Fast')
    expect(panelText()).toContain('Flex')
  })

  it('shows an explicit Codex speed only after selecting it', async () => {
    const wrapper = mount(ThinkToggle, {
      attachTo: document.body,
      props: { sessionId: 'session-1' },
    })

    await openPanel(wrapper)
    await clickPanelOption('Fast')

    expect(wrapper.find('.think-value').text()).toBe('Medium · Fast')
    expect(mocks.settingsStore.settings.ai.providers.codex.serviceTierByModel['gpt-5.5']).toBe('fast')

    await openPanel(wrapper)
    await clickPanelOption('Auto')

    expect(wrapper.find('.think-value').text()).toBe('Medium')
    expect(mocks.settingsStore.settings.ai.providers.codex.serviceTierByModel['gpt-5.5']).toBeUndefined()
  })

  it('keeps DeepSeek on the same dropdown without Codex speed controls', async () => {
    setup('deepseek')
    const wrapper = mount(ThinkToggle, {
      attachTo: document.body,
      props: { sessionId: 'session-1' },
    })

    // DeepSeek V4 only thinks when explicitly enabled — the unset default now
    // displays Off, matching what the engine actually sends (previously the
    // UI showed thinking as on while no parameter went out).
    expect(wrapper.find('.think-value').text()).toBe('Off')

    await openPanel(wrapper)

    expect(panelText()).toContain('Thinking')
    expect(panelText()).not.toContain('Speed')
    expect(panelText()).toContain('High')
    expect(panelText()).toContain('Max')
    expect(panelText()).not.toContain('Low')
    expect(panelText()).not.toContain('Medium')
    expect(panelText()).not.toContain('X High')

    await clickPanelOption('High')
    expect(wrapper.find('.think-value').text()).toBe('High')
    expect(mocks.settingsStore.settings.ai.providers.deepseek.thinkingByModel['deepseek-v4']).toBe(true)
    expect(mocks.settingsStore.settings.ai.providers.deepseek.thinkingEffortByModel['deepseek-v4']).toBe('high')
  })

  it('stores legacy pair thinking selection on a draft chat', async () => {
    setup('deepseek')
    mocks.settingsStore.settings.ai.providers.deepseek.model = 'deepseek-chat'
    mocks.sessionsStore.currentSessionId = 'draft:one'
    mocks.sessionsStore.sessions = [{
      id: 'draft:one',
      draftKind: 'new-chat-draft',
      lastProvider: 'deepseek',
      lastModel: 'deepseek-chat',
    }]

    const wrapper = mount(ThinkToggle, {
      attachTo: document.body,
      props: { sessionId: 'draft:one' },
    })

    expect(wrapper.find('.think-value').text()).toBe('Off')

    await openPanel(wrapper)
    await clickPanelOption('On')
    // C1:写默认多了一跳(先读盘上的 overlay 再整层写),微任务要多冲几拍。
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await nextTick()

    // C1:「改默认」写的是**当前空间的 overlay**,不再是 settings.ai
    // (空间那一侧由 provider-defaults.space.test.ts / ModelSelector.space.test.ts 钉)。
    expect(mocks.settingsStore.saveAIProviderDefault).not.toHaveBeenCalled()
    expect(mocks.sessionsStore.updateSessionModel).toHaveBeenCalledWith('draft:one', 'deepseek', 'deepseek-reasoner')
    expect(wrapper.find('.think-value').text()).toBe('On')
  })
})

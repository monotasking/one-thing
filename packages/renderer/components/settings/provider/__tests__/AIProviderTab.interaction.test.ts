// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { computed, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AIProviderTab from '../AIProviderTab.vue'
import type { AppSettings } from '@/types'

const mocks = vi.hoisted(() => ({
  providerSettings: null as any,
  providerUsage: null as any,
  cachedModels: {} as Record<string, any[]>,
}))

vi.mock('../useProviderSettings', () => ({
  useProviderSettings: () => mocks.providerSettings,
}))

vi.mock('../useProviderUsage', () => ({
  useProviderUsage: () => mocks.providerUsage,
}))

// 空间凭证段(批 B3)在这条测试线里不参演:宿主答不上话时它整段不画,
// 与 web 宿主的降级同一支路。它自己的行为在 SpaceCredentialsPanel.test.ts 里测。
vi.mock('@/stores/spaces', () => ({
  DEFAULT_SPACE_ID: 'default',
  useSpacesStore: () => ({
    available: false,
    spaces: [],
    currentSpaceId: 'default',
    lastError: null,
    load: vi.fn(async () => {}),
    getCredentials: vi.fn(async () => ({ providers: {} })),
    setCredential: vi.fn(async () => ({ providers: {} })),
    clearCredential: vi.fn(async () => ({ providers: {} })),
  }),
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    getCachedModels: (providerId: string) => mocks.cachedModels[providerId] ?? [],
    getModelDisplayName: (modelId: string) => modelId,
    preloadModels: vi.fn(async () => {}),
    addCustomModelToCache: vi.fn(),
    isCustomProvider: () => false,
  }),
}))

function model(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    name: id,
    context_length: 128000,
    architecture: {
      modality: 'text',
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'unknown',
    },
    pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    top_provider: { context_length: 128000, max_completion_tokens: 16384, is_moderated: false },
    supported_parameters: ['temperature', 'tools'],
    ...overrides,
  }
}

function createSettings(): AppSettings {
  return {
    ai: {
      provider: 'openai',
      temperature: 0.7,
      providers: {
        openai: {
          enabled: true,
          apiKey: 'sk-openai',
          baseUrl: '',
          selectedModels: ['openai/gpt-4o', 'openai/o4-mini'],
          model: 'openai/gpt-4o',
        },
        anthropic: {
          enabled: false,
          apiKey: '',
          baseUrl: '',
          selectedModels: ['anthropic/claude-3-5-sonnet'],
          model: 'anthropic/claude-3-5-sonnet',
        },
      },
      customProviders: [],
    },
  } as any
}

const providers = [
  { id: 'openai', name: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com/v1' },
] as any[]

function mountProviderTab(settings = createSettings()) {
  return mount(AIProviderTab, {
    props: {
      settings,
      providers,
    },
    global: {
      stubs: {
        ProviderIcon: { template: '<span class="provider-icon-stub" />' },
        AuthCard: { template: '<div class="auth-card-stub" />' },
        ProviderUsageCard: { template: '<div class="usage-card-stub" />' },
        ProviderModels: { template: '<div class="provider-models-stub" />' },
      },
    },
  })
}

function ledgerRowById(wrapper: ReturnType<typeof mount>, modelId: string) {
  const row = wrapper.findAll('.ledger-row').find((item) => item.text().includes(modelId))
  if (!row) throw new Error(`Missing ledger row: ${modelId}`)
  return row
}

function connRowByName(wrapper: ReturnType<typeof mount>, name: string) {
  const row = wrapper.findAll('.conn-row').find((item) => item.text().includes(name))
  if (!row) throw new Error(`Missing connection row: ${name}`)
  return row
}

function lastSettingsUpdate(wrapper: ReturnType<typeof mount>): AppSettings {
  const events = wrapper.emitted('update:settings')
  if (!events || events.length === 0) throw new Error('No update:settings emitted')
  return events[events.length - 1][0] as AppSettings
}

beforeEach(() => {
  const viewingProvider = ref('openai')

    mocks.cachedModels = {
      openai: [
        model('openai/gpt-4o', {
          architecture: {
            modality: 'text',
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
            tokenizer: 'unknown',
          },
        }),
        model('openai/o4-mini'),
      ],
      anthropic: [model('anthropic/claude-3-5-sonnet')],
    }

    mocks.providerSettings = {
      viewingProvider,
      isUserCustomProvider: vi.fn(() => false),
      isProviderEnabled: vi.fn((providerId: string) => providerId === 'openai'),
      getProviderEnvStatus: vi.fn(() => undefined),
      providerUsesEnvApiKey: vi.fn(() => false),
      switchViewingProvider: vi.fn(async (providerId: string) => {
        viewingProvider.value = providerId
      }),
      initialize: vi.fn(),
      cleanup: vi.fn(),
      currentProviderName: computed(() => viewingProvider.value),
      isOAuthProvider: ref(false),
      isACPProvider: ref(false),
      oauthStatus: ref({ isLoggedIn: false }),
      isOAuthLoading: ref(false),
      deviceFlowInfo: ref(null),
      codeEntryInfo: ref(null),
      manualCode: ref(''),
      isSubmittingCode: ref(false),
      codeEntryError: ref(''),
      startOAuthLogin: vi.fn(),
      logoutOAuth: vi.fn(),
      submitManualCode: vi.fn(),
      toggleProviderEnabled: vi.fn(),
      setProvidersEnabled: vi.fn(),
      getDefaultBaseUrl: vi.fn(() => 'https://api.example.com/v1'),
      updateProviderApiKey: vi.fn(),
      updateProviderBaseUrl: vi.fn(),
      availableModels: ref([]),
      filteredModels: ref([]),
      currentProviderUsesEnvApiKey: ref(false),
      currentProviderEnvVarName: ref('OPENAI_API_KEY'),
      currentProviderEnvKeyPreview: ref(''),
      isZhipuProvider: ref(false),
      currentZhipuApiMode: ref('standard'),
      updateZhipuApiMode: vi.fn(),
      currentProviderContextLengths: ref({}),
      updateModelContextLength: vi.fn(),
      isQwenProvider: ref(false),
      currentQwenApiMode: ref('standard'),
      currentQwenRegion: ref('cn'),
      updateQwenApiMode: vi.fn(),
      updateQwenRegion: vi.fn(),
      isKimiProvider: ref(false),
      currentKimiApiMode: ref('standard'),
      currentKimiRegion: ref('cn'),
      kimiRegionApplies: ref(true),
      updateKimiApiMode: vi.fn(),
      updateKimiRegion: vi.fn(),
      currentSelectedModels: computed(() => ['openai/gpt-4o', 'openai/o4-mini']),
      modelSearchQuery: ref(''),
      newModelInput: ref(''),
      isLoadingModels: ref(false),
      modelError: ref(''),
      currentProviderMaxOutputs: ref({}),
      currentProviderModelCapabilities: ref({}),
      renameModel: vi.fn(() => ({ ok: true })),
      activeModelId: computed(() => 'openai/gpt-4o'),
      isModelSelected: vi.fn(() => true),
      hasVision: vi.fn(() => false),
      hasImageGeneration: vi.fn(() => false),
      hasTools: vi.fn(() => false),
      hasReasoning: vi.fn(() => false),
      formatContextLength: vi.fn((value: number) => String(value)),
      fetchModels: vi.fn(),
      toggleModelSelection: vi.fn(),
      addCustomModel: vi.fn(),
      updateModelMaxOutput: vi.fn(),
      updateModelCapability: vi.fn(),
      resetModelCapabilities: vi.fn(),
      setActiveModel: vi.fn(),
      currentACPAgent: ref(undefined),
      currentACPAgentState: ref(undefined),
      updateACPAgent: vi.fn(),
      updateACPArgs: vi.fn(),
      connectACPAgent: vi.fn(),
      disconnectACPAgent: vi.fn(),
      refreshACPAgent: vi.fn(),
    }

    mocks.providerUsage = {
      shouldShow: ref(false),
      response: ref(null),
      isLoading: ref(false),
      error: ref(''),
      refresh: vi.fn(),
    }
})

describe('AIProviderTab model ledger', () => {
  it('lists one row per enabled provider model and skips disabled providers', () => {
    const wrapper = mountProviderTab()

    const rows = wrapper.findAll('.ledger-row')
    expect(rows).toHaveLength(2)
    expect(wrapper.text()).toContain('openai/gpt-4o')
    expect(wrapper.text()).toContain('openai/o4-mini')
    expect(wrapper.text()).not.toContain('anthropic/claude-3-5-sonnet')
  })

  it('marks the default model with a star and sets provider+model on star click', async () => {
    const wrapper = mountProviderTab()

    expect(ledgerRowById(wrapper, 'openai/gpt-4o').find('.row-star').classes()).toContain('set')
    expect(ledgerRowById(wrapper, 'openai/o4-mini').find('.row-star').classes()).not.toContain('set')

    await ledgerRowById(wrapper, 'openai/o4-mini').find('.row-star').trigger('click')

    const updated = lastSettingsUpdate(wrapper)
    expect(updated.ai.provider).toBe('openai')
    expect(updated.ai.providers.openai.model).toBe('openai/o4-mini')
    // Star click must not toggle the tune drawer.
    expect(wrapper.find('.ledger-tune').exists()).toBe(false)
  })

  it('expands the tune drawer and writes a per-model temperature preset', async () => {
    const wrapper = mountProviderTab()

    await ledgerRowById(wrapper, 'openai/gpt-4o').trigger('click')
    expect(wrapper.find('.ledger-tune').exists()).toBe(true)

    const preciseBtn = wrapper
      .findAll('.ledger-tune .seg-btn')
      .find((btn) => btn.text() === 'Precise')
    expect(preciseBtn).toBeTruthy()
    await preciseBtn!.trigger('click')

    const updated = lastSettingsUpdate(wrapper)
    expect(updated.ai.providers.openai.temperatureByModel).toEqual({ 'openai/gpt-4o': 0.2 })

    // Collapse on second click.
    await ledgerRowById(wrapper, 'openai/gpt-4o').trigger('click')
    expect(wrapper.find('.ledger-tune').exists()).toBe(false)
  })

  it('filters rows by capability chips', async () => {
    const wrapper = mountProviderTab()

    const visionChip = wrapper.findAll('.ledger-chip').find((chip) => chip.text() === 'Vision')
    await visionChip!.trigger('click')
    expect(wrapper.findAll('.ledger-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('openai/gpt-4o')

    const reasoningChip = wrapper.findAll('.ledger-chip').find((chip) => chip.text() === 'Reasoning')
    await reasoningChip!.trigger('click')
    expect(wrapper.findAll('.ledger-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('openai/o4-mini')

    const allChip = wrapper.findAll('.ledger-chip').find((chip) => chip.text() === 'All')
    await allChip!.trigger('click')
    expect(wrapper.findAll('.ledger-row')).toHaveLength(2)
  })
})

function createFamilySettings(): AppSettings {
  const settings = createSettings()
  settings.ai.providers.codex = {
    enabled: true,
    apiKey: '',
    baseUrl: '',
    selectedModels: ['gpt-5.2-codex'],
    model: 'gpt-5.2-codex',
    oauthToken: 'tok',
  } as any
  return settings
}

const familyProviders = [
  { id: 'openai', name: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1' },
  { id: 'codex', name: 'Codex', requiresOAuth: true, defaultBaseUrl: '' },
  { id: 'anthropic', name: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com/v1' },
] as any[]

function mountFamilyTab() {
  mocks.cachedModels.codex = [model('gpt-5.2-codex')]
  return mount(AIProviderTab, {
    props: {
      settings: createFamilySettings(),
      providers: familyProviders,
    },
    global: {
      stubs: {
        ProviderIcon: { template: '<span class="provider-icon-stub" />' },
        AuthCard: { template: '<div class="auth-card-stub" />' },
        ProviderUsageCard: { template: '<div class="usage-card-stub" />' },
        ProviderModels: { template: '<div class="provider-models-stub" />' },
      },
    },
  })
}

describe('AIProviderTab provider families', () => {
  it('merges the API and subscription providers into one connection card', () => {
    const wrapper = mountFamilyTab()

    // openai + codex collapse into a single "OpenAI" card; anthropic stays.
    expect(wrapper.findAll('.conn-row')).toHaveLength(2)
    const familyRow = connRowByName(wrapper, 'OpenAI')
    expect(familyRow.text()).not.toContain('Codex —')
    expect(familyRow.find('.conn-summary').text()).toContain('API ✓')
    expect(familyRow.find('.conn-summary').text()).toContain('Codex ✓')
  })

  it('switches channels inside the family card without collapsing it', async () => {
    const wrapper = mountFamilyTab()

    await connRowByName(wrapper, 'OpenAI').trigger('click')
    await nextTick()
    expect(mocks.providerSettings.switchViewingProvider).toHaveBeenCalledWith('openai')

    const tabs = wrapper.findAll('.channel-tab')
    expect(tabs.map((tab) => tab.text().replace('✓', '').trim())).toEqual(['API', 'Codex'])

    await tabs[1].trigger('click')
    await nextTick()
    expect(mocks.providerSettings.switchViewingProvider).toHaveBeenCalledWith('codex')
    expect(wrapper.find('.conn-detail').exists()).toBe(true)
  })

  it('labels subscription-member ledger rows with the vendor family name', () => {
    const wrapper = mountFamilyTab()
    expect(ledgerRowById(wrapper, 'gpt-5.2-codex').text()).toContain('OpenAI · Codex')
  })

  it('toggles both family members with one switch in a single write', async () => {
    const wrapper = mountFamilyTab()

    const familyRow = connRowByName(wrapper, 'OpenAI')
    await familyRow.findComponent({ name: 'Switch' }).vm.$emit('change')
    expect(mocks.providerSettings.setProvidersEnabled).toHaveBeenCalledWith(
      ['openai', 'codex'],
      false,
    )
  })
})

describe('AIProviderTab connections', () => {
  it('shows every provider (including disabled) and expands the catalog on demand', async () => {
    const wrapper = mountProviderTab()

    expect(wrapper.findAll('.conn-row')).toHaveLength(2)
    expect(wrapper.find('.conn-detail').exists()).toBe(false)

    await connRowByName(wrapper, 'OpenAI').trigger('click')
    await nextTick()

    expect(mocks.providerSettings.switchViewingProvider).toHaveBeenCalledWith('openai')
    expect(connRowByName(wrapper, 'OpenAI').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.conn-detail').exists()).toBe(true)
    expect(wrapper.find('.provider-models-stub').exists()).toBe(true)

    // Collapse without re-switching.
    mocks.providerSettings.switchViewingProvider.mockClear()
    await connRowByName(wrapper, 'OpenAI').trigger('click')
    await nextTick()
    expect(wrapper.find('.conn-detail').exists()).toBe(false)
    expect(mocks.providerSettings.switchViewingProvider).not.toHaveBeenCalled()
  })
})

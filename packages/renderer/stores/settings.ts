import { defineStore } from 'pinia'
import { ref, toRaw, computed } from 'vue'
import type { AppSettings, ProviderInfo, CustomProviderConfig, OpenRouterModel } from '@/types'
import { AIProvider as AIProviderEnum } from '@shared/ipc'
import type { AIProviderId, ThinkingEffort, TypographyDensity } from '@shared/ipc'
import { createDefaultSettings } from '@shared/defaults/settings'
import { platformApi } from '@/platform'
import { modelsApi } from '@/platform/models-client'
import { providersApi } from '@/platform/providers-client'

const CHAT_FONT_CACHE_KEY = 'cached-chat-fonts'

// Cache chat font ids for main.ts to preload before first paint (same pattern
// as 'cached-theme'). Settings arrive via async IPC, too late for preload.
function cacheChatFonts(settings: { chat?: { chatFontEn?: string; chatFontZh?: string } }) {
  try {
    localStorage.setItem(CHAT_FONT_CACHE_KEY, JSON.stringify({
      en: settings.chat?.chatFontEn ?? null,
      zh: settings.chat?.chatFontZh ?? null,
    }))
  } catch {
    // localStorage may be unavailable (private browsing, storage quota)
  }
}

function isThemeDebugEnabled(): boolean {
  if (typeof localStorage?.getItem !== 'function') return false
  return import.meta.env.DEV && localStorage.getItem('onething:debug-theme') === '1'
}

// Read initial theme from what index.html already set (via URL hash or localStorage)
// This prevents the flash where Vue overwrites the correct theme with defaults
function getInitialTheme(): 'light' | 'dark' | 'system' {
  // First check what index.html already set on the document
  const docTheme = document.documentElement.getAttribute('data-theme')
  if (docTheme === 'light' || docTheme === 'dark') {
    if (isThemeDebugEnabled()) {
      console.log('[Theme] getInitialTheme: using document data-theme:', docTheme)
    }
    // We don't know if user setting is 'system' or explicit, so return the effective theme
    // loadSettings() will later update this to the actual setting
    return docTheme
  }
  /* Fallback to localStorage cache.
   *
   * 防御性取用不是洁癖:这一行跑在**模块作用域**(见下方 `initialTheme`),所以
   * 任何 import 到这个 store 的组件,在测试环境里只要 localStorage 是个残桩就会
   * 在 import 阶段整体炸掉 —— 排查起来像是"组件坏了",其实是主题缓存。 */
  const cached = typeof localStorage?.getItem === 'function'
    ? localStorage.getItem('cached-theme')
    : null
  if (cached === 'light' || cached === 'dark') {
    if (isThemeDebugEnabled()) {
      console.log('[Theme] getInitialTheme: using localStorage cache:', cached)
    }
    return cached
  }
  if (isThemeDebugEnabled()) {
    console.log('[Theme] getInitialTheme: no cached value, defaulting to dark')
  }
  return 'dark'
}

const initialTheme = getInitialTheme()
const DEFAULT_TYPOGRAPHY_DENSITY: TypographyDensity = 'compact'

function normalizeTypographyDensity(density: TypographyDensity | string | null | undefined): TypographyDensity {
  return density === 'comfortable' ? 'comfortable' : DEFAULT_TYPOGRAPHY_DENSITY
}

// Use shared default settings (single source of truth)
const defaultSettings: AppSettings = {
  ...createDefaultSettings(),
  // Override theme with initial theme to avoid flash
  theme: initialTheme,
}

interface ApplyAppearanceOptions {
  refreshSystemTheme?: boolean
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>(JSON.parse(JSON.stringify(defaultSettings)))
  const availableProviders = ref<ProviderInfo[]>([])

  // Model name cache: model ID -> display name
  const modelNameCache = ref<Map<string, string>>(new Map())

  // Model list cache: provider ID -> full model list (with capabilities)
  const providerModels = ref<Map<string, OpenRouterModel[]>>(new Map())
  const modelsLoading = ref<Map<string, boolean>>(new Map())

  const isLoading = ref(false)

  // System theme detection - use Electron's nativeTheme via IPC
  // Initialize from what index.html set (instead of hardcoding 'dark') to avoid flash
  const systemTheme = ref<'light' | 'dark'>(
    initialTheme === 'system' ? 'dark' : (initialTheme as 'light' | 'dark')
  )

  // Fetch system theme from main process (uses nativeTheme.shouldUseDarkColors)
  async function fetchSystemTheme() {
    try {
      const response = await platformApi.getSystemTheme()
      if (response.success && response.theme) {
        systemTheme.value = response.theme
      }
    } catch (error) {
      console.error('Failed to get system theme:', error)
    }
  }

  // Listen for system theme changes from main process
  platformApi.onSystemThemeChanged((theme: 'light' | 'dark') => {
    systemTheme.value = theme
    // Only apply if current setting is 'system'
    if (settings.value.theme === 'system') {
      void applyAppearanceFromSettings()
    }
  })

  // Computed: actual theme to apply (resolves 'system' to actual theme)
  const effectiveTheme = computed(() => {
    if (settings.value.theme === 'system') {
      return systemTheme.value
    }
    return settings.value.theme
  })

  // Apply appearance to document and JSON theme variables from the current settings.
  async function applyAppearanceFromSettings(
    nextSettings?: AppSettings,
    options: ApplyAppearanceOptions = {}
  ): Promise<void> {
    if (nextSettings) {
      settings.value = JSON.parse(JSON.stringify(toRaw(nextSettings))) as AppSettings
      if (!settings.value.ai.customProviders) {
        settings.value.ai.customProviders = []
      }
    }

    if (settings.value.theme === 'system' && options.refreshSystemTheme) {
      await fetchSystemTheme()
    }

    const theme = effectiveTheme.value
    const currentTheme = document.documentElement.getAttribute('data-theme')
    if (isThemeDebugEnabled()) {
      console.log('[Theme] applyAppearanceFromSettings called:', {
        effectiveTheme: theme,
        currentDataTheme: currentTheme,
        settingsTheme: settings.value.theme,
        systemTheme: systemTheme.value,
        stack: new Error().stack?.split('\n').slice(1, 4).join('\n')
      })
    }

    // Always apply color theme and base theme first
    // They may need updating even if base theme hasn't changed
    applyColorTheme()
    applyBaseTheme()
    applyTypographyDensity()

    if (currentTheme !== theme) {
      document.documentElement.setAttribute('data-theme', theme)
      // Cache effective theme to localStorage for instant startup
      localStorage.setItem('cached-theme', theme)
    } else if (isThemeDebugEnabled()) {
      console.log('[Theme] Base theme already correct:', theme)
    }

    // Reapply JSON theme to match the new mode
    await reapplyJsonTheme()
  }

  // Backward-compatible fire-and-forget wrapper for existing call sites.
  function applyTheme() {
    void applyAppearanceFromSettings()
  }

  // Helper to reapply JSON theme (avoids circular import)
  async function reapplyJsonTheme(): Promise<void> {
    const { useThemeStore } = await import('./themes')
    const themeStore = useThemeStore()
    themeStore.syncThemeIdsFromSettings(settings.value.general)
    await themeStore.reapplyTheme()
  }

  // Apply color theme to document
  function applyColorTheme() {
    const colorTheme = settings.value.general?.colorTheme || 'blue'
    const currentColorTheme = document.documentElement.getAttribute('data-color-theme')
    if (isThemeDebugEnabled()) {
      console.log('[Theme] applyColorTheme:', { from: currentColorTheme, to: colorTheme })
    }
    if (currentColorTheme === colorTheme) {
      return // Already correct
    }
    document.documentElement.setAttribute('data-color-theme', colorTheme)
    // Cache color theme to localStorage for instant startup
    localStorage.setItem('cached-color-theme', colorTheme)
  }

  // Apply base theme to document
  function applyBaseTheme() {
    const baseTheme = settings.value.general?.baseTheme || 'obsidian'
    const currentBaseTheme = document.documentElement.getAttribute('data-base-theme')
    if (currentBaseTheme === baseTheme) {
      return // Already correct
    }
    document.documentElement.setAttribute('data-base-theme', baseTheme)
  }

  function applyTypographyDensity() {
    const typographyDensity = normalizeTypographyDensity(settings.value.general?.typographyDensity)
    const currentTypographyDensity = document.documentElement.getAttribute('data-typography-density')
    if (currentTypographyDensity === typographyDensity) {
      return // Already correct
    }
    document.documentElement.setAttribute('data-typography-density', typographyDensity)
  }

  async function loadSettings() {
    isLoading.value = true
    try {
      // Load settings, providers, and model aliases in parallel
      const [settingsResponse, providersResponse, aliasesResponse] = await Promise.all([
        platformApi.getSettings(),
        providersApi.getProviders(),
        modelsApi.getModelNameAliases(),
      ])

      if (settingsResponse.success && settingsResponse.settings) {
        settings.value = settingsResponse.settings
        // Ensure customProviders array exists
        if (!settings.value.ai.customProviders) {
          settings.value.ai.customProviders = []
        }
        await applyAppearanceFromSettings(undefined, {
          refreshSystemTheme: settings.value.theme === 'system',
        })
        cacheChatFonts(settings.value)
      }

      if (providersResponse.success && providersResponse.providers) {
        // Merge built-in providers with custom providers
        updateAvailableProviders(providersResponse.providers)
      }

      // Load model name aliases into cache
      if (aliasesResponse.success && aliasesResponse.aliases) {
        for (const [modelId, displayName] of Object.entries(aliasesResponse.aliases)) {
          modelNameCache.value.set(modelId, displayName as string)
        }
      }
    } finally {
      isLoading.value = false
    }
  }

  // Update available providers by merging built-in and custom providers
  function updateAvailableProviders(builtInProviders: ProviderInfo[]) {
    const customProviders = settings.value.ai.customProviders || []
    const customProviderInfos: ProviderInfo[] = customProviders.map(cp => ({
      id: cp.id,
      name: cp.name,
      description: cp.description || `Custom ${cp.apiType === 'openai' ? 'OpenAI' : 'Anthropic'}-compatible API`,
      defaultBaseUrl: cp.baseUrl || '',
      defaultModel: cp.model || '',
      icon: 'custom',
      supportsCustomBaseUrl: true,
      requiresApiKey: true,
    }))

    availableProviders.value = [...builtInProviders, ...customProviderInfos]
  }

  async function loadProviders() {
    try {
      const response = await providersApi.getProviders()
      if (response.success && response.providers) {
        // Merge with custom providers — a bare assignment here would clobber
        // any custom providers a previous loadSettings() merge had populated.
        updateAvailableProviders(response.providers)
      }
    } catch (error) {
      console.error('Failed to load providers:', error)
    }
  }

  async function saveSettings(newSettings: AppSettings) {
    isLoading.value = true
    try {
      const plainSettings = JSON.parse(JSON.stringify(toRaw(newSettings))) as AppSettings

      // Check if theme-related settings changed
      const themeChanged =
        settings.value.theme !== plainSettings.theme ||
        settings.value.general?.colorTheme !== plainSettings.general?.colorTheme ||
        settings.value.general?.baseTheme !== plainSettings.general?.baseTheme ||
        settings.value.general?.themeId !== plainSettings.general?.themeId ||
        settings.value.general?.darkThemeId !== plainSettings.general?.darkThemeId ||
        settings.value.general?.lightThemeId !== plainSettings.general?.lightThemeId ||
        settings.value.general?.typographyDensity !== plainSettings.general?.typographyDensity

      // Detect changes to the customProviders list so we can rebuild
      // availableProviders — otherwise the InputBox ModelSelector and the
      // provider settings page stay stale after add/edit/delete via the
      // SettingsPage flow (which mutates localSettings then auto-saves).
      const prevCustomKey = JSON.stringify(settings.value.ai?.customProviders ?? [])
      const nextCustomKey = JSON.stringify(plainSettings.ai?.customProviders ?? [])
      const customProvidersChanged = prevCustomKey !== nextCustomKey

      settings.value = plainSettings
      const response = await platformApi.saveSettings(plainSettings)
      if (!response.success) {
        throw new Error(response.error || 'Failed to save settings')
      }
      const savedSettings = response.settings ?? plainSettings
      settings.value = savedSettings
      cacheChatFonts(savedSettings)

      // Only apply theme if theme-related settings actually changed
      if (themeChanged) {
        await applyAppearanceFromSettings(undefined, {
          refreshSystemTheme: savedSettings.theme === 'system',
        })
      }

      if (customProvidersChanged) {
        await refreshAvailableProviders()
      }
    } finally {
      isLoading.value = false
    }
  }

  function updateAIProvider(provider: AIProviderId) {
    settings.value.ai.provider = provider
  }

  function ensureProviderConfig(provider: AIProviderId): AppSettings['ai']['providers'][string] {
    const providers = settings.value.ai.providers as Record<string, AppSettings['ai']['providers'][string]>
    if (!providers[provider]) {
      providers[provider] = {
        apiKey: '',
        baseUrl: '',
        model: '',
        selectedModels: [],
      }
    }
    return providers[provider]
  }

  function updateAPIKey(apiKey: string, provider?: AIProviderId) {
    const targetProvider = provider || settings.value.ai.provider
    ensureProviderConfig(targetProvider).apiKey = apiKey
  }

  function updateModel(model: string, provider?: AIProviderId) {
    const targetProvider = provider || settings.value.ai.provider
    ensureProviderConfig(targetProvider).model = model
  }

  function updateTemperature(temperature: number) {
    settings.value.ai.temperature = Math.max(0, Math.min(2, temperature))
  }

  /**
   * The single persisting entry point for changing the user's global
   * default provider/model. Unlike updateAIProvider/updateModel (which stay
   * synchronous, side-effect-free mutations of the in-memory copy — other
   * callers rely on that), this immediately saves to disk via the existing
   * saveSettings → SETTINGS_CHANGED pipeline, so the renderer's displayed
   * global default can never silently drift from what the engine reads at
   * send time. See stores/themes.ts for the same
   * clone-then-saveSettings pattern.
   */
  async function saveAIProviderDefault(provider: AIProviderId, model: string) {
    const nextProviderConfig = {
      apiKey: '',
      baseUrl: '',
      ...settings.value.ai.providers[provider],
    }
    nextProviderConfig.selectedModels = nextProviderConfig.selectedModels ?? []
    nextProviderConfig.model = model

    const next: AppSettings = {
      ...settings.value,
      ai: {
        ...settings.value.ai,
        provider,
        providers: {
          ...settings.value.ai.providers,
          [provider]: nextProviderConfig,
        },
      },
    }
    await saveSettings(next)
  }

  /**
   * Single persisting entry point for per-model thinking configuration
   * (thinking on/off, effort level, codex service tier). Reads the latest
   * in-memory settings at call time and writes only the three maps — callers
   * must not hold their own settings snapshot and write the whole object back
   * (that pattern clobbers concurrent field updates).
   */
  async function updateProviderThinking(
    provider: AIProviderId,
    model: string,
    patch: {
      enabled?: boolean
      effort?: ThinkingEffort
      serviceTier?: string | null
    },
  ) {
    const current = settings.value.ai.providers[provider] ?? {
      apiKey: '',
      model: '',
      selectedModels: [],
    }
    const nextConfig = { ...current }

    if (patch.enabled !== undefined) {
      nextConfig.thinkingByModel = {
        ...(current.thinkingByModel ?? {}),
        [model]: patch.enabled,
      }
    }
    if (patch.effort !== undefined) {
      nextConfig.thinkingEffortByModel = {
        ...(current.thinkingEffortByModel ?? {}),
        [model]: patch.effort,
      }
    }
    if (patch.serviceTier !== undefined) {
      const serviceTierMap = { ...(current.serviceTierByModel ?? {}) }
      if (patch.serviceTier) serviceTierMap[model] = patch.serviceTier
      else delete serviceTierMap[model]
      nextConfig.serviceTierByModel = serviceTierMap
    }

    await saveSettings({
      ...settings.value,
      ai: {
        ...settings.value.ai,
        providers: {
          ...settings.value.ai.providers,
          [provider]: nextConfig,
        },
      },
    })
  }

  async function updateTheme(theme: 'light' | 'dark' | 'system') {
    settings.value.theme = theme

    await applyAppearanceFromSettings(undefined, {
      refreshSystemTheme: theme === 'system',
    })
  }

  function updateSendShortcut(shortcut: 'enter' | 'ctrl-enter' | 'cmd-enter') {
    settings.value.general.sendShortcut = shortcut
  }

  function updateColorTheme(colorTheme: 'blue' | 'purple' | 'green' | 'orange' | 'pink' | 'cyan' | 'red') {
    settings.value.general.colorTheme = colorTheme
    applyColorTheme()
  }

  function updateBaseTheme(baseTheme: 'obsidian' | 'ocean' | 'forest' | 'rose' | 'ember') {
    settings.value.general.baseTheme = baseTheme
    applyBaseTheme()
  }

  function updateMessageListDensity(density: 'compact' | 'comfortable' | 'spacious') {
    settings.value.general.messageListDensity = density
  }

  function updateTypographyDensity(density: TypographyDensity) {
    settings.value.general.typographyDensity = normalizeTypographyDensity(density)
    applyTypographyDensity()
  }

  // Get current provider's config
  function getCurrentProviderConfig() {
    return settings.value.ai.providers[settings.value.ai.provider]
  }

  // Get provider info by ID
  function getProviderInfo(providerId: string): ProviderInfo | undefined {
    return availableProviders.value.find(p => p.id === providerId)
  }

  // Check if a provider is a custom provider
  function isCustomProvider(providerId: string): boolean {
    return settings.value.ai.customProviders?.some(p => p.id === providerId) || false
  }

  // Get custom provider config by ID
  function getCustomProvider(providerId: string): CustomProviderConfig | undefined {
    return settings.value.ai.customProviders?.find(p => p.id === providerId)
  }

  // Add a new custom provider
  function addCustomProvider(provider: CustomProviderConfig) {
    if (!settings.value.ai.customProviders) {
      settings.value.ai.customProviders = []
    }
    // Ensure unique ID
    if (settings.value.ai.customProviders.some(p => p.id === provider.id)) {
      throw new Error(`Provider with ID "${provider.id}" already exists`)
    }
    settings.value.ai.customProviders.push(provider)

    // Also add to providers config for API key and model storage
    settings.value.ai.providers[provider.id] = {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
      selectedModels: provider.selectedModels,
    }

    // Refresh available providers
    refreshAvailableProviders()
  }

  // Update an existing custom provider
  function updateCustomProvider(providerId: string, updates: Partial<CustomProviderConfig>) {
    const index = settings.value.ai.customProviders?.findIndex(p => p.id === providerId) ?? -1
    if (index === -1) return

    const provider = settings.value.ai.customProviders![index]
    Object.assign(provider, updates)

    // Also update providers config
    if (settings.value.ai.providers[providerId]) {
      if (updates.apiKey !== undefined) {
        settings.value.ai.providers[providerId].apiKey = updates.apiKey
      }
      if (updates.baseUrl !== undefined) settings.value.ai.providers[providerId].baseUrl = updates.baseUrl
      if (updates.model !== undefined) settings.value.ai.providers[providerId].model = updates.model
      if (updates.selectedModels !== undefined) settings.value.ai.providers[providerId].selectedModels = updates.selectedModels
    }

    // Refresh available providers
    refreshAvailableProviders()
  }

  // Delete a custom provider
  function deleteCustomProvider(providerId: string) {
    const index = settings.value.ai.customProviders?.findIndex(p => p.id === providerId) ?? -1
    if (index === -1) return

    settings.value.ai.customProviders!.splice(index, 1)

    // Remove from providers config
    delete settings.value.ai.providers[providerId]

    // If this was the active provider, switch to OpenAI
    if (settings.value.ai.provider === providerId) {
      settings.value.ai.provider = AIProviderEnum.OpenAI
    }

    // Refresh available providers
    refreshAvailableProviders()
  }

  // Refresh available providers list (used after adding/updating/deleting custom providers)
  async function refreshAvailableProviders() {
    try {
      const response = await providersApi.getProviders()
      if (response.success && response.providers) {
        updateAvailableProviders(response.providers)
      }
    } catch (error) {
      console.error('Failed to refresh providers:', error)
    }
  }

  // Update model name cache with fetched models
  function updateModelNameCache(models: Array<{ id: string; name: string }>) {
    for (const model of models) {
      if (model.id && model.name) {
        modelNameCache.value.set(model.id, model.name)
      }
    }
  }

  // Get display name for a model ID
  function getModelDisplayName(modelId: string): string {
    return modelNameCache.value.get(modelId) || modelId
  }

  // ========== Unified Model List Management ==========

  /**
   * Check if models are loading for a provider
   */
  function isModelsLoading(providerId: string): boolean {
    return modelsLoading.value.get(providerId) || false
  }

  /**
   * Get cached models for a provider (returns empty array if not cached)
   */
  function getCachedModels(providerId: string): OpenRouterModel[] {
    return providerModels.value.get(providerId) || []
  }

  /**
   * Check if models are cached for a provider
   */
  function hasModelsCache(providerId: string): boolean {
    return providerModels.value.has(providerId)
  }

  /**
   * Fetch models for a provider. Most providers read from settings.json
   * modelRegistry; provider-direct model sources such as Codex and Copilot are
   * fetched by the main-process IPC handler.
   */
  async function fetchModelsForProvider(
    providerId: string,
    forceRefresh = false
  ): Promise<OpenRouterModel[]> {
    // Return cached if available and not forcing refresh
    if (!forceRefresh && providerModels.value.has(providerId)) {
      const cachedModels = providerModels.value.get(providerId)!
      const selectedIds = settings.value.ai.providers[providerId]?.selectedModels || []
      const codexMissingSelectedMetadata = providerId === 'codex' &&
        selectedIds.some((id) => !cachedModels.some((model) => model.id === id))
      if (!codexMissingSelectedMetadata) {
        return cachedModels
      }
    }

    // Check if already loading
    if (modelsLoading.value.get(providerId)) {
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (!modelsLoading.value.get(providerId)) {
            clearInterval(checkInterval)
            resolve(providerModels.value.get(providerId) || [])
          }
        }, 100)
      })
    }

    modelsLoading.value.set(providerId, true)

    try {
      // Read from settings.json modelRegistry (via IPC)
      const response = await modelsApi.getModelsWithCapabilities(providerId, { forceRefresh })

      if (response.success && response.models && response.models.length > 0) {
        const models = response.models
        providerModels.value.set(providerId, models)
        updateModelNameCache(models)
        return models
      }

      // No models in registry yet — user needs to refresh
      providerModels.value.set(providerId, [])
      return []
    } catch (error) {
      console.error(`[SettingsStore] Failed to fetch models for ${providerId}:`, error)
      providerModels.value.set(providerId, [])
      return []
    } finally {
      modelsLoading.value.set(providerId, false)
    }
  }

  /**
   * Refresh model registry from models.dev and fetch fresh models for a provider.
   * Provider-direct model sources bypass models.dev and fetch only their own API.
   */
  async function refreshModelsForProvider(providerId: string): Promise<OpenRouterModel[]> {
    const providerDirectModels = new Set(['codex', 'github-copilot'])
    if (!providerDirectModels.has(providerId)) {
      try {
        await modelsApi.refreshModelRegistry()
      } catch (error) {
        console.warn('[SettingsStore] Failed to refresh model registry:', error)
      }
    }
    // Clear client-side cache so we re-read from the registry or provider API.
    providerModels.value.delete(providerId)
    return fetchModelsForProvider(providerId, true)
  }

  /**
   * Get chat models for a provider (filtered from full list)
   * Excludes embedding and image-only models
   */
  async function getChatModels(providerId: string): Promise<OpenRouterModel[]> {
    const models = await fetchModelsForProvider(providerId)
    return models.filter(m => {
      // Exclude embedding models
      if (m.architecture?.output_modalities?.includes('embeddings')) {
        return false
      }
      const embeddingPatterns = ['embedding', 'text-embedding', 'ada-002']
      if (embeddingPatterns.some(p => m.id.toLowerCase().includes(p))) {
        return false
      }
      // Include if has text output
      return m.architecture?.output_modalities?.includes('text') ?? true
    })
  }

  /**
   * Get selected models for a provider (from user's selectedModels list)
   * Returns full model info for each selected model ID
   */
  async function getSelectedModels(providerId: string): Promise<OpenRouterModel[]> {
    const allModels = await fetchModelsForProvider(providerId)
    const selectedIds = settings.value.ai.providers[providerId]?.selectedModels || []

    // Map selected IDs to full model objects, preserving order
    const selectedModels: OpenRouterModel[] = []
    for (const id of selectedIds) {
      const model = allModels.find(m => m.id === id)
      if (model) {
        selectedModels.push({
          ...model,
          name: getModelDisplayName(model.id) || model.name,
        })
      } else {
        // Create placeholder for models not in the full list
        selectedModels.push({
          id,
          name: getModelDisplayName(id) || id,
          context_length: 0,
          architecture: {
            modality: 'text' as const,
            input_modalities: ['text'],
            output_modalities: ['text'],
            tokenizer: 'unknown',
          },
          pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
          top_provider: { context_length: 0, max_completion_tokens: 0, is_moderated: false },
          supported_parameters: [],
        })
      }
    }

    return selectedModels
  }

  /**
   * Clear model cache for a provider (or all if no provider specified)
   */
  function clearModelsCache(providerId?: string) {
    if (providerId) {
      providerModels.value.delete(providerId)
    } else {
      providerModels.value.clear()
    }
  }

  /**
   * Add a custom model to the cache for a provider
   */
  function addCustomModelToCache(providerId: string, model: OpenRouterModel) {
    const existing = providerModels.value.get(providerId) || []
    if (!existing.find(m => m.id === model.id)) {
      providerModels.value.set(providerId, [...existing, model])
    }
  }

  /**
   * Preload models for multiple providers in background
   */
  async function preloadModels(providerIds: string[]) {
    await Promise.all(
      providerIds.map(id => fetchModelsForProvider(id))
    )
  }

  return {
    settings,
    availableProviders,
    isLoading,
    effectiveTheme,
    loadSettings,
    loadProviders,
    saveSettings,
    updateAIProvider,
    updateAPIKey,
    updateModel,
    updateTemperature,
    saveAIProviderDefault,
    updateProviderThinking,
    updateTheme,
    updateSendShortcut,
    getCurrentProviderConfig,
    getProviderInfo,
    isCustomProvider,
    getCustomProvider,
    addCustomProvider,
    updateCustomProvider,
    deleteCustomProvider,
    refreshAvailableProviders,
    applyAppearanceFromSettings,
    applyTheme,
    applyColorTheme,
    applyBaseTheme,
    applyTypographyDensity,
    updateColorTheme,
    updateBaseTheme,
    updateMessageListDensity,
    updateTypographyDensity,
    // Model name cache
    updateModelNameCache,
    getModelDisplayName,
    // Unified model list management
    providerModels,
    isModelsLoading,
    getCachedModels,
    hasModelsCache,
    fetchModelsForProvider,
    refreshModelsForProvider,
    getChatModels,
    getSelectedModels,
    clearModelsCache,
    addCustomModelToCache,
    preloadModels,
  }
})

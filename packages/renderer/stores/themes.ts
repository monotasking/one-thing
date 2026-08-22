import { themesApi } from '@/platform/themes-client'
import { getLogger } from '@/services/log'
/**
 * Theme Store
 * Manages theme loading, application, and preview functionality
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ThemeMeta, Theme, GetThemesResponse, ApplyThemeResponse, GeneralSettings } from '@shared/ipc'
import { withStateAlpha } from '../styles/state-alpha'
import { useSettingsStore } from './settings'

const log = getLogger('renderer.themes')

/**
 * 插件目录变化监听只挂一次。
 *
 * `initialize()` 在同一个 window 里可能被调用多次(设置窗/主窗各自建 store、
 * 设置变更后重跑),每次都 addEventListener 的话,插件一开一关就会触发 N 次
 * applyTheme。闩在模块级而不是 store 内:store 实例本身也可能被重建。
 */
let pluginsChangedBound = false

export const useThemeStore = defineStore('themes', () => {
  // ============= State =============

  /** All available themes (built-in + custom) */
  const availableThemes = ref<ThemeMeta[]>([])

  /** Theme ID for dark mode */
  const darkThemeId = ref<string>('flexoki')

  /** Theme ID for light mode */
  const lightThemeId = ref<string>('flexoki')

  /** Loading state */
  const isLoading = ref(false)

  /** Error message if any */
  const error = ref<string | null>(null)

  /** Cached full theme objects */
  const themeCache = ref<Map<string, Theme>>(new Map())

  /** Preview theme ID (null when not previewing) */
  const previewThemeId = ref<string | null>(null)

  /** Original theme ID before preview (for restore) */
  const prePreviewThemeId = ref<string | null>(null)

  // ============= Computed =============

  /** Current theme ID based on effective theme mode */
  const currentThemeId = computed(() => {
    const settingsStore = useSettingsStore()
    const mode = settingsStore.effectiveTheme
    return mode === 'dark' ? darkThemeId.value : lightThemeId.value
  })

  /** Currently displayed theme (preview or actual) */
  const displayedThemeId = computed(() => previewThemeId.value || currentThemeId.value)

  /** Get current theme meta */
  const currentThemeMeta = computed(() =>
    availableThemes.value.find(t => t.id === currentThemeId.value)
  )

  /** Built-in themes */
  const builtinThemes = computed(() =>
    availableThemes.value.filter(t => t.source === 'builtin')
  )

  /** User custom themes */
  const userThemes = computed(() =>
    availableThemes.value.filter(t => t.source === 'user')
  )

  /** Project themes */
  const projectThemes = computed(() =>
    availableThemes.value.filter(t => t.source === 'project')
  )

  // ============= Actions =============

  /**
   * Load all available themes from main process
   */
  async function loadThemes(): Promise<void> {
    isLoading.value = true
    error.value = null

    try {
      const response: GetThemesResponse = await themesApi.getAll({})

      if (response.success && response.themes) {
        availableThemes.value = response.themes
        log.debug('themes loaded', { count: response.themes.length })
      } else {
        error.value = response.error || 'Failed to load themes'
        log.error('themes load failed', { error: response.error })
      }
    } catch (err: any) {
      error.value = err.message
      log.error('themes load failed', {}, err)
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Get full theme object (with caching)
   */
  async function getTheme(themeId: string): Promise<Theme | null> {
    // Check cache first
    const cached = themeCache.value.get(themeId)
    if (cached) return cached

    try {
      const response = await themesApi.get({ themeId })

      if (response.success && response.theme) {
        themeCache.value.set(themeId, response.theme)
        return response.theme
      }

      log.error('theme fetch failed', { themeId, error: response.error })
      return null
    } catch (err: any) {
      log.error('theme fetch failed', { themeId }, err)
      return null
    }
  }

  /**
   * Set theme for a specific mode (dark or light)
   * IMPORTANT: Only updates the selected mode's ref, preserves the other mode's ref.
   * Refs are the source of truth, not settings.
   * @param themeId - Theme ID to set
   * @param mode - Which mode to set the theme for ('dark' | 'light')
   */
  async function setThemeForMode(themeId: string, mode: 'dark' | 'light'): Promise<boolean> {
    const settingsStore = useSettingsStore()

    // Only update the selected mode's ref, DO NOT touch the other mode's ref
    // This ensures refs remain the source of truth and prevents race conditions
    if (mode === 'dark') {
      darkThemeId.value = themeId
    } else {
      lightThemeId.value = themeId
    }

    // Build new settings using current ref values (refs are source of truth)
    // Spread the original general object to preserve all required properties
    const newSettings = {
      ...settingsStore.settings,
      general: {
        ...settingsStore.settings.general,
        darkThemeId: darkThemeId.value || settingsStore.settings.general?.darkThemeId || 'flexoki',
        lightThemeId: lightThemeId.value || settingsStore.settings.general?.lightThemeId || 'flexoki',
      },
    }
    await settingsStore.saveSettings(newSettings)

    // Only apply if current mode matches
    if (settingsStore.effectiveTheme === mode) {
      return await applyCurrentTheme()
    }

    log.debug('theme set for mode', { mode, themeId })
    return true
  }

  /**
   * Apply the current effective theme
   * Used internally and when mode changes
   */
  async function applyCurrentTheme(): Promise<boolean> {
    const settingsStore = useSettingsStore()
    const mode = settingsStore.effectiveTheme
    const themeId = currentThemeId.value

    try {
      const response: ApplyThemeResponse = await themesApi.apply({ themeId, mode })

      if (response.success && response.cssVariables) {
        applyThemeVariables(response.cssVariables)

        // Cache to localStorage for instant startup
        localStorage.setItem('cached-theme-id', themeId)
        localStorage.setItem('cached-dark-theme-id', darkThemeId.value)
        localStorage.setItem('cached-light-theme-id', lightThemeId.value)

        log.debug('theme applied', { themeId, mode })
        return true
      }

      log.error('theme apply failed', { themeId, mode, error: response.error })
      error.value = response.error || 'Failed to apply theme'
      return false
    } catch (err: any) {
      log.error('theme apply failed', { themeId, mode }, err)
      error.value = err.message
      return false
    }
  }

  /**
   * Legacy: Apply a theme (for backward compatibility)
   * @deprecated Use setThemeForMode instead
   */
  async function setTheme(themeId: string, saveToSettings = true): Promise<boolean> {
    const settingsStore = useSettingsStore()
    const mode = settingsStore.effectiveTheme

    // Update the theme for current mode
    if (mode === 'dark') {
      darkThemeId.value = themeId
    } else {
      lightThemeId.value = themeId
    }

    // Save to settings if requested
    if (saveToSettings) {
      const newSettings = {
        ...settingsStore.settings,
        general: {
          ...settingsStore.settings.general,
          darkThemeId: darkThemeId.value,
          lightThemeId: lightThemeId.value,
        },
      }
      await settingsStore.saveSettings(newSettings)
    }

    return await applyCurrentTheme()
  }

  /**
   * Apply CSS variables to document
   */
  function applyThemeVariables(rawVariables: Record<string, string>): void {
    const root = document.documentElement
    // 主题层产出的是**实色**;态 token 在落到 documentElement 之前先穿上 alpha 公式
    // (Surface v2·行为内置,见 styles/state-alpha.ts)。这是全仓唯一的落地口。
    const variables = withStateAlpha(rawVariables)

    for (const [key, value] of Object.entries(variables)) {
      root.style.setProperty(key, value)
    }

    // Cache CSS variables to localStorage for instant startup
    try {
      localStorage.setItem('cached-theme-css', JSON.stringify(variables))
    } catch (e) {
      log.warn('css variable cache write failed', {}, e)
    }

    if (log.isLevelEnabled('debug')) {
      const variableKeys = Object.keys(variables)
      const hljsVars = variableKeys.filter(k =>
        k.startsWith('--hg-') ||
        k.startsWith('--hljs-') ||
        k.startsWith('--bg-code') ||
        k.startsWith('--text-code')
      )
      log.debug('css variables applied', { count: variableKeys.length, highlightVars: hljsVars })
    }
  }

  /**
   * Start previewing a theme (on hover)
   */
  async function startPreview(themeId: string): Promise<void> {
    // Skip if already previewing this theme
    if (previewThemeId.value === themeId) return

    // Save original theme on first preview
    if (!prePreviewThemeId.value) {
      prePreviewThemeId.value = currentThemeId.value
    }

    const settingsStore = useSettingsStore()
    const mode = settingsStore.effectiveTheme

    try {
      const response = await themesApi.apply({ themeId, mode })

      if (response.success && response.cssVariables) {
        applyThemeVariables(response.cssVariables)
        previewThemeId.value = themeId
        log.debug('theme preview started', { themeId, mode })
      }
    } catch (err: any) {
      log.error('theme preview failed', { themeId, mode }, err)
    }
  }

  /**
   * Cancel preview and restore original theme
   */
  async function cancelPreview(): Promise<void> {
    if (!prePreviewThemeId.value) return

    const originalId = prePreviewThemeId.value
    previewThemeId.value = null
    prePreviewThemeId.value = null

    // Restore original theme
    await setTheme(originalId)
    log.debug('theme preview cancelled', { restoredThemeId: originalId })
  }

  /**
   * Confirm preview (apply previewed theme permanently for current mode)
   */
  async function confirmPreview(): Promise<void> {
    if (!previewThemeId.value) return

    const previewedId = previewThemeId.value
    const settingsStore = useSettingsStore()
    const mode = settingsStore.effectiveTheme

    // Update the appropriate theme ID
    if (mode === 'dark') {
      darkThemeId.value = previewedId
    } else {
      lightThemeId.value = previewedId
    }

    previewThemeId.value = null
    prePreviewThemeId.value = null

    // Cache to localStorage
    localStorage.setItem('cached-theme-id', previewedId)
    localStorage.setItem('cached-dark-theme-id', darkThemeId.value)
    localStorage.setItem('cached-light-theme-id', lightThemeId.value)

    // Save to settings for persistence and cross-window sync
    const newSettings = {
      ...settingsStore.settings,
      general: {
        ...settingsStore.settings.general,
        darkThemeId: darkThemeId.value,
        lightThemeId: lightThemeId.value,
      },
    }
    await settingsStore.saveSettings(newSettings)

    log.debug('theme preview confirmed', { themeId: previewedId, mode })
  }

  /**
   * Refresh themes from filesystem (reload custom themes)
   */
  async function refreshThemes(projectPath?: string): Promise<void> {
    isLoading.value = true
    error.value = null

    try {
      const response = await themesApi.refresh({ projectPath })

      if (response.success && response.themes) {
        availableThemes.value = response.themes
        // Clear cache to pick up any theme file changes
        themeCache.value.clear()
        log.debug('themes refreshed', { count: response.themes.length })
      } else {
        error.value = response.error || 'Failed to refresh themes'
      }
    } catch (err: any) {
      error.value = err.message
      log.error('themes refresh failed', {}, err)
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Open themes folder in file explorer
   */
  async function openThemesFolder(): Promise<void> {
    try {
      await themesApi.openFolder({})
    } catch (err: any) {
      log.error('open themes folder failed', {}, err)
    }
  }

  /**
   * Sync the mode-specific theme ids from persisted settings.
   * This is used when settings arrive from another renderer window.
   */
  function syncThemeIdsFromSettings(general?: GeneralSettings): void {
    darkThemeId.value = general?.darkThemeId || general?.themeId || 'flexoki'
    lightThemeId.value = general?.lightThemeId || general?.themeId || 'flexoki'
  }

  /**
   * Initialize theme store (called on app startup)
   */
  async function initialize(): Promise<void> {
    const settingsStore = useSettingsStore()
    const general = settingsStore.settings.general

    // Handle migration from old single themeId to dual theme IDs
    if (general?.darkThemeId || general?.lightThemeId || general?.themeId) {
      syncThemeIdsFromSettings(general)
    } else {
      // Check localStorage cache
      const cachedDark = localStorage.getItem('cached-dark-theme-id')
      const cachedLight = localStorage.getItem('cached-light-theme-id')
      const cachedLegacy = localStorage.getItem('cached-theme-id')

      darkThemeId.value = cachedDark || cachedLegacy || 'flexoki'
      lightThemeId.value = cachedLight || cachedLegacy || 'flexoki'
    }

    log.debug('theme store initialized', {
      darkThemeId: darkThemeId.value,
      lightThemeId: lightThemeId.value,
    })

    // Load available themes
    await loadThemes()

    // 插件目录变化 → 重推主题(B 期,L2)。
    //
    // 插件的 `contributes.theme` 覆盖由**主进程**叠在主题产出之上,所以
    // renderer 不需要知道覆盖这件事的存在 —— 重新拉一次当前主题,拿到的
    // 变量表就已经是合成后的。不新开 IPC 通道:enable/disable/install/
    // uninstall 都会广播 catalog-changed,ipc-hub 把它转成这个 window 事件。
    if (!pluginsChangedBound) {
      pluginsChangedBound = true
      window.addEventListener('onething:plugins-changed', () => {
        void applyCurrentTheme()
      })
    }

    // Apply current theme based on effective mode
    await applyCurrentTheme()
  }

  /**
   * Re-apply current theme (used when mode changes light<->dark)
   * IMPORTANT: This function should NOT override refs from settings!
   * The refs (darkThemeId, lightThemeId) are the source of truth,
   * maintained by setThemeForMode. This function only applies the
   * current theme based on the existing refs.
   */
  async function reapplyTheme(): Promise<void> {
    // Only apply current theme, do NOT sync refs from settings
    // Refs are maintained by setThemeForMode and should not be overwritten here
    await applyCurrentTheme()
  }

  return {
    // State
    availableThemes,
    darkThemeId,
    lightThemeId,
    isLoading,
    error,
    previewThemeId,

    // Computed
    currentThemeId,
    displayedThemeId,
    currentThemeMeta,
    builtinThemes,
    userThemes,
    projectThemes,

    // Actions
    loadThemes,
    getTheme,
    setTheme,
    setThemeForMode,
    applyCurrentTheme,
    startPreview,
    cancelPreview,
    confirmPreview,
    refreshThemes,
    openThemesFolder,
    syncThemeIdsFromSettings,
    initialize,
    reapplyTheme,
  }
})

<template>
  <div class="settings-page">
    <!-- Loading State -->
    <div
      v-if="isLoading"
      class="loading-state"
    >
      <div class="loading-spinner" />
      <span>Loading settings...</span>
    </div>

    <Container
      v-else
      class="settings-window"
      full-height
      overflow="hidden"
      main-overflow="hidden"
      sidebar-overflow="hidden"
      :sidebar-width="214"
      body-class="settings-layout"
      header-class="settings-titlebar"
      sidebar-class="settings-sidebar"
      main-class="settings-content"
    >
      <template #header>
        <div class="titlebar-title">
          Settings
        </div>
        <!-- 「你在改哪个空间的配置」(批 B7)。这不是一张新表单,是一块标识 ——
             凭证/模型这些页面本来就是**当前空间的**,不写出来用户会以为在改全局。
             切换写的是同一份 window 级 currentSpaceId,主窗会跟着切。 -->
        <div
          v-if="spacesStore.available"
          class="titlebar-space"
        >
          <span class="titlebar-space-label">当前空间</span>
          <Select
            variant="ledger"
            size="small"
            teleported
            fit-input-width
            class="titlebar-space-select"
            :model-value="spacesStore.currentSpaceId"
            :options="spaceOptions"
            aria-label="当前空间(设置页改的就是这个空间的配置)"
            @update:model-value="spacesStore.switchTo(String($event))"
          />
        </div>
        <div
          class="titlebar-save-state"
          :class="{ active: hasUnsavedChanges }"
        >
          {{ hasUnsavedChanges ? 'Saving...' : 'Saved' }}
        </div>
      </template>

      <template #sidebar>
        <div class="settings-sidebar-inner">
          <div
            class="settings-traffic-lights-space"
            aria-hidden="true"
          />

          <label class="settings-search">
            <Search class="search-icon" />
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              placeholder="Search settings"
              type="search"
            >
          </label>

          <AppMenu
            v-if="filteredNavItems.length > 0"
            class="sidebar-nav"
            :model-value="activeTab"
            :default-openeds="expandedNavMenuIndexes"
            :ellipsis="false"
            menu-trigger="click"
            @select="handleNavMenuSelect"
            @open="handleNavMenuOpen"
            @close="handleNavMenuClose"
          >
            <template
              v-for="item in filteredNavItems"
              :key="item.id"
            >
              <SubMenu
                v-if="item.sections.length > 1"
                :index="item.id"
                class="sidebar-entry"
                expand-icon-position="start"
                title-action="select"
              >
                <template #icon>
                  <component
                    :is="item.icon"
                    class="sidebar-icon"
                    aria-hidden="true"
                  />
                </template>
                <template #title>
                  <span class="sidebar-copy">
                    <span class="sidebar-label">{{ item.label }}</span>
                  </span>
                </template>

                <MenuItem
                  v-for="section in item.sections"
                  :key="section"
                  :index="navSectionIndex(item.id, section)"
                  :title="section"
                  item-as="button"
                  class="sidebar-subitem"
                />
              </SubMenu>
              <MenuItem
                v-else
                :index="item.id"
                item-as="button"
                class="sidebar-entry sidebar-entry-flat"
              >
                <template #icon>
                  <component
                    :is="item.icon"
                    class="sidebar-icon"
                    aria-hidden="true"
                  />
                </template>
                <span class="sidebar-copy">
                  <span class="sidebar-label">{{ item.label }}</span>
                </span>
              </MenuItem>
            </template>
          </AppMenu>
          <div
            v-else
            class="sidebar-empty"
          >
            No matching settings
          </div>
        </div>
      </template>

      <header class="content-header">
        <div class="content-topline">
          <div class="settings-scope">
            <span class="scope-badge">User</span>
            <span class="scope-name">onething</span>
          </div>
          <Button
            unstyled
            class="json-settings-button"
            native-type="button"
            @click="openSettingsJson"
          >
            Edit in settings.json
          </Button>
        </div>
        <div class="content-header-copy">
          <h1>{{ currentNavItem?.label }}</h1>
          <p class="content-hint">
            {{ currentNavItem?.hint }}
          </p>
        </div>
        <span
          v-if="hasUnsavedChanges || justSaved"
          class="save-state"
          :class="{ active: hasUnsavedChanges }"
        >
          {{ hasUnsavedChanges ? 'Saving…' : 'Saved' }}
        </span>
      </header>

      <div class="content-body">
        <div
          class="content-inner"
          :class="{ 'content-inner-wide': activeTab === 'providers' || activeTab === 'prompts' || activeTab === 'usage' }"
        >
          <template v-if="localSettings">
            <GeneralSettingsTab
              v-if="activeTab === 'general'"
              :settings="localSettings"
              @update:settings="handleSettingsUpdate"
            />

            <EditorSettingsTab
              v-else-if="activeTab === 'editor'"
              :settings="localSettings"
              @update:settings="handleSettingsUpdate"
            />

            <AIProviderTab
              v-else-if="activeTab === 'providers'"
              :settings="localSettings"
              :providers="allProviders"
              @update:settings="handleSettingsUpdate"
              @add-custom-provider="showCustomProviderDialog = true"
              @edit-custom-provider="editCustomProvider"
            />

            <UsageSettingsPanel v-else-if="activeTab === 'usage'" />

            <ToolsSettingsTab
              v-else-if="activeTab === 'tools'"
              :settings="localSettings"
              :tools="tools"
              @update:settings="handleSettingsUpdate"
            />

            <NetworkSettingsTab
              v-else-if="activeTab === 'network'"
              :settings="localSettings"
              @update:settings="handleSettingsUpdate"
            />

            <BrowserSettingsPanel v-else-if="activeTab === 'browser'" />

            <VoiceSettingsTab
              v-else-if="activeTab === 'voice'"
              :settings="localSettings"
              @update:settings="handleSettingsUpdate"
            />

            <MusicSettingsTab v-else-if="activeTab === 'music'" />

            <ChannelsSettingsTab
              v-else-if="activeTab === 'channels'"
              :settings="localSettings"
              @update:settings="handleSettingsUpdate"
            />

            <ShortcutsSettingsTab
              v-else-if="activeTab === 'shortcuts'"
              :settings="localSettings"
              @update:settings="handleSettingsUpdate"
            />

            <MCPSettingsPanel
              v-else-if="activeTab === 'mcp'"
              :settings="localSettings.mcp || { enabled: true, servers: [] }"
              @update:settings="handleMCPSettingsUpdate"
            />

            <SkillsSettingsPanel
              v-else-if="activeTab === 'skills'"
              :settings="localSettings.skills || { enableSkills: true, skills: {} }"
              @update:settings="handleSkillsSettingsUpdate"
            />

            <PromptsSettingsPanel
              v-else-if="activeTab === 'prompts'"
            />

            <PluginsSettingsTab
              v-else-if="activeTab === 'plugins'"
              @plugins-changed="loadTools"
            />

            <EvalsSettingsTab
              v-else-if="activeTab === 'evals'"
            />
          </template>
          <div
            v-else
            class="loading-content"
          >
            Loading...
          </div>
        </div>
      </div>
    </Container>

    <!-- Custom Provider Dialog -->
    <CustomProviderDialog
      :visible="showCustomProviderDialog"
      :is-editing="!!editingProvider"
      :initial-data="editingProvider || undefined"
      @close="closeCustomProviderDialog"
      @save="saveCustomProvider"
    />
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import Container from '@/components/common/Container.vue'
import AppMenu from '@/components/common/Menu.vue'
import Select from '@/components/common/Select.vue'
import MenuItem from '@/components/common/MenuItem.vue'
import SubMenu from '@/components/common/SubMenu.vue'
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import {
  Boxes,
  ChartColumn,
  Code2,
  MessageCircle,
  Globe2,
  AppWindow,
  Keyboard,
  Mic,
  Music,
  NotebookPen,
  Plug,
  Search,
  Server,
  Settings,
  Sparkles,
  Wrench,
} from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import { useSpacesStore } from '@/stores/spaces'
import { matchShortcut } from '@/composables/useShortcuts'
import type { AppSettings, ProviderInfo, CustomProviderConfig, ToolDefinition } from '@/types'
import { platformApi } from '@/platform'
import { toolsApi } from '@/platform/tools-client'

// Tab Components
import GeneralSettingsTab from './settings/GeneralSettingsTab.vue'
import EditorSettingsTab from './settings/EditorSettingsTab.vue'
import { AIProviderTab } from './settings/provider'
import ToolsSettingsTab from './settings/ToolsSettingsTab.vue'
import NetworkSettingsTab from './settings/NetworkSettingsTab.vue'
import BrowserSettingsPanel from './settings/BrowserSettingsPanel.vue'
import VoiceSettingsTab from './settings/VoiceSettingsTab.vue'
import MusicSettingsTab from './settings/MusicSettingsTab.vue'
import ChannelsSettingsTab from './settings/ChannelsSettingsTab.vue'
import ShortcutsSettingsTab from './settings/ShortcutsSettingsTab.vue'
import { MCPSettingsPanel } from './settings/mcp'
import { SkillsSettingsPanel } from './settings/skills'
import PluginsSettingsTab from './settings/PluginsSettingsTab.vue'
import PromptsSettingsPanel from './settings/PromptsSettingsPanel.vue'
import UsageSettingsPanel from './settings/UsageSettingsPanel.vue'
import EvalsSettingsTab from './settings/evals/EvalsSettingsTab.vue'

// Dialogs
import CustomProviderDialog, { type CustomProviderForm } from './settings/CustomProviderDialog.vue'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.settings-page')

const settingsStore = useSettingsStore()
const spacesStore = useSpacesStore()

/** 标题栏那个「当前空间」选择器的选项。设置窗是独立 window,列表自己拉一次。 */
const spaceOptions = computed(() =>
  spacesStore.spaces.map(space => ({ value: space.id, label: space.name })),
)

// State
const isLoading = ref(true)
const activeTab = ref('general')
const expandedNavItems = ref<Set<string>>(new Set())
const localSettings = ref<AppSettings | null>(null)
const originalSettings = ref<string>('')
const searchInputRef = ref<HTMLInputElement | null>(null)
const showCustomProviderDialog = ref(false)
const editingProvider = ref<CustomProviderConfig | null>(null)
const tools = ref<ToolDefinition[]>([])
const isInitialLoad = ref(true) // Prevent auto-save during initial load

// `sections` must mirror the h2/h3 headings the tab actually renders —
// scroll anchoring matches on heading text. Single-section tabs render as
// flat entries (no submenu), so their headings are not listed here; put
// searchable terms in `keywords` instead.
const navItems = [
  {
    id: 'general',
    label: 'General',
    hint: 'Appearance, themes, and typography',
    icon: Settings,
    sections: ['我的资料', 'Mode', 'Theme', 'Typography', 'Context Compact', 'Agent Turns', 'Fonts', 'Daily Notes', 'Todo / Plan'],
  },
  {
    id: 'editor',
    label: 'Editor',
    hint: 'Tabs and file preview limits',
    icon: Code2,
    sections: ['Tabs', 'Text Editor', 'File Preview'],
  },
  {
    id: 'providers',
    label: 'Providers',
    hint: 'Models, API keys, and defaults',
    icon: Boxes,
    sections: ['Models', 'Connections'],
  },
  {
    id: 'usage',
    label: 'Usage',
    hint: 'Token usage and cost across providers',
    icon: ChartColumn,
    sections: [],
    keywords: 'token usage cost spend billing',
  },
  {
    id: 'tools',
    label: 'Tools',
    hint: 'Built-in capabilities and search keys',
    icon: Wrench,
    sections: ['Tool Settings', 'Tool Call Model', 'Available Tools', 'Web Search', 'Connected Directories', 'Bash'],
  },
  {
    id: 'network',
    label: 'Network',
    hint: 'Proxy routing',
    icon: Globe2,
    sections: [],
    keywords: 'network proxy bypass',
  },
  {
    id: 'browser',
    label: 'Browser',
    hint: 'Isolated login profiles for the embedded browser',
    icon: AppWindow,
    sections: [],
    keywords: 'browser profile google login session partition cookies 配置',
  },
  {
    id: 'voice',
    label: 'Voice',
    hint: 'Mic input, transcription, and speech playback',
    icon: Mic,
    sections: [],
    keywords: 'voice input recording speech providers transcription tts asr wake word',
  },
  {
    id: 'music',
    label: 'Music',
    hint: 'NetEase Cloud Music setup for the music tool',
    icon: Music,
    sections: [],
    keywords: '网易云音乐 电台 播放器 credentials login radio',
  },
  {
    id: 'channels',
    label: 'Channels',
    hint: 'IM gateways and login state',
    icon: MessageCircle,
    sections: ['Channels', 'Profiles', 'Sessions'],
    keywords: 'wechat telegram gateway login',
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    hint: 'Keyboard bindings',
    icon: Keyboard,
    sections: [],
    keywords: 'keyboard shortcuts bindings',
  },
  {
    id: 'mcp',
    label: 'MCP Servers',
    hint: 'External context servers',
    icon: Server,
    sections: [],
    keywords: 'mcp servers context protocol',
  },
  {
    id: 'skills',
    label: 'Skills',
    hint: 'Reusable agent workflows',
    icon: Sparkles,
    sections: ['Directories', 'Skills'],
  },
  {
    id: 'prompts',
    label: 'Prompts',
    hint: 'Reusable prompt snippets',
    icon: NotebookPen,
    sections: [],
    keywords: 'prompt snippets templates',
  },
  {
    id: 'plugins',
    label: 'Plugins',
    hint: 'Installed extensions',
    icon: Plug,
    sections: [],
    keywords: 'plugins extensions install',
  },
  {
    id: 'evals',
    label: 'Evals',
    hint: 'Prompt evaluation: records, fixtures, runs, cases',
    icon: Sparkles,
    sections: [],
    keywords: 'records fixtures runs cases evaluation',
  },
]

const currentNavItem = computed(() => navItems.find(item => item.id === activeTab.value))
const searchQuery = ref('')
const filteredNavItems = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return navItems

  return navItems.filter(item =>
    `${item.label} ${item.hint} ${item.sections.join(' ')} ${'keywords' in item ? item.keywords : ''}`.toLowerCase().includes(query)
  )
})
const expandedNavMenuIndexes = computed(() => [...expandedNavItems.value])

function navSectionIndex(tabId: string, sectionLabel: string) {
  return `${tabId}::${sectionLabel}`
}

function parseNavMenuIndex(index: string) {
  const separatorIndex = index.indexOf('::')
  if (separatorIndex === -1) {
    return { tabId: index, sectionLabel: '' }
  }

  return {
    tabId: index.slice(0, separatorIndex),
    sectionLabel: index.slice(separatorIndex + 2),
  }
}

function isNavItemId(tabId: string) {
  return navItems.some(item => item.id === tabId)
}

// Providers list
const allProviders = computed<ProviderInfo[]>(() => {
  return settingsStore.availableProviders
})

// Check for unsaved changes
const hasUnsavedChanges = computed(() => {
  if (!localSettings.value) return false
  return JSON.stringify(localSettings.value) !== originalSettings.value
})

async function loadTools() {
  try {
    const toolsResponse = await toolsApi.getTools()
    if (toolsResponse.success && toolsResponse.tools) {
      tools.value = toolsResponse.tools
    }
  } catch (err) {
    log.error('tools load failed', {}, err)
  }
}

function refreshToolsWhenVisible() {
  if (activeTab.value !== 'tools') return
  void loadTools()
}

// Load settings
async function loadSettings() {
  try {
    await settingsStore.loadSettings()
    await settingsStore.loadProviders()

    localSettings.value = JSON.parse(JSON.stringify(settingsStore.settings))
    originalSettings.value = JSON.stringify(localSettings.value)

    loadTools()
  } catch (err) {
    log.error('settings load failed', {}, err)
  } finally {
    isLoading.value = false
    setTimeout(() => {
      isInitialLoad.value = false
    }, 100)
  }
}

// Handle settings update from child components
function handleSettingsUpdate(newSettings: AppSettings) {
  if (!newSettings) {
    log.warn('settings update received empty payload')
    return
  }
  localSettings.value = newSettings
}

// Handle MCP settings update
function handleMCPSettingsUpdate(mcpSettings: any) {
  if (!localSettings.value) return
  localSettings.value = {
    ...localSettings.value,
    mcp: mcpSettings
  }
}

// Handle Skills settings update
function handleSkillsSettingsUpdate(skillsSettings: any) {
  if (!localSettings.value) return
  localSettings.value = {
    ...localSettings.value,
    skills: skillsSettings
  }
}

async function selectNavItem(tabId: string) {
  activeTab.value = tabId
  if (tabId === 'tools') {
    void loadTools()
  }
  await nextTick()
  document.querySelector('.content-body')?.scrollTo({ top: 0, behavior: 'smooth' })
}

function setNavExpanded(tabId: string, expanded: boolean) {
  const next = new Set(expandedNavItems.value)
  if (expanded) {
    next.add(tabId)
  } else {
    next.delete(tabId)
  }
  expandedNavItems.value = next
}

function handleNavMenuSelect(index: string) {
  const { tabId, sectionLabel } = parseNavMenuIndex(index)
  if (!isNavItemId(tabId)) return

  if (sectionLabel) {
    void selectNavSection(tabId, sectionLabel)
    return
  }

  void selectNavItem(tabId)
}

// Expanding/collapsing a group is a sidebar-only gesture (the chevron) — it
// must not navigate; clicking the rest of the row selects the tab instead.
function handleNavMenuOpen(index: string) {
  if (!isNavItemId(index)) return
  setNavExpanded(index, true)
}

function handleNavMenuClose(index: string) {
  if (!isNavItemId(index)) return
  setNavExpanded(index, false)
}

async function selectNavSection(tabId: string, sectionLabel: string) {
  activeTab.value = tabId
  if (tabId === 'tools') {
    void loadTools()
  }
  setNavExpanded(tabId, true)
  await nextTick()

  const contentBody = document.querySelector('.content-body')
  if (!contentBody) return

  const normalize = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()
  const headings = Array.from(contentBody.querySelectorAll('h2, h3'))
  const heading = headings.find(element => normalize(element.textContent).startsWith(sectionLabel))

  if (!heading) {
    contentBody.scrollTo({ top: 0, behavior: 'smooth' })
    return
  }

  heading.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

// Auto-save when settings change (with debounce)
const justSaved = ref(false)
let saveTimeout: number | null = null
let savedBadgeTimeout: number | null = null
watch(localSettings, (newSettings) => {
  if (!newSettings) return
  if (isInitialLoad.value) return

  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = window.setTimeout(async () => {
    await settingsStore.saveSettings(newSettings)
    originalSettings.value = JSON.stringify(newSettings)
    justSaved.value = true
    if (savedBadgeTimeout) clearTimeout(savedBadgeTimeout)
    savedBadgeTimeout = window.setTimeout(() => {
      justSaved.value = false
    }, 1600)
  }, 500)
}, { deep: true })

watch(activeTab, (tabId) => {
  if (tabId === 'tools') {
    void loadTools()
  }
})

// Custom provider management
function editCustomProvider(providerId: string) {
  const provider = localSettings.value?.ai.customProviders?.find(p => p.id === providerId)
  if (provider) {
    editingProvider.value = provider
    showCustomProviderDialog.value = true
  }
}

function closeCustomProviderDialog() {
  showCustomProviderDialog.value = false
  editingProvider.value = null
}

function saveCustomProvider(form: CustomProviderForm) {
  if (!localSettings.value) return

  const provider: CustomProviderConfig = {
    id: editingProvider.value?.id || `custom-${Date.now()}`,
    name: form.name,
    description: form.description,
    apiType: form.apiType,
    baseUrl: form.baseUrl,
    apiKey: form.apiKey,
    model: form.model,
    selectedModels: editingProvider.value?.selectedModels
      ?? (form.model ? [form.model] : []),
    enabled: editingProvider.value?.enabled ?? true,
  }

  const providers = [...(localSettings.value.ai.customProviders ?? [])]
  const existingIndex = providers.findIndex(p => p.id === provider.id)

  if (existingIndex >= 0) {
    providers[existingIndex] = provider
  } else {
    providers.push(provider)
  }

  // Also write a matching entry into `ai.providers[id]` — that map is what
  // the composer's model picker and the settings
  // ProviderModels read for `selectedModels`/`enabled`. Skipping it would
  // leave the picker filtering the new provider out (modelCount === 0) and
  // the Models section blank, even after a restart.
  const existingConfig = localSettings.value.ai.providers?.[provider.id]
  const nextProviders = {
    ...(localSettings.value.ai.providers ?? {}),
    [provider.id]: {
      ...(existingConfig ?? {}),
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
      selectedModels:
        existingConfig?.selectedModels && existingConfig.selectedModels.length > 0
          ? existingConfig.selectedModels
          : provider.selectedModels,
      enabled: existingConfig?.enabled ?? provider.enabled ?? true,
    },
  }

  localSettings.value = {
    ...localSettings.value,
    ai: {
      ...localSettings.value.ai,
      customProviders: providers,
      providers: nextProviders,
    }
  }

  closeCustomProviderDialog()
}

// Handle keyboard shortcuts
function handleKeydown(e: KeyboardEvent) {
  const closeShortcut = localSettings.value?.general?.shortcuts?.closeChat
  const target = e.target as HTMLElement | null
  const isTypingTarget = target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target?.isContentEditable

  if (e.key === '/' && !isTypingTarget && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault()
    searchInputRef.value?.focus()
    return
  }

  if (e.key === 'Escape' || matchShortcut(e, closeShortcut)) {
    e.preventDefault()
    window.close()
  }
}

async function openSettingsJson() {
  try {
    const dataPath = await platformApi.getDataPath()
    const normalizedPath = dataPath.endsWith('/') ? dataPath.slice(0, -1) : dataPath
    const result = await platformApi.openPath(`${normalizedPath}/settings.json`)
    if (result) {
      log.warn('open settings.json reported an error', { result })
    }
  } catch (error) {
    log.error('open settings.json failed', {}, error)
  }
}

/**
 * Deep link: "去登录"-style entry points open settings pointed at a tab. A new
 * window carries it in the hash (#/settings?…&tab=music); an already-open
 * window gets a push on SETTINGS_NAVIGATE instead.
 */
function applyDeepLinkTab(tabId: string | null | undefined) {
  if (tabId && isNavItemId(tabId)) void selectNavItem(tabId)
}

let unsubscribeNavigate: (() => void) | null = null

onMounted(async () => {
  // 设置窗是独立 window:空间列表得自己拉一次,标题栏那块标识才知道该写谁的名字。
  void spacesStore.load()
  await loadSettings()
  applyDeepLinkTab(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('tab'))
  unsubscribeNavigate = platformApi.onSettingsNavigate?.(payload => applyDeepLinkTab(payload.tab)) ?? null
  window.addEventListener('focus', refreshToolsWhenVisible)
  document.addEventListener('visibilitychange', refreshToolsWhenVisible)
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  unsubscribeNavigate?.()
  window.removeEventListener('focus', refreshToolsWhenVisible)
  document.removeEventListener('visibilitychange', refreshToolsWhenVisible)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.settings-page {
  --settings-paper: var(--ui-surface-chat-bg);
  --settings-paper-2: var(--ui-sidebar-surface-bg, var(--ui-surface-sidebar-bg));
  --settings-paper-3: var(--ui-surface-panel-bg);
  --settings-rule: var(--ui-border-default-border);
  --settings-rule-soft: var(--ui-border-subtle-border);
  --settings-ink: var(--ui-text-primary-fg);
  --settings-ink-2: var(--ui-text-secondary-fg);
  --settings-ink-3: var(--ui-text-muted-fg);
  --settings-ink-4: var(--ui-text-faint-fg);
  --settings-ink-5: color-mix(in srgb, var(--ui-text-faint-fg) 66%, transparent);
  --settings-accent: var(--ui-accent-primary-fg);
  --settings-accent-soft: color-mix(in srgb, var(--ui-accent-primary-fg) 16%, transparent);
  --settings-accent-tint: color-mix(in srgb, var(--settings-accent) 12%, var(--settings-paper));
  --settings-shadow: 0 30px 80px -34px rgba(0, 0, 0, 0.42), 0 10px 28px -18px rgba(0, 0, 0, 0.28);

  height: 100vh;
  width: 100vw;
  display: flex;
  flex-direction: column;
  background: var(--settings-paper-2);
  color: var(--settings-ink);
  overflow: hidden;
  user-select: none;
  position: relative;
}

.settings-window {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: var(--settings-paper);
  box-shadow: none;
}

.titlebar-title {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--settings-ink-3);
  font-size: 12.5px;
  font-weight: 500;
  pointer-events: none;
}

/* 「当前空间」标识:`.titlebar-title` 是绝对定位铺满整条的(且 pointer-events:none),
   这一块作为它之后的兄弟节点用 position:relative 就画在它上面 —— 不需要 z-index
   (ui-gate 禁字面量层级),同一层叠上下文里后来者在上。 */
.titlebar-space {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding-right: 10px;
  -webkit-app-region: no-drag;
}

.titlebar-space-label {
  color: var(--settings-ink-3);
  font-size: 11.5px;
  white-space: nowrap;
}

.titlebar-space-select {
  min-width: 118px;
}

.settings-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 4px 12px;
  padding: 8px 10px;
  border: 1px solid var(--settings-rule);
  border-radius: 8px;
  background: var(--settings-paper);
  color: var(--settings-ink-3);
  -webkit-app-region: no-drag;
}

.search-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.settings-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--settings-ink);
  font: inherit;
  font-size: 13px;
}

.settings-search input::-webkit-search-cancel-button {
  display: none;
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  overflow-y: auto;
}

.sidebar-icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  color: var(--settings-ink-3);
}

.sidebar-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.sidebar-label {
  color: inherit;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.15;
}

.save-state {
  margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.content-body {
  flex: 1;
  overflow-y: auto;
  padding: 32px 40px 60px;
}

.content-inner {
  width: min(100%, 900px);
  margin: 0 auto;
}

.content-inner-wide {
  width: min(100%, 900px);
}

.content-body::-webkit-scrollbar {
  width: 10px;
}

.content-body::-webkit-scrollbar-track {
  background: transparent;
}

.content-body::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 10px;
  background: color-mix(in srgb, var(--settings-ink) 16%, transparent);
  background-clip: padding-box;
}

.content-body::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--settings-ink) 28%, transparent);
  background-clip: padding-box;
}

.loading-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--settings-ink-4);
  font-size: 13px;
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid color-mix(in srgb, var(--settings-ink-4) 24%, transparent);
  border-top-color: var(--settings-accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

:deep(.tab-content) {
  animation: settingsFade 160ms ease;
}

:deep(.settings-section),
:deep(.detail-section) {
  margin-bottom: 30px;
}

:deep(.section-title),
:deep(.section-label) {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 12px;
  color: var(--settings-ink-4);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 10.5px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

:deep(.section-title::after),
:deep(.section-label::after) {
  content: '';
  height: 1px;
  flex: 1;
  background: var(--settings-rule-soft);
}

:deep(.section-desc),
:deep(.form-hint) {
  color: var(--settings-ink-4);
}

:deep(.settings-card),
:deep(.settings-group) {
  border: 1px solid var(--settings-rule-soft);
  border-radius: 10px;
  background: color-mix(in srgb, var(--settings-paper-2) 44%, transparent);
  overflow: hidden;
}

:deep(.provider-tab-wrapper),
:deep(.provider-tab),
:deep(.provider-detail),
:deep(.detail-section),
:deep(.settings-group) {
  min-width: 0;
}

:deep(.content-inner-wide .provider-tab-wrapper) {
  width: min(1120px, 100%);
  max-width: 100%;
}

:deep(.provider-tab) {
  overflow: hidden;
}

:deep(.provider-list) {
  padding-left: 0;
}

:deep(.provider-detail) {
  overflow: hidden;
}

:deep(.provider-detail .row-input),
:deep(.provider-detail .row-select),
:deep(.default-model-section .row-select) {
  max-width: min(100%, 520px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.model-row) {
  min-width: 0;
}

:deep(.model-primary),
:deep(.model-secondary) {
  min-width: 0;
}

:deep(.model-capabilities) {
  min-width: 0;
  overflow: hidden;
}

:deep(.model-out-wrap) {
  max-width: none;
}

:deep(.card-row),
:deep(.settings-row),
:deep(.shortcut-row) {
  border-bottom-color: var(--settings-rule-soft);
}

:deep(.form-label),
:deep(.row-label),
:deep(.shortcut-name) {
  color: var(--settings-ink-2);
}

:deep(.theme-card.active),
:deep(.theme-item.active),
:deep(.font-option.active) {
  border-color: var(--settings-accent);
  box-shadow: 0 0 0 3px var(--settings-accent-soft);
}

/* Text-like controls (input/select/textarea) are all self-built components
   now — Input/Select draw their own focus state via the ledger variant.
   Only buttons keep this page-level baseline. */
:deep(button:focus-visible) {
  outline: 2px solid color-mix(in srgb, var(--settings-ink) 24%, transparent);
  outline-offset: 2px;
}

@keyframes settingsFade {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}

:deep(.settings-section),
:deep(.detail-section) {
  margin-bottom: 24px;
}

:deep(.card-row),
:deep(.settings-row),
:deep(.shortcut-row) {
  padding: 12px 14px;
}

:deep(.primary-action),
:deep(.secondary-btn),
:deep(.test-btn),
:deep(.save-action),
:deep(.prompt-primary-btn),
:deep(.prompt-secondary-btn),
:deep(.prompt-danger-btn) {
  min-height: 30px;
  border-radius: 7px;
  font-size: 12px;
}

/* IDE-style settings page refresh, inspired by compact desktop preferences. */
.settings-page {
  --settings-paper: var(--ui-surface-chat-bg);
  --settings-paper-2: var(--ui-sidebar-surface-bg, var(--ui-surface-sidebar-bg));
  --settings-paper-3: var(--ui-surface-panel-bg);
  --settings-rule: color-mix(in srgb, var(--ui-border-default-border) 82%, transparent);
  --settings-rule-soft: color-mix(in srgb, var(--ui-border-subtle-border) 66%, transparent);
  --settings-ink: var(--ui-text-primary-fg);
  --settings-ink-2: color-mix(in srgb, var(--ui-text-primary-fg) 90%, var(--ui-text-secondary-fg));
  --settings-ink-3: var(--ui-text-secondary-fg);
  --settings-ink-4: var(--ui-text-muted-fg);
  --settings-ink-5: color-mix(in srgb, var(--ui-text-muted-fg) 72%, transparent);
  --settings-accent-soft: color-mix(in srgb, var(--settings-accent) 16%, transparent);

  background: var(--settings-paper);
}

.settings-titlebar {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

/* Sidebar width is owned by the :sidebar-width Container prop (inline style
   beats any CSS var set here — do not try to size the sidebar from CSS). */
.settings-window {
  background: var(--settings-paper);
}

.settings-window :deep(.settings-titlebar) {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  -webkit-app-region: drag;
}

.settings-window :deep(.settings-layout) {
  height: 100vh;
  min-height: 0;
}

.settings-window :deep(.settings-sidebar) {
  width: 214px;
  padding: 0 10px 14px;
  border-right: 1px solid var(--settings-rule);
  background: var(--settings-paper-2);
  -webkit-app-region: drag;
}

.settings-sidebar-inner {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.settings-traffic-lights-space {
  flex: 0 0 38px;
  -webkit-app-region: drag;
}

.settings-search,
.sidebar-nav {
  -webkit-app-region: no-drag;
}

/* Ledger search: a single underline carries the field. */
.settings-search {
  height: 31px;
  margin: 0 0 16px;
  padding: 0 2px;
  border: 0;
  border-bottom: 1px solid var(--settings-rule);
  border-radius: 0;
  background: transparent;
  color: var(--settings-ink-4);
  box-shadow: none;
}

.settings-search input {
  height: 100%;
  font-size: 13.5px;
  line-height: 1;
}

.settings-search:focus-within {
  border-bottom-color: var(--settings-accent);
  background: transparent;
  box-shadow: none;
}

.settings-search input:focus,
.settings-search input:focus-visible {
  outline: none;
  box-shadow: none;
}

.search-icon {
  width: 15px;
  height: 15px;
}

.sidebar-nav {
  --app-menu-bg: transparent;
  --app-menu-border: transparent;
  --app-menu-width: 100%;
  --app-menu-padding: 0;
  --app-menu-item-height: 30px;
  --app-menu-item-radius: 0;
  --app-menu-item-gap: 8px;
  --app-menu-indent-step: 0px;
  --app-menu-item-fg: var(--settings-ink-4);
  --app-menu-item-hover-bg: transparent;
  --app-menu-item-hover-fg: var(--settings-ink-2);
  --app-menu-active-bg: transparent;
  --app-menu-active-fg: var(--settings-ink);

  /* Bleed through the sidebar's 10px right padding so the scrollbar
     hugs the sidebar edge; padding-right keeps items at their inset. */
  gap: 0;
  width: calc(100% + 10px);
  margin-right: -10px;
  padding-right: 18px;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.sidebar-entry {
  display: flex;
  flex-direction: column;
}

.sidebar-entry :deep(.app-sub-menu-title) {
  gap: 8px;
  min-height: 30px;
  padding: 5px 8px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--settings-ink-4);
  font: inherit;
  font-size: 14px;
  outline: none;
  text-align: left;
  transition: box-shadow var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.sidebar-entry :deep(.app-sub-menu-title:hover) {
  background: transparent;
  color: var(--settings-ink-2);
  box-shadow: inset 2px 0 0 var(--settings-rule);
}

.sidebar-entry :deep(.app-sub-menu-title:focus-visible) {
  outline: 2px solid color-mix(in srgb, var(--settings-ink) 24%, transparent);
  outline-offset: 2px;
  box-shadow: none;
}

/* Active nav entry: state lives in the left ink line, not a fill. */
.sidebar-entry.is-active :deep(.app-sub-menu-title) {
  border-color: transparent;
  background: transparent;
  color: var(--settings-ink);
  box-shadow: inset 2px 0 0 var(--settings-accent);
}

/* Disclosure is always visible and is its own click target: the chevron
   expands/collapses, the rest of the row switches tabs. */
.sidebar-entry :deep(.app-sub-menu-chevron-hit) {
  width: 20px;
  height: 20px;
  margin: -2px;
  flex-shrink: 0;
}

.sidebar-entry :deep(.app-sub-menu-chevron) {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: currentColor;
  opacity: 0.45;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.sidebar-entry :deep(.app-sub-menu-chevron-hit:hover .app-sub-menu-chevron),
.sidebar-entry.is-opened :deep(.app-sub-menu-chevron),
.sidebar-entry.is-active :deep(.app-sub-menu-chevron) {
  opacity: 0.85;
}

.sidebar-entry :deep(.app-sub-menu-icon) {
  width: 16px;
  height: 16px;
  color: currentColor;
}

.sidebar-entry :deep(.app-sub-menu-label) {
  display: flex;
  min-width: 0;
  flex: 1;
  text-align: left;
}

/* Flat entries (tabs without sub-sections) mirror the sub-menu title look,
   minus the disclosure chevron. The start padding aligns their icons with
   sub-menu icons (which sit after the reserved chevron slot); !important is
   required because MenuItem writes padding-inline-start as an inline style. */
.sidebar-entry-flat :deep(.app-menu-item) {
  gap: 8px;
  min-height: 30px;
  padding: 5px 8px;
  padding-inline-start: 36px !important;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--settings-ink-4);
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  outline: none;
  text-align: left;
  justify-content: flex-start;
  transition: box-shadow var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.sidebar-entry-flat :deep(.app-menu-item:hover) {
  background: transparent;
  color: var(--settings-ink-2);
  box-shadow: inset 2px 0 0 var(--settings-rule);
}

.sidebar-entry-flat :deep(.app-menu-item:focus-visible) {
  outline: 2px solid color-mix(in srgb, var(--settings-ink) 24%, transparent);
  outline-offset: 2px;
  box-shadow: none;
}

.sidebar-entry-flat.is-active :deep(.app-menu-item) {
  background: transparent;
  color: var(--settings-ink);
  box-shadow: inset 2px 0 0 var(--settings-accent);
}

.sidebar-entry-flat :deep(.app-menu-item-icon) {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: currentColor;
}

.sidebar-entry-flat :deep(.app-menu-item-label) {
  display: flex;
  min-width: 0;
  flex: 1;
  text-align: left;
}

.sidebar-icon {
  display: block;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: currentColor;
}

.sidebar-copy {
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
}

.sidebar-label {
  font-size: 14px;
  font-weight: 560;
  line-height: 1.25;
}

.sidebar-entry :deep(.app-sub-menu-panel) {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 2px 0 6px 14px;
  padding: 1px 0 1px 14px;
}

.sidebar-entry :deep(.app-sub-menu-panel::before) {
  content: '';
  position: absolute;
  left: 5px;
  top: 1px;
  bottom: 1px;
  width: 1px;
  background: var(--settings-rule-soft);
}

.sidebar-subitem {
  width: 100%;
}

.sidebar-subitem :deep(.app-menu-item) {
  min-height: 25px;
  height: 25px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--settings-ink-4);
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.2;
  text-align: left;
}

.sidebar-subitem :deep(.app-menu-item:hover),
.sidebar-subitem :deep(.app-menu-item:focus-visible) {
  background: transparent;
  color: var(--settings-ink-2);
  box-shadow: none;
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--settings-rule);
}

.sidebar-subitem :deep(.app-menu-item-label) {
  min-width: 0;
  text-align: left;
}

.sidebar-empty {
  padding: 10px 8px;
  color: var(--settings-ink-4);
  font-size: 12.5px;
}

.settings-window :deep(.settings-content) {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--settings-paper);
}

.content-header {
  display: block;
  position: relative;
  padding: 23px 30px 14px;
  border-bottom: 0;
  background: var(--settings-paper);
  -webkit-app-region: drag;
}

.content-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 26px;
}

.settings-scope {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 12px;
  color: var(--settings-ink);
}

/* Scope badge: outlined ring, zero fill. */
.scope-badge {
  display: inline-flex;
  align-items: center;
  min-height: 23px;
  padding: 0 9px;
  border: 1px solid color-mix(in srgb, var(--settings-accent) 55%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--settings-accent);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}

.scope-name {
  overflow: hidden;
  font-size: 16px;
  font-weight: 650;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Developer escape hatch, not a page-level action: quiet text link. */
.json-settings-button {
  min-height: 28px;
  flex-shrink: 0;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--settings-ink-4);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.json-settings-button:hover {
  background: color-mix(in srgb, var(--settings-paper-3) 92%, var(--settings-accent-soft));
  color: var(--settings-ink);
}

.content-header-copy {
  min-width: 0;
}

.content-header h1 {
  margin: 0;
  color: var(--settings-ink);
  font-size: 22px;
  font-weight: 620;
  letter-spacing: 0;
  line-height: 1.2;
}

.content-hint {
  display: none;
}

.save-state {
  display: inline-flex;
  position: absolute;
  right: 30px;
  bottom: 16px;
  margin: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--settings-ink-4);
}

.save-state.active {
  color: var(--settings-accent);
}

.content-body {
  padding: 0 30px 60px;
  background: var(--settings-paper);
}

.content-inner,
.content-inner-wide {
  width: 100%;
  max-width: 930px;
  margin: 0;
}

.content-inner-wide {
  max-width: 1120px;
}

:deep(.tab-content) {
  animation: settingsFade 140ms ease;
}

:deep(.settings-section),
:deep(.detail-section) {
  margin-bottom: 38px;
}

:deep(.settings-section-header) {
  align-items: center;
  padding: 0 0 10px;
  border-bottom: 1px solid var(--settings-rule);
}

/* Group headers are UI chrome, not data: system sans, small caps rhythm.
   Mono stays reserved for values, paths, and save-state metadata. */
:deep(.settings-section-title),
:deep(.section-label),
:deep(.section-title) {
  margin: 0;
  color: var(--settings-ink-4);
  font-family: var(--font-body, inherit);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  line-height: 1.35;
  text-transform: uppercase;
}

:deep(.section-label::after),
:deep(.section-title::after) {
  background: var(--settings-rule);
}

:deep(.settings-section-description) {
  display: none;
}

:deep(.settings-group),
:deep(.settings-card) {
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  overflow: visible;
}

:deep(.settings-card.theme-cards) {
  display: grid;
  gap: 12px;
}

:deep(.theme-card) {
  border-color: var(--settings-rule);
  border-radius: 0;
  background: transparent;
}

:deep(.theme-card.active) {
  border-color: var(--settings-accent);
  box-shadow: inset 0 -2px 0 var(--settings-accent);
}

:deep(.setting-row),
:deep(.card-row),
:deep(.settings-row),
:deep(.shortcut-row) {
  min-height: 68px;
  padding: 17px 0;
  border-bottom: 1px solid var(--settings-rule-soft);
  background: transparent;
}

:deep(.setting-row:last-child),
:deep(.card-row:last-child),
:deep(.settings-row:last-child),
:deep(.shortcut-row:last-child) {
  border-bottom: 1px solid var(--settings-rule-soft);
}

:deep(.setting-row-title),
:deep(.toggle-title),
:deep(.row-label),
:deep(.shortcut-name),
:deep(.form-label),
:deep(.settings-field-label) {
  color: var(--settings-ink-2);
  font-size: 14.5px;
  font-weight: 560;
  letter-spacing: 0;
  line-height: 1.35;
}

:deep(.setting-row-description),
:deep(.toggle-desc),
:deep(.form-hint),
:deep(.settings-field-hint),
:deep(.shortcut-desc) {
  max-width: 620px;
  margin-top: 4px;
  color: var(--settings-ink-4);
  font-size: 12.5px;
  line-height: 1.45;
}

:deep(.setting-row-split) {
  gap: 5px;
}

:deep(.setting-row-control) {
  display: flex;
  align-items: center;
  width: 100%;
}

:deep(.setting-row-split > .setting-row-head > .setting-row-control),
:deep(.setting-row-no-copy > .setting-row-control) {
  justify-content: flex-end;
}

:deep(.setting-row-stack > .setting-row-control) {
  justify-content: flex-start;
}

/* Boxed fields are no longer drawn here: every text/select control in the
   tabs is a self-built <Input variant="ledger"> / <Select variant="ledger">,
   and the ledger variant owns the square hairline frame + accent focus
   (components/common/Input.vue, Select.vue). */

/* Segmented controls drawn once here so tabs without local styles
   still get a visible active state. */
:deep(.segmented-control) {
  display: inline-flex;
  border: 1px solid var(--settings-rule);
  border-radius: 0;
  background: transparent;
}

:deep(.segment-btn) {
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 5px 14px;
  color: var(--settings-ink-3);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default), box-shadow var(--duration-fast) var(--ease-default);
}

:deep(.segment-btn + .segment-btn) {
  border-left: 1px solid var(--settings-rule-soft);
}

:deep(.segment-btn:hover) {
  background: transparent;
  color: var(--settings-ink);
}

:deep(.segment-btn.active) {
  background: transparent;
  color: var(--settings-ink);
  box-shadow: inset 0 -2px 0 var(--settings-accent);
}

:deep(.segment-btn),
:deep(.secondary-btn),
:deep(.test-btn),
:deep(.save-action),
:deep(.primary-action),
:deep(.prompt-primary-btn),
:deep(.prompt-secondary-btn),
:deep(.prompt-danger-btn) {
  border-radius: 0;
  font-size: 13px;
}

:deep(.secondary-btn),
:deep(.test-btn),
:deep(.prompt-secondary-btn) {
  border: 1px solid var(--settings-rule);
  background: transparent;
  color: var(--settings-ink-2);
}

:deep(.secondary-btn:hover),
:deep(.test-btn:hover),
:deep(.prompt-secondary-btn:hover) {
  border-color: var(--settings-ink-3);
  background: transparent;
  color: var(--settings-ink);
}

/* Primary actions: accent line + accent ink, never a filled block. */
:deep(.primary-action),
:deep(.save-action),
:deep(.prompt-primary-btn) {
  border: 1px solid var(--settings-accent);
  background: transparent;
  color: var(--settings-accent);
}

:deep(.primary-action:hover:not(:disabled)),
:deep(.save-action:hover:not(:disabled)),
:deep(.prompt-primary-btn:hover:not(:disabled)) {
  background: transparent;
  box-shadow: inset 0 -2px 0 var(--settings-accent);
  color: var(--settings-accent);
}

:deep(.prompt-danger-btn) {
  border: 1px solid var(--ui-status-danger-fg);
  background: transparent;
  color: var(--ui-status-danger-fg);
}

/*
 * ── 墓碑:settings 墨线 toggle 共享皮肤(P3 收敛,已删)────────────────
 *
 * 这里曾有 ~150 行 `:deep()`,把「虚线轨 + 空心环 / 实线轨 + 实心墨点」的
 * 墨线开关画给全页两种 markup 方言:原生 checkbox(`.toggle-row` /
 * `.native-toggle`)和 span 版(`.toggle > input + .toggle-slider`)。
 *
 * 现在这个开关是 `<Switch variant="ledger">`(components/common/Switch.vue),
 * 由组件自己画。settings 各 tab 的 36 + 32 处控件已全部迁完(A 路 tab 群、
 * B 路 mcp/evals/agents/scheduler 群),此块零消费者,故整块删除。
 *
 * 这四个类名不许复活:`.toggle` / `.toggle-slider` / `.native-toggle`、以及
 * 任何 `.toggle-row input[type="checkbox"]` 形状的选择器。原因不是洁癖 ——
 * 它们是「隔着 :deep() 远程给别人的 DOM 上漆」的原型,开关的观感因此散落在
 * 使用方与定义方之间,谁都改不动也测不到。要开关就用 `<Switch>`;要新形态就
 * 去 Switch 里加 variant,不要在这里重开一张皮。
 *
 * (`.toggle-row` 作为**纯布局**类名仍在 BashSettingsPanel / MCPSettingsPanel
 * 使用 —— 那是各自 scoped 里本地定义的一行 flex,与本块无关,不受此禁令约束。)
 *
 * 参见 docs/design/ui-system.md §1;删除前全库 grep 证据:除本文件外无引用。
 */

:deep(.provider-rows) {
  border: 0;
  border-radius: 0;
  background: transparent;
}

:deep(.provider-row) {
  min-height: 62px;
  padding: 14px 0;
  border-top-color: var(--settings-rule-soft);
}

:deep(.provider-row:hover) {
  background: transparent;
  box-shadow: inset 2px 0 0 var(--settings-rule);
}

:deep(.provider-row.active) {
  background: transparent;
  box-shadow: inset 2px 0 0 var(--settings-accent);
}

:deep(.provider-configure),
:deep(.provider-row-edit),
:deep(.provider-pill) {
  border-radius: 0;
}

:deep(.provider-icon-tile) {
  border-radius: 0;
  background: transparent;
}

:deep(.detail-title) {
  font-size: 20px;
  font-weight: 620;
}

:deep(.content-inner-wide .provider-tab-wrapper) {
  width: 100%;
}

/* .shortcut-input 是唯一剩下的裸控件:带 tabindex 的 div,录快捷键必须在鼠标
   点击时也亮起(理由写在 components/settings/ShortcutInput.vue)。文本类控件
   已全部迁到 <Input variant="ledger"> / <Select variant="ledger">,聚焦态由
   组件自绘。 */
.settings-page :deep(.shortcut-input:focus),
.settings-page :deep(.shortcut-input:focus-visible) {
  outline: none;
  border-color: var(--settings-accent);
  box-shadow: none;
}

.settings-page :deep(.settings-search:focus-within),
.settings-page :deep(.app-input-number:focus-within),
.settings-page :deep(.model-out-wrap:focus-within) {
  border-color: var(--settings-accent);
  box-shadow: none;
}

/* Five-digit values (12000, 15000) were clipped in the stepper input. */
.settings-page :deep(.app-input-number-input) {
  min-width: 76px;
}

.settings-page :deep(.segment-btn:focus-visible),
.settings-page :deep(.tristate-btn:focus-visible),
.settings-page :deep(.model-check:focus-visible),
.settings-page :deep(.model-caps-edit:focus-visible) {
  outline: 2px solid color-mix(in srgb, var(--settings-ink) 24%, transparent);
  outline-offset: 2px;
}

@media (max-width: 860px) {
  .settings-window :deep(.settings-sidebar) {
    padding: 0 8px 12px;
  }

  .content-header {
    padding: 23px 24px 14px;
  }

  .content-topline {
    margin-bottom: 24px;
  }

  .content-body {
    padding: 0 24px 54px;
  }

  .scope-name {
    max-width: 190px;
  }
}

@media (max-width: 720px) {
  .json-settings-button {
    display: none;
  }
}
</style>

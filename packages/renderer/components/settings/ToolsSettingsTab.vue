<template>
  <div class="tab-content">
    <!-- Enable Tool Calls -->
    <SettingsSection
      title="Tool Settings"
      description="Control which built-in capabilities the assistant may use during conversations."
    >
      <SettingsGroup>
        <SettingRow
          label="Enable Tool Calls"
          description="Allow AI to use tools during conversations."
        >
          <Switch
            variant="ledger"
            :model-value="settings.tools.enableToolCalls"
            aria-label="Enable Tool Calls"
            @update:model-value="updateEnableToolCalls(Boolean($event))"
          />
        </SettingRow>

        <SettingRow
          label="Permission Mode"
          description="Control when tool calls ask for confirmation. Normal asks before edits and non-read-only commands; Auto Accept Edits runs file edits automatically; Dangerously Allow All runs tools without confirmation."
        >
          <Select
            v-bind="LEDGER_SELECT"
            class="mode-select"
            :model-value="settings.tools.permissionMode || 'normal'"
            :options="PERMISSION_MODE_OPTIONS"
            :disabled="!settings.tools.enableToolCalls"
            aria-label="Permission Mode"
            @update:model-value="updatePermissionMode(String($event) as PermissionMode)"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection
      title="Tool Call Model"
      description="Choose the already-configured provider and model used for lightweight AI utility calls, including automatic chat naming."
    >
      <SettingsGroup>
        <SettingRow
          label="Tool Call Provider"
          description="Only providers with selected models are shown."
        >
          <Select
            v-bind="LEDGER_SELECT"
            class="model-setting-select"
            :model-value="selectedToolCallProvider"
            :options="providerOptions"
            :disabled="configuredProviders.length === 0"
            aria-label="Tool Call Provider"
            @update:model-value="updateToolCallProvider(String($event))"
          />
        </SettingRow>

        <SettingRow
          label="Model"
          :description="toolCallModelHint"
        >
          <Select
            v-bind="LEDGER_SELECT"
            class="model-setting-select"
            :model-value="selectedToolCallModel"
            :options="modelOptions"
            :disabled="selectedToolCallModels.length === 0"
            aria-label="Tool Call Model"
            @update:model-value="updateToolCallModel(String($event))"
          />
        </SettingRow>

        <SettingRow
          label="Think Mode"
          description="Independent from the chat Think control. Disabled by default for fast utility calls."
        >
          <Switch
            variant="ledger"
            :model-value="toolCallThinkingEnabled"
            :disabled="!selectedToolCallModel"
            aria-label="Tool call think mode"
            @update:model-value="updateToolCallThinking(Boolean($event))"
          />
        </SettingRow>

        <SettingRow
          label="Thinking Effort"
          description="Used only when Tool Call Think Mode is enabled."
        >
          <Select
            v-bind="LEDGER_SELECT"
            class="model-setting-select"
            :model-value="selectedToolCallThinkingEffort"
            :options="thinkingEffortSelectOptions"
            :disabled="!toolCallThinkingEnabled || !selectedToolCallModel"
            aria-label="Thinking Effort"
            @update:model-value="updateToolCallThinkingEffort(String($event) as ThinkingEffort)"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <!-- Available Tools -->
    <SettingsSection
      v-if="settings.tools.enableToolCalls"
      title="Available Tools"
    >
      <SettingsEmptyState
        v-if="displayTools.length === 0"
        title="No tools available"
        description="Built-in tools will appear here when the main process exposes them."
      />

      <SettingsGroup
        v-else
        class="tools-list"
      >
        <SettingRow
          v-for="tool in displayTools"
          :key="tool.id"
          class="tool-item"
        >
          <template #label>
            <span class="tool-name">{{ tool.name }}</span>
            <span :class="['tool-category', tool.category]">{{ tool.category }}</span>
          </template>
          <div class="tool-controls">
            <Switch
              variant="ledger"
              size="mini"
              :model-value="getToolEnabled(tool.id)"
              :aria-label="`Enable ${tool.name}`"
              @update:model-value="setToolEnabled(tool.id, Boolean($event))"
            />
          </div>
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <!-- Web Search Settings -->
    <SettingsSection
      v-if="settings.tools.enableToolCalls && hasWebSearchTool"
      title="Web Search"
      description="Configure credentials for external search tools."
    >
      <SettingsGroup>
        <SettingRow
          label="Brave Search API Key"
          description="Get your free API key at brave.com/search/api (2,000 queries/month free)."
        >
          <Input
            variant="ledger"
            type="password"
            :model-value="settings.tools.webSearch?.braveApiKey || ''"
            placeholder="Enter your Brave Search API key"
            @update:model-value="updateBraveApiKey($event)"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <!-- Connected Directories -->
    <ConnectedDirectoriesPanel
      :settings="settings"
      @update:settings="$emit('update:settings', $event)"
    />

    <!-- Bash Tool Settings -->
    <BashSettingsPanel
      v-if="settings.tools.enableToolCalls && hasBashTool"
      :settings="settings"
      @update:settings="$emit('update:settings', $event)"
    />

    <BackgroundJobsPanel v-if="settings.tools.enableToolCalls && hasBashTool" />
  </div>
</template>

<script setup lang="ts">
import Select from '@/components/common/Select.vue'
import Input from '@/components/common/Input.vue'
import Switch from '@/components/common/Switch.vue'
import { computed } from 'vue'
import type { SelectOptionLike } from '@/components/common/select'
import type { AppSettings, ToolDefinition } from '@/types'
import type { ThinkingEffort } from '@shared/ipc/providers'
import type { PermissionMode, WebSearchSettings } from '@shared/ipc/tools'
import { useSettingsStore } from '@/stores/settings'
import { isProviderEnabledIn } from '@/stores/helpers/provider-model'
import BashSettingsPanel from './BashSettingsPanel.vue'
import BackgroundJobsPanel from './BackgroundJobsPanel.vue'
import ConnectedDirectoriesPanel from './ConnectedDirectoriesPanel.vue'
import {
  SettingRow,
  SettingsEmptyState,
  SettingsGroup,
  SettingsSection,
} from './settings-primitives'

const props = defineProps<{
  settings: AppSettings
  tools: ToolDefinition[]
}>()

const emit = defineEmits<{
  'update:settings': [settings: AppSettings]
}>()

const settingsStore = useSettingsStore()
/** 批 B9:provider 开关的空间覆盖(default 空间恒 undefined)。 */

/** Settings-area dropdown spelling; teleported because the tab body scrolls. */
const LEDGER_SELECT = {
  variant: 'ledger',
  size: 'small',
  teleported: true,
  fitInputWidth: true,
} as const

const PERMISSION_MODE_OPTIONS: SelectOptionLike[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'auto-accept-edits', label: 'Auto Accept Edits' },
  { value: 'dangerously-allow-all', label: 'Dangerously Allow All' },
]

const thinkingEffortOptions: Array<{ value: ThinkingEffort; label: string }> = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X High' },
  { value: 'max', label: 'Max' },
]

const thinkingEffortSelectOptions: SelectOptionLike[] = [...thinkingEffortOptions]

const displayTools = computed(() => {
  return props.tools
})

const configuredProviders = computed(() => {
  return settingsStore.availableProviders.filter(provider => {
    // 批 B9:开关 per-space —— 第三参是空间覆盖(default 空间恒 undefined,
    // 那一支逐字不变);家族派生仍在 `isProviderEnabledIn` 内部一处。
    return isProviderEnabledIn(props.settings.ai.providers, provider.id)
      && getProviderModelIds(provider.id).length > 0
  })
})

const selectedToolCallProvider = computed(() => {
  const configured = props.settings.tools.toolCallModel?.providerId
  if (configured && configuredProviders.value.some(provider => provider.id === configured)) {
    return configured
  }

  const defaultProvider = props.settings.ai.provider
  if (configuredProviders.value.some(provider => provider.id === defaultProvider)) {
    return defaultProvider
  }

  return configuredProviders.value[0]?.id || ''
})

const selectedToolCallModels = computed(() => {
  return getProviderModelIds(selectedToolCallProvider.value)
})

/* The empty-state entries were `<option value="">` rows before; keeping them as
   real options (rather than a placeholder) preserves what the closed control
   reads when nothing is configured. */
const providerOptions = computed<SelectOptionLike[]>(() => (
  configuredProviders.value.length === 0
    ? [{ value: '', label: 'No configured providers' }]
    : configuredProviders.value.map(provider => ({ value: provider.id, label: provider.name }))
))

const modelOptions = computed<SelectOptionLike[]>(() => (
  selectedToolCallModels.value.length === 0
    ? [{ value: '', label: 'No selected models' }]
    : selectedToolCallModels.value.map(model => ({ value: model, label: getModelName(model) }))
))

const selectedToolCallModel = computed(() => {
  const configured = props.settings.tools.toolCallModel?.model
  if (configured && selectedToolCallModels.value.includes(configured)) {
    return configured
  }

  const providerConfig = props.settings.ai.providers[selectedToolCallProvider.value]
  if (providerConfig?.model && selectedToolCallModels.value.includes(providerConfig.model)) {
    return providerConfig.model
  }

  return selectedToolCallModels.value[0] || ''
})

const toolCallModelHint = computed(() => {
  if (!selectedToolCallProvider.value) return 'Select models in Providers before choosing a tool call model.'
  if (selectedToolCallModels.value.length === 0) return 'This provider has no selected models.'
  return 'Used asynchronously for chat naming, memory background tasks, and Memory Dreaming.'
})

const toolCallThinkingEnabled = computed(() => {
  return props.settings.tools.toolCallModel?.thinking === true
})

const selectedToolCallThinkingEffort = computed<ThinkingEffort>(() => {
  const effort = props.settings.tools.toolCallModel?.thinkingEffort
  return normalizeThinkingEffort(effort) ?? 'medium'
})

// Check if bash tool is available
const hasBashTool = computed(() => {
  return props.tools.some(tool => tool.id === 'bash')
})

// Check if web search tool is available
const hasWebSearchTool = computed(() => {
  return props.tools.some(tool => tool.id === 'web_search')
})

function updateEnableToolCalls(enabled: boolean) {
  emit('update:settings', {
    ...props.settings,
    tools: { ...props.settings.tools, enableToolCalls: enabled }
  })
}

function updatePermissionMode(permissionMode: PermissionMode) {
  emit('update:settings', {
    ...props.settings,
    tools: { ...props.settings.tools, permissionMode }
  })
}

function getProviderModelIds(providerId: string): string[] {
  if (!providerId) return []
  const config = props.settings.ai.providers[providerId]
  if (!config) return []
  if (config.selectedModels?.length) return config.selectedModels
  return config.model ? [config.model] : []
}

function getModelName(modelId: string): string {
  return settingsStore.getModelDisplayName(modelId) || modelId
}

function normalizeThinkingEffort(value: unknown): ThinkingEffort | null {
  return thinkingEffortOptions.some(option => option.value === value)
    ? value as ThinkingEffort
    : null
}

function updateToolCallProvider(providerId: string) {
  const modelIds = getProviderModelIds(providerId)
  const providerConfig = props.settings.ai.providers[providerId]
  const model = providerConfig?.model && modelIds.includes(providerConfig.model)
    ? providerConfig.model
    : modelIds[0] || ''

  emit('update:settings', {
    ...props.settings,
    tools: {
      ...props.settings.tools,
      toolCallModel: {
        ...props.settings.tools.toolCallModel,
        providerId,
        model,
      },
    },
  })
}

function updateToolCallModel(model: string) {
  emit('update:settings', {
    ...props.settings,
    tools: {
      ...props.settings.tools,
      toolCallModel: {
        ...props.settings.tools.toolCallModel,
        providerId: selectedToolCallProvider.value,
        model,
      },
    },
  })
}

function updateToolCallThinking(thinking: boolean) {
  emit('update:settings', {
    ...props.settings,
    tools: {
      ...props.settings.tools,
      toolCallModel: {
        ...props.settings.tools.toolCallModel,
        providerId: selectedToolCallProvider.value,
        model: selectedToolCallModel.value,
        thinking,
        thinkingEffort: selectedToolCallThinkingEffort.value,
      },
    },
  })
}

function updateToolCallThinkingEffort(thinkingEffort: ThinkingEffort) {
  emit('update:settings', {
    ...props.settings,
    tools: {
      ...props.settings.tools,
      toolCallModel: {
        ...props.settings.tools.toolCallModel,
        providerId: selectedToolCallProvider.value,
        model: selectedToolCallModel.value,
        thinkingEffort,
      },
    },
  })
}

function getToolEnabled(toolId: string): boolean {
  const tool = props.tools.find(item => item.id === toolId)
  return props.settings.tools.tools[toolId]?.enabled ?? tool?.enabled ?? true
}

function setToolEnabled(toolId: string, enabled: boolean) {
  const tools = { ...props.settings.tools.tools }
  tools[toolId] = { ...tools[toolId], enabled }
  emit('update:settings', {
    ...props.settings,
    tools: { ...props.settings.tools, tools }
  })
}

function updateBraveApiKey(apiKey: string) {
  const webSearch: WebSearchSettings = {
    enabled: props.settings.tools.webSearch?.enabled ?? true,
    ...props.settings.tools.webSearch,
    braveApiKey: apiKey.trim() || undefined
  }
  emit('update:settings', {
    ...props.settings,
    tools: { ...props.settings.tools, webSearch }
  })
}
</script>

<style scoped>
/*
 * Tools tab — ledger 画线风.
 * Inputs and rows are drawn by the SettingsPage :deep() layer; the toggles are
 * `<Switch variant="ledger">` and the dropdowns `<Select variant="ledger">`,
 * both self-drawn. Only layout and the category ring live here.
 */
.tab-content {
  animation: fadeIn 0.15s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* Tools list rows: name + outlined category ring on the left, toggle right. */
.tool-name {
  min-width: 0;
  overflow-wrap: break-word;
  font-size: 13px;
  font-weight: 500;
  color: var(--settings-ink-2, var(--ui-text-primary-fg));
}

/* Badge as a stroked ring: transparent fill, accent line + accent ink. */
.tool-category {
  margin-left: 8px;
  font-size: 10px;
  line-height: 1;
  padding: 2px 7px 3px;
  border: 1px solid color-mix(in srgb, var(--settings-accent, var(--ui-accent-primary-fg)) 65%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--settings-accent, var(--ui-accent-primary-fg));
  white-space: nowrap;
  vertical-align: 1px;
}

.tool-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* Inputs are `<Input variant="ledger">` — the variant owns the paint. */
/* Layout-only classes on the Select roots — the paint is the variant's. */
.mode-select {
  max-width: 220px;
  min-width: 0;
}

.model-setting-select {
  max-width: min(360px, 100%);
  min-width: 0;
}
</style>

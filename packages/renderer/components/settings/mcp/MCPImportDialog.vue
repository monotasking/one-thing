<template>
  <Dialog
    :open="show"
    variant="paper"
    title="Import MCP Servers"
    :width="600"
    :style="importDialogVars"
    @update:open="value => { if (!value) $emit('close') }"
  >
    <template #header-extra>
      <button
        type="button"
        class="close-btn"
        @click="$emit('close')"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </template>

    <div class="import-content">
      <!-- Tab selector -->
      <div class="import-tabs">
        <Button
          unstyled
          :class="['import-tab', { active: activeTab === 'file' }]"
          @click="switchTab('file')"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" />
            <polyline points="13 2 13 9 20 9" />
          </svg>
          From File
        </Button>
        <Button
          unstyled
          :class="['import-tab', { active: activeTab === 'paste' }]"
          @click="switchTab('paste')"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
            <rect
              x="8"
              y="2"
              width="8"
              height="4"
              rx="1"
              ry="1"
            />
          </svg>
          Quick Paste
        </Button>
        <Button
          unstyled
          :class="['import-tab', { active: activeTab === 'presets' }]"
          @click="switchTab('presets')"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
          Presets
        </Button>
      </div>

      <!-- File Import Tab -->
      <div
        v-if="activeTab === 'file'"
        class="import-tab-content"
      >
        <p class="import-description">
          Import MCP configurations from a JSON file. Supports Claude Desktop format.
        </p>
        <Button
          unstyled
          class="select-file-btn"
          @click="selectImportFile"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          Select JSON File
        </Button>
        <div
          v-if="fileInfo"
          class="file-info"
        >
          <span class="file-name">{{ fileInfo.name }}</span>
          <span class="server-count">{{ fileInfo.serverCount }} server(s) found</span>
        </div>
      </div>

      <!-- Quick Paste Tab -->
      <div
        v-if="activeTab === 'paste'"
        class="import-tab-content"
      >
        <p class="import-description">
          Paste a JSON configuration or command line to add a server.
        </p>
        <Input
          v-model="pasteContent"
          type="textarea"
          variant="ledger"
          class="paste-textarea"
          placeholder="Paste JSON config or command line:

{&quot;command&quot;: &quot;npx&quot;, &quot;args&quot;: [&quot;-y&quot;, &quot;@modelcontextprotocol/server-filesystem&quot;, &quot;/path&quot;]}

or:

npx -y @modelcontextprotocol/server-filesystem /path"
          :rows="6"
          @input="parsePasteContent"
        />
        <div
          v-if="pasteResult"
          class="parse-result"
        >
          <div
            v-if="pasteResult.success"
            class="parse-success"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>{{ pasteResult.type }}</span>
          </div>
          <div
            v-else
            class="parse-error"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
              />
              <line
                x1="12"
                y1="8"
                x2="12"
                y2="12"
              />
              <line
                x1="12"
                y1="16"
                x2="12.01"
                y2="16"
              />
            </svg>
            <span>{{ pasteResult.error }}</span>
          </div>
        </div>
      </div>

      <!-- Presets Tab -->
      <div
        v-if="activeTab === 'presets'"
        class="import-tab-content"
      >
        <p class="import-description">
          Choose from popular MCP servers to quickly get started.
        </p>

        <!-- Category filter -->
        <div class="preset-categories">
          <Button
            v-for="cat in presetCategories"
            :key="cat.id"
            unstyled
            :class="['category-btn', { active: selectedCategory === cat.id }]"
            @click="selectedCategory = cat.id"
          >
            {{ cat.name }}
          </Button>
        </div>

        <!-- Presets grid -->
        <div class="presets-grid">
          <div
            v-for="preset in filteredPresets"
            :key="preset.id"
            :class="['preset-card', { selected: selectedPreset?.id === preset.id }]"
            @click="selectPreset(preset)"
          >
            <div class="preset-icon">
              <component :is="getPresetIcon(preset.icon)" />
            </div>
            <div class="preset-info">
              <span class="preset-name">{{ preset.name }}</span>
              <span class="preset-desc">{{ preset.description }}</span>
            </div>
            <svg
              v-if="selectedPreset?.id === preset.id"
              class="check-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        </div>

        <!-- Parameter configuration -->
        <div
          v-if="selectedPreset && selectedPreset.parameters && selectedPreset.parameters.length > 0"
          class="preset-params"
        >
          <h4>Configuration</h4>
          <div
            v-for="param in selectedPreset.parameters"
            :key="param.key"
            class="form-group"
          >
            <label class="form-label">
              {{ param.name }}
              <span
                v-if="param.required"
                class="required"
              >*</span>
            </label>
            <div
              v-if="param.type === 'path'"
              class="path-input-group"
            >
              <Input
                v-model="presetParams[param.key]"
                variant="underline"
                :placeholder="param.placeholder"
                @input="updatePresetServer"
              />
              <Button
                unstyled
                class="browse-btn"
                @click="browseForPath(param.key)"
              >
                Browse
              </Button>
            </div>
            <Input
              v-else
              v-model="presetParams[param.key]"
              variant="underline"
              :type="param.isEnvVar ? 'password' : 'text'"
              :placeholder="param.placeholder"
              @input="updatePresetServer"
            />
          </div>
        </div>
      </div>

      <!-- Preview of servers to import -->
      <div
        v-if="serversToImport.length > 0"
        class="import-preview"
      >
        <h4>Servers to Import ({{ serversToImport.length }})</h4>
        <div class="preview-list">
          <div
            v-for="(server, index) in serversToImport"
            :key="index"
            :class="['preview-item', { selected: selectedServers.has(index) }]"
            @click="toggleServerSelection(index)"
          >
            <Checkbox
              class="preview-check"
              :model-value="selectedServers.has(index)"
              :aria-label="`Import ${server.name}`"
              @click.stop
              @update:model-value="toggleServerSelection(index)"
            />
            <div class="preview-info">
              <span class="preview-name">{{ server.name }}</span>
              <span class="preview-command">{{ getServerSummary(server) }}</span>
            </div>
          </div>
        </div>
      </div>

      <ErrorNote
        v-if="error"
        class="error-message"
        :message="error"
      />
    </div>

    <template #actions>
      <button
        type="button"
        class="app-dialog-text-btn"
        @click="$emit('close')"
      >
        Cancel
      </button>
      <button
        type="button"
        class="app-dialog-text-btn is-primary"
        :disabled="selectedServers.size === 0 || isImporting"
        @click="handleImport"
      >
        {{ isImporting ? 'Importing...' : `Import ${selectedServers.size} Server(s)` }}
      </button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import Checkbox from '@/components/common/Checkbox.vue'
import Dialog from '@/components/common/Dialog.vue'
import ErrorNote from '@/components/common/ErrorNote.vue'
import Input from '@/components/common/Input.vue'
import { ref, computed, watch, h, type CSSProperties } from 'vue'
import type { MCPServerConfig } from '@/types'
import { MCP_PRESETS, PRESET_CATEGORIES, type MCPPreset, type PresetCategory } from '@/data/mcpPresets'
import { v4 as uuidv4 } from 'uuid'
import { parseConfigFile, parseCommandLine, getServerSummary } from './useMCPServers'
import { mcpApi } from '@/platform/mcp-client'
import { dialogApi } from '@/platform/dialog-client'

/**
 * The body is not a form but a tab pane that scrolls internally, so it takes
 * over the whole panel height instead of getting Dialog's padded block.
 */
const importDialogVars: CSSProperties = {
  '--app-dialog-body-display': 'flex',
  '--app-dialog-body-padding': '0',
  '--app-dialog-body-overflow': 'hidden',
} as CSSProperties

interface Props {
  show: boolean
}

interface Emits {
  (e: 'close'): void
  (e: 'import', servers: MCPServerConfig[], selectedIndexes: Set<number>): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

// Tab state
const activeTab = ref<'file' | 'paste' | 'presets'>('file')

// File tab state
const fileInfo = ref<{ name: string; serverCount: number } | null>(null)

// Paste tab state
const pasteContent = ref('')
const pasteResult = ref<{ success: boolean; type?: string; error?: string } | null>(null)

// Presets tab state
const selectedCategory = ref<PresetCategory>('all')
const selectedPreset = ref<MCPPreset | null>(null)
const presetParams = ref<Record<string, string>>({})
const presetCategories = PRESET_CATEGORIES

// Shared state
const serversToImport = ref<MCPServerConfig[]>([])
const selectedServers = ref<Set<number>>(new Set())
const error = ref('')
const isImporting = ref(false)

// Computed
const filteredPresets = computed(() => {
  if (selectedCategory.value === 'all') {
    return MCP_PRESETS
  }
  return MCP_PRESETS.filter(p => p.category === selectedCategory.value)
})

// Reset when dialog opens
watch(() => props.show, (show) => {
  if (show) {
    activeTab.value = 'file'
    error.value = ''
    serversToImport.value = []
    selectedServers.value = new Set()
    fileInfo.value = null
    pasteContent.value = ''
    pasteResult.value = null
    selectedPreset.value = null
    presetParams.value = {}
  }
})

function switchTab(tab: 'file' | 'paste' | 'presets') {
  activeTab.value = tab
  serversToImport.value = []
  selectedServers.value = new Set()
  error.value = ''
  if (tab === 'file') {
    fileInfo.value = null
  } else if (tab === 'paste') {
    pasteContent.value = ''
    pasteResult.value = null
  } else {
    selectedPreset.value = null
    presetParams.value = {}
  }
}

// File import
async function selectImportFile() {
  try {
    const result = await dialogApi.showOpen({
      title: 'Select MCP Configuration File',
      properties: ['openFile'],
    })

    if (result.canceled || result.filePaths.length === 0) return

    const filePath = result.filePaths[0]
    const response = await mcpApi.readConfigFile({ filePath })

    if (!response.success) {
      error.value = response.error || 'Failed to read file'
      return
    }

    const servers = parseConfigFile(response.content)
    serversToImport.value = servers
    selectedServers.value = new Set(servers.map((_, i) => i))
    fileInfo.value = {
      name: filePath.split('/').pop() || 'config.json',
      serverCount: servers.length,
    }
    error.value = ''
  } catch (err: any) {
    error.value = err.message || 'Failed to select file'
  }
}

// Paste parsing
function parsePasteContent() {
  const content = pasteContent.value.trim()
  if (!content) {
    pasteResult.value = null
    serversToImport.value = []
    selectedServers.value = new Set()
    return
  }

  try {
    if (content.startsWith('{') || content.startsWith('[')) {
      const parsed = JSON.parse(content)
      const servers = parseConfigFile(parsed)
      serversToImport.value = servers
      selectedServers.value = new Set(servers.map((_, i) => i))
      pasteResult.value = {
        success: true,
        type: `JSON configuration (${servers.length} server${servers.length > 1 ? 's' : ''})`,
      }
      return
    }

    const server = parseCommandLine(content)
    if (server) {
      serversToImport.value = [server]
      selectedServers.value = new Set([0])
      pasteResult.value = {
        success: true,
        type: `Command line: ${server.command}`,
      }
      return
    }

    throw new Error('Could not parse as JSON or command line')
  } catch (err: any) {
    pasteResult.value = { success: false, error: err.message }
    serversToImport.value = []
    selectedServers.value = new Set()
  }
}

// Preset handling
function selectPreset(preset: MCPPreset) {
  selectedPreset.value = preset
  presetParams.value = {}

  if (preset.parameters) {
    for (const param of preset.parameters) {
      if (param.default) {
        presetParams.value[param.key] = param.default
      }
    }
  }

  updatePresetServer()
}

function updatePresetServer() {
  if (!selectedPreset.value) return

  const preset = selectedPreset.value
  let args = preset.config.args ? [...preset.config.args] : []

  args = args.map(arg => {
    const match = arg.match(/\{(\w+)\}/)
    if (match) {
      const key = match[1]
      return presetParams.value[key] || arg
    }
    return arg
  })

  const env: Record<string, string> = {}
  if (preset.parameters) {
    for (const param of preset.parameters) {
      if (param.isEnvVar && presetParams.value[param.key]) {
        env[param.key] = presetParams.value[param.key]
      }
    }
  }

  const server: MCPServerConfig = {
    id: uuidv4(),
    name: preset.name,
    transport: preset.config.transport,
    enabled: true,
  }

  if (preset.config.command) server.command = preset.config.command
  if (args.length > 0) server.args = args
  if (preset.config.url) server.url = preset.config.url
  if (Object.keys(env).length > 0) server.env = env

  serversToImport.value = [server]
  selectedServers.value = new Set([0])
}

async function browseForPath(paramKey: string) {
  const result = await dialogApi.showOpen({
    title: 'Select Path',
    properties: ['openDirectory'],
  })

  if (!result.canceled && result.filePaths.length > 0) {
    presetParams.value[paramKey] = result.filePaths[0]
    updatePresetServer()
  }
}

function toggleServerSelection(index: number) {
  if (selectedServers.value.has(index)) {
    selectedServers.value.delete(index)
  } else {
    selectedServers.value.add(index)
  }
  selectedServers.value = new Set(selectedServers.value)
}

function handleImport() {
  emit('import', serversToImport.value, selectedServers.value)
}

// Preset icons helper
function getPresetIcon(iconName: string) {
  const icons: Record<string, () => any> = {
    folder: () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, [
      h('path', { d: 'M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z' })
    ]),
    github: () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, [
      h('path', { d: 'M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22' })
    ]),
    globe: () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, [
      h('circle', { cx: 12, cy: 12, r: 10 }),
      h('line', { x1: 2, y1: 12, x2: 22, y2: 12 }),
      h('path', { d: 'M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z' })
    ]),
    database: () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, [
      h('ellipse', { cx: 12, cy: 5, rx: 9, ry: 3 }),
      h('path', { d: 'M21 12c0 1.66-4 3-9 3s-9-1.34-9-3' }),
      h('path', { d: 'M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5' })
    ]),
    search: () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, [
      h('circle', { cx: 11, cy: 11, r: 8 }),
      h('line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 })
    ]),
    download: () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, [
      h('path', { d: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4' }),
      h('polyline', { points: '7 10 12 15 17 10' }),
      h('line', { x1: 12, y1: 15, x2: 12, y2: 3 })
    ]),
    brain: () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, [
      h('path', { d: 'M12 2a4 4 0 014 4c0 1.1-.9 2-2 2h-4a2 2 0 01-2-2 4 4 0 014-4z' }),
      h('path', { d: 'M20 12c0 4.4-3.6 8-8 8s-8-3.6-8-8 3.6-8 8-8' }),
      h('circle', { cx: 12, cy: 12, r: 3 })
    ]),
    lightbulb: () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, [
      h('path', { d: 'M9 18h6' }),
      h('path', { d: 'M10 22h4' }),
      h('path', { d: 'M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8 6 6 0 006 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 018.91 14' })
    ]),
    star: () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, [
      h('polygon', { points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2' })
    ]),
  }
  return icons[iconName] || icons.star
}

// Expose for parent
defineExpose({
  setError: (msg: string) => { error.value = msg },
  setLoading: (loading: boolean) => { isImporting.value = loading },
})
</script>

<style scoped>
/*
 * Import dialog — paper in the ledger language: hairline structure, hard ink
 * shadow, mono metadata, no fills. The shell is `Dialog variant="paper"` since
 * P2; only the tab pane's own styling lives here.
 */
.close-btn {
  border: none;
  background: transparent;
  padding: 2px;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color var(--duration-fast) var(--ease-default);
}

.close-btn:hover {
  color: var(--ui-text-primary-fg);
}

.import-content {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex: 1;
  min-height: 0;
}

/* Tabs: text row over a hairline; the active tab is underlined in accent */
.import-tabs {
  display: flex;
  gap: 18px;
  padding: 12px 18px;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-border-subtle-border) 55%, transparent);
  background: transparent;
  flex-shrink: 0;
}

.import-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: none;
  background: transparent;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default);
}

.import-tab:hover {
  color: var(--ui-text-primary-fg);
}

.import-tab.active {
  color: var(--ui-text-primary-fg);
  text-decoration: underline;
  text-underline-offset: 4px;
  text-decoration-color: var(--ui-accent-primary-fg);
}

.import-tab-content {
  padding: 16px 18px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.import-description {
  font-size: 12px;
  color: var(--ui-text-muted-fg);
  margin: 0 0 14px 0;
  line-height: 1.5;
}

/* File drop area: dashed frame, no fill */
.select-file-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  padding: 22px;
  border: 1px dashed var(--ui-border-default-border);
  background: transparent;
  font-size: 13px;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.select-file-btn:hover {
  border-color: var(--ui-accent-primary-fg);
  color: var(--ui-accent-primary-fg);
}

.file-info {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding: 8px 0 8px 10px;
  margin-top: 12px;
  border-left: 1px solid color-mix(in srgb, var(--ui-border-strong-border) 55%, transparent);
}

.file-name {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--ui-text-primary-fg);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-count {
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--ui-accent-primary-fg);
  flex-shrink: 0;
}

/* JSON paste area: mono behind a square hairline — the box is
   `<Input type="textarea" variant="ledger">`, the mono face lives here. */
.paste-textarea :deep(.app-input-textarea) {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.5;
}

.parse-result {
  margin-top: 10px;
}

/* Parse feedback: colored ink held by a left rule */
.parse-success,
.parse-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 2px 0 2px 8px;
  font-size: 12px;
  min-width: 0;
}

.parse-success svg,
.parse-error svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.parse-success span,
.parse-error span {
  min-width: 0;
  word-break: break-word;
}

.parse-success {
  border-left: 2px solid var(--ui-status-success-fg);
  color: var(--ui-status-success-fg);
}

.parse-error {
  border-left: 2px solid var(--ui-status-danger-fg);
  color: var(--ui-status-danger-fg);
}

/* Category filter: mono text actions, active underlined in accent */
.preset-categories {
  display: flex;
  gap: 14px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.category-btn {
  padding: 0;
  border: none;
  background: transparent;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default);
}

.category-btn:hover {
  color: var(--ui-text-primary-fg);
}

.category-btn.active {
  color: var(--ui-accent-primary-fg);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--ui-accent-primary-fg);
}

.presets-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  max-height: 280px;
  overflow-y: auto;
  padding-right: 4px;
}

/* Preset cards: square outline, selection lives in the border */
.preset-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 28px 12px 12px;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--ui-border-default-border) 70%, transparent);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-default);
  position: relative;
  min-width: 0;
}

.preset-card:hover {
  border-color: var(--ui-border-strong-border);
}

.preset-card.selected {
  border-color: var(--ui-accent-primary-fg);
}

.preset-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--ui-text-muted-fg);
  flex-shrink: 0;
  padding-top: 1px;
}

.preset-card.selected .preset-icon {
  color: var(--ui-accent-primary-fg);
}

.preset-info {
  flex: 1;
  min-width: 0;
}

.preset-name {
  display: block;
  font-size: 13px;
  font-weight: var(--font-weight-medium, 500);
  color: var(--ui-text-primary-fg);
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preset-desc {
  display: block;
  font-size: 11px;
  color: var(--ui-text-muted-fg);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.check-icon {
  position: absolute;
  top: 10px;
  right: 10px;
  color: var(--ui-accent-primary-fg);
}

.preset-params {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid color-mix(in srgb, var(--ui-border-subtle-border) 55%, transparent);
}

.preset-params h4 {
  font-size: 11px;
  font-weight: var(--font-weight-semibold, 600);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ui-text-muted-fg);
  margin: 0 0 12px 0;
}

.form-group {
  margin-bottom: 14px;
}

/* Explicit last-child reset. Without it the scoped `.form-group` ties with the
   global `.form-group:last-child { margin-bottom: 0 }` at (0,2,0) and the
   trailing gap depends on stylesheet order. */
.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ui-text-muted-fg);
  margin-bottom: 5px;
}

/* Underline inputs: the line is the control, drawn by `<Input variant="underline">`. */
.path-input-group {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.path-input-group :deep(.app-input) {
  flex: 1;
  min-width: 0;
}

.browse-btn {
  padding: 0;
  border: none;
  background: transparent;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  flex-shrink: 0;
  transition: color var(--duration-fast) var(--ease-default);
}

.browse-btn:hover {
  color: var(--ui-text-primary-fg);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--ui-accent-primary-fg);
}

/* Qualified by its parent so it out-specifies the global `.form-label .required`
   instead of tying with it. */
.form-label .required {
  color: var(--ui-status-danger-fg, var(--danger));
}

.import-preview {
  padding: 14px 18px;
  border-top: 1px solid color-mix(in srgb, var(--ui-border-subtle-border) 55%, transparent);
  flex-shrink: 0;
}

.import-preview h4 {
  font-size: 11px;
  font-weight: var(--font-weight-semibold, 600);
  color: var(--ui-text-muted-fg);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0 0 8px 0;
}

/* Preview: ledger rows quoted by a left ink rule */
.preview-list {
  display: flex;
  flex-direction: column;
  max-height: 150px;
  overflow-y: auto;
  border-left: 1px solid color-mix(in srgb, var(--ui-border-strong-border) 55%, transparent);
}

.preview-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0 6px 10px;
  background: transparent;
  border-top: 1px solid color-mix(in srgb, var(--ui-border-subtle-border) 24%, transparent);
  cursor: pointer;
  min-width: 0;
}

.preview-item:first-child {
  border-top: none;
}

.preview-item:hover .preview-name {
  color: var(--ui-accent-primary-fg);
}

.preview-item.selected {
  box-shadow: inset 2px 0 0 var(--ui-accent-primary-fg);
}

/* Layout only — the mark itself is drawn by Checkbox.vue (P3). */
.preview-check {
  flex-shrink: 0;
}

.preview-info {
  flex: 1;
  min-width: 0;
}

.preview-name {
  display: block;
  font-size: 13px;
  color: var(--ui-text-primary-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--duration-fast) var(--ease-default);
}

.preview-command {
  display: block;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* positioning only — visuals come from ErrorNote */
.error-message {
  margin: 12px 18px;
  flex-shrink: 0;
}

/* Footer buttons are `.app-dialog-text-btn` (published by Dialog.vue's
   non-scoped block). They used to be a scoped `.btn` here, which tied with the
   global `.btn.primary` / `.btn.secondary` at (0,2,0) and was decided by
   stylesheet order — P2 reshuffled that order and the tie flipped to a solid
   accent block with accent text on it. */




</style>

<template>
  <div class="system-prompt-panel">
    <div
      v-if="error"
      class="system-prompt-state error"
    >
      <AlertCircle
        :size="15"
        aria-hidden="true"
      />
      <span>{{ error }}</span>
    </div>

    <div
      v-else-if="loading && !snapshot"
      class="system-prompt-state"
    >
      Loading...
    </div>

    <div
      v-else-if="snapshot"
      class="system-prompt-scroll"
    >
      <div class="system-prompt-meta-grid">
        <button
          type="button"
          class="system-prompt-meta-item"
          :class="{ active: activeSection === 'prompt' }"
          @click="activeSection = 'prompt'"
        >
          <span>Prompt</span>
          <i
            class="system-prompt-meta-leader"
            aria-hidden="true"
          />
          <strong>{{ formattedChars }}</strong>
        </button>
        <button
          type="button"
          class="system-prompt-meta-item"
          :class="{ active: activeSection === 'tools' }"
          @click="activeSection = 'tools'"
        >
          <span>Tools</span>
          <i
            class="system-prompt-meta-leader"
            aria-hidden="true"
          />
          <strong :class="{ muted: !snapshot.tools.hasTools }">{{ toolsStatus }}</strong>
        </button>
        <button
          type="button"
          class="system-prompt-meta-item"
          :class="{ active: activeSection === 'runtime' }"
          @click="activeSection = 'runtime'"
        >
          <span>Runtime</span>
          <i
            class="system-prompt-meta-leader"
            aria-hidden="true"
          />
          <strong :class="{ muted: !snapshot.agentLoopStream.active }">{{ runtimeStatus }}</strong>
        </button>
        <button
          type="button"
          class="system-prompt-meta-item"
          :class="{ active: activeSection === 'skills' }"
          @click="activeSection = 'skills'"
        >
          <span>Skills</span>
          <i
            class="system-prompt-meta-leader"
            aria-hidden="true"
          />
          <strong :class="{ muted: !snapshot.skills.includedInPrompt }">{{ skillsStatus }}</strong>
        </button>
        <button
          type="button"
          class="system-prompt-meta-item"
          :class="{ active: activeSection === 'agent' }"
          @click="activeSection = 'agent'"
        >
          <span>Agent</span>
          <i
            class="system-prompt-meta-leader"
            aria-hidden="true"
          />
          <strong>{{ snapshot.agentName || 'Default Agent' }}</strong>
        </button>
      </div>

      <!-- Only actionable problems get a banner. An unsupported agent-loop
           route is not an error (the session falls back to the basic stream)
           and is already reported by the Runtime row. -->
      <div
        v-if="!snapshot.credentialsReady"
        class="system-prompt-warning"
      >
        {{ providerWarning }}
      </div>

      <section
        v-if="activeSection === 'tools'"
        class="system-prompt-group system-prompt-detail"
      >
        <div class="system-prompt-group-head">
          <span>Tools</span>
          <span>{{ snapshot.tools.modelFacingCount }}/{{ snapshot.tools.configuredCount }}</span>
        </div>
        <div
          v-if="toolItems.length"
          class="system-prompt-collapse-list"
        >
          <CollapsePanel
            v-for="tool in toolItems"
            :key="tool.key"
            class="system-prompt-collapse-panel"
            :name="`system-tool:${tool.key}`"
            default-collapsed
            variant="plain"
            content-variant="plain"
            expand-icon-position="inline-end"
            expand-icon-display="hover"
          >
            <template #title>
              <div class="system-prompt-detail-title">
                <span
                  class="system-prompt-detail-name"
                  :class="{ inactive: !snapshot.tools.hasTools }"
                >{{ tool.name }}</span>
                <span
                  v-if="getToolSubtitle(tool)"
                  class="system-prompt-detail-subtitle"
                >{{ getToolSubtitle(tool) }}</span>
              </div>
            </template>

            <div class="system-prompt-detail-body">
              <p
                v-if="tool.description"
                class="system-prompt-description"
              >
                {{ tool.description }}
              </p>

              <dl class="system-prompt-detail-list">
                <div
                  v-for="row in getToolDetailRows(tool)"
                  :key="row.label"
                >
                  <dt>{{ row.label }}</dt>
                  <dd :class="{ mono: row.mono }">
                    {{ row.value }}
                  </dd>
                </div>
              </dl>

              <div
                v-if="tool.parameters.length"
                class="system-prompt-subgroup"
              >
                <div class="system-prompt-subhead">
                  Parameters
                </div>
                <ul class="system-prompt-param-list">
                  <li
                    v-for="param in tool.parameters"
                    :key="param.name"
                  >
                    <div class="system-prompt-param-head">
                      <span class="system-prompt-param-name">{{ param.name }}</span>
                      <span class="system-prompt-param-type">{{ formatParameterMeta(param) }}</span>
                    </div>
                    <p
                      v-if="param.description"
                      class="system-prompt-param-desc"
                    >
                      {{ param.description }}
                    </p>
                  </li>
                </ul>
              </div>
            </div>
          </CollapsePanel>
        </div>
        <p
          v-else
          class="system-prompt-empty"
        >
          No tools loaded
        </p>
      </section>

      <section
        v-else-if="activeSection === 'runtime'"
        class="system-prompt-group system-prompt-detail"
      >
        <div class="system-prompt-group-head">
          <span>Runtime</span>
          <span>{{ runtimeStatus }}</span>
        </div>
        <dl class="system-prompt-info-list">
          <div>
            <dt>Agent loop stream</dt>
            <dd>{{ snapshot.agentLoopStream.enabled ? 'On' : 'Off' }}</dd>
          </div>
          <div>
            <dt>Enabled by</dt>
            <dd>{{ formatToken(snapshot.agentLoopStream.enabledBy) }}</dd>
          </div>
          <div>
            <dt>Provider runtime</dt>
            <dd>{{ snapshot.agentLoopStream.providerSupported ? 'Supported' : 'Unsupported' }}</dd>
          </div>
          <div>
            <dt>Active route</dt>
            <dd>{{ snapshot.agentLoopStream.active ? 'Agent loop' : 'Unavailable' }}</dd>
          </div>
          <div>
            <dt>Supported providers</dt>
            <dd>{{ compactList(snapshot.agentLoopStream.supportedProviderIds) || 'None' }}</dd>
          </div>
        </dl>
      </section>

      <section
        v-else-if="activeSection === 'skills'"
        class="system-prompt-group system-prompt-detail"
      >
        <div class="system-prompt-group-head">
          <span>Skills</span>
          <span>{{ snapshot.skills.count }}</span>
        </div>
        <div
          v-if="snapshot.skills.items.length"
          class="system-prompt-collapse-list"
        >
          <CollapsePanel
            v-for="skill in snapshot.skills.items"
            :key="skill.id"
            class="system-prompt-collapse-panel"
            :name="`system-skill:${skill.id}`"
            default-collapsed
            variant="plain"
            content-variant="plain"
            expand-icon-position="inline-end"
            expand-icon-display="hover"
          >
            <template #title>
              <div class="system-prompt-detail-title">
                <span
                  class="system-prompt-detail-name"
                  :class="{ inactive: !snapshot.skills.includedInPrompt }"
                >{{ skill.name }}</span>
                <span
                  v-if="getSkillSubtitle(skill)"
                  class="system-prompt-detail-subtitle"
                >{{ getSkillSubtitle(skill) }}</span>
              </div>
            </template>

            <div class="system-prompt-detail-body">
              <p
                v-if="skill.description"
                class="system-prompt-description"
              >
                {{ skill.description }}
              </p>

              <div
                v-if="skill.tags?.length"
                class="system-prompt-chip-list compact"
              >
                <span
                  v-for="tag in skill.tags"
                  :key="tag"
                  class="system-prompt-chip"
                >
                  {{ tag }}
                </span>
              </div>

              <dl class="system-prompt-detail-list">
                <div
                  v-for="row in getSkillDetailRows(skill)"
                  :key="row.label"
                >
                  <dt>{{ row.label }}</dt>
                  <dd :class="{ mono: row.mono }">
                    {{ row.value }}
                  </dd>
                </div>
              </dl>

              <div
                v-if="skill.files?.length"
                class="system-prompt-subgroup"
              >
                <div class="system-prompt-subhead">
                  Files
                </div>
                <ul class="system-prompt-file-list">
                  <li
                    v-for="file in skill.files"
                    :key="file.path || file.name"
                  >
                    <span class="system-prompt-file-name">{{ file.name }}</span>
                    <span class="system-prompt-file-type">{{ file.type }}</span>
                  </li>
                </ul>
              </div>
            </div>
          </CollapsePanel>
        </div>
        <p
          v-else
          class="system-prompt-empty"
        >
          No skills loaded
        </p>
      </section>

      <section
        v-else-if="activeSection === 'agent'"
        class="system-prompt-group system-prompt-detail"
      >
        <div class="system-prompt-group-head">
          <span>Agent</span>
          <span>{{ snapshot.agentId || 'default' }}</span>
        </div>
        <dl class="system-prompt-info-list">
          <div>
            <dt>Name</dt>
            <dd>{{ snapshot.agentName || 'Default Agent' }}</dd>
          </div>
          <div>
            <dt>Workdir</dt>
            <dd>{{ snapshot.workingDirectory || 'None' }}</dd>
          </div>
        </dl>
      </section>

      <section
        v-else
        class="system-prompt-group system-prompt-detail system-prompt-prompt-section"
      >
        <div class="system-prompt-group-head">
          <span>Prompt</span>
          <Tooltip text="Copy system prompt">
            <button
              type="button"
              class="system-prompt-copy-button"
              :class="{ copied }"
              aria-label="Copy system prompt"
              :disabled="!snapshot.systemPrompt"
              @click="copyPrompt"
            >
              <Check
                v-if="copied"
                :size="14"
                aria-hidden="true"
              />
              <Copy
                v-else
                :size="14"
                aria-hidden="true"
              />
            </button>
          </Tooltip>
        </div>
        <pre class="system-prompt-text">{{ snapshot.systemPrompt }}</pre>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { AlertCircle, Check, Copy } from 'lucide-vue-next'
import type {
  SystemPromptSkillSnapshot,
  SystemPromptSnapshot,
  SystemPromptToolSnapshot,
  ToolParameter,
} from '@/types'
import { useSessionsStore } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { copyTextToClipboard } from '@/utils/clipboard'
import CollapsePanel from '@/components/common/CollapsePanel.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import { platformApi } from '@/platform'

const props = defineProps<{
  sessionId?: string
  workingDirectory?: string
  agentId?: string
  lastProvider?: string
  lastModel?: string
}>()

const emit = defineEmits<{
  summaryChange: [summary: string]
}>()

const settingsStore = useSettingsStore()
const sessionsStore = useSessionsStore()
const snapshot = shallowRef<SystemPromptSnapshot | null>(null)
const loading = ref(false)
const error = ref('')
const copied = ref(false)
const activeSection = ref<'tools' | 'runtime' | 'skills' | 'agent' | 'prompt'>('prompt')
let requestId = 0
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const refreshKey = computed(() => {
  const settings = settingsStore.settings
  const variables = props.sessionId
    ? sessionsStore.sessionVariables.get(props.sessionId)?.map(variable => [
      variable.name,
      variable.scope,
      variable.value,
      variable.updatedAt,
    ].join(':')).join('|') || ''
    : ''

  return JSON.stringify({
    sessionId: props.sessionId || '',
    workingDirectory: props.workingDirectory || '',
    agentId: props.agentId || '',
    lastProvider: props.lastProvider || '',
    lastModel: props.lastModel || '',
    aiProvider: settings.ai.provider,
    aiModel: settings.ai.providers?.[settings.ai.provider]?.model || '',
    toolsEnabled: settings.tools?.enableToolCalls,
    toolSettings: settings.tools?.tools,
    agentLoopStream: true,
    skillsEnabled: settings.skills?.enableSkills,
    skillSettings: settings.skills?.skills,
    variables,
  })
})

const formattedChars = computed(() => {
  const count = snapshot.value?.systemPromptChars ?? 0
  return `${count.toLocaleString()} chars`
})

const toolsStatus = computed(() => {
  const tools = snapshot.value?.tools
  if (!tools) return 'Unknown'
  if (!tools.enableToolCalls) return 'Off'
  if (!tools.modelSupportsTools) return 'Unsupported'
  if (!tools.hasTools) return 'None'
  return `${tools.modelFacingCount} loaded`
})

const skillsStatus = computed(() => {
  const skills = snapshot.value?.skills
  if (!skills) return 'Unknown'
  if (!skills.enabled) return 'Off'
  if (!skills.count) return 'None'
  return skills.includedInPrompt ? `${skills.count} in prompt` : `${skills.count} available`
})

const runtimeStatus = computed(() => {
  const runtime = snapshot.value?.agentLoopStream
  if (!runtime) return 'Unknown'
  if (!runtime.enabled) return 'Agent loop'
  if (!runtime.providerSupported) return 'Basic stream'
  return runtime.active ? 'Agent loop' : 'Basic stream'
})

const providerWarning = computed(() => {
  if (!snapshot.value?.credentialsReady) return 'Provider credentials are missing.'
  return ''
})

type DetailRow = {
  label: string
  value: string
  mono?: boolean
}

type ToolPanelParameter = {
  name: string
  type: ToolParameter['type']
  description: string
  required?: boolean
  enum?: string[]
}

type ToolPanelItem = {
  key: string
  id: string
  name: string
  description?: string
  category?: string
  modelFacingName?: string
  source?: SystemPromptToolSnapshot['source']
  serverId?: string
  serverName?: string
  enabled?: boolean
  autoExecute?: boolean
  permissionGuard?: SystemPromptToolSnapshot['permissionGuard']
  executionMode?: SystemPromptToolSnapshot['executionMode']
  renderKind?: SystemPromptToolSnapshot['renderKind']
  parameters: ToolPanelParameter[]
}

const toolItems = computed<ToolPanelItem[]>(() => {
  const tools = snapshot.value?.tools
  if (!tools) return []
  return [
    ...tools.builtin.map(tool => toToolPanelItem(tool, 'builtin')),
    ...tools.mcp.map(tool => toToolPanelItem(tool, 'mcp')),
    ...tools.codexNative.map(tool => toToolPanelItem(tool, 'native')),
  ]
})

function toToolPanelParameter(param: ToolParameter): ToolPanelParameter {
  return {
    name: param.name,
    type: param.type,
    description: param.description,
    required: param.required,
    enum: param.enum ? [...param.enum] : undefined,
  }
}

function toToolPanelItem(
  tool: SystemPromptToolSnapshot,
  keyPrefix: 'builtin' | 'mcp' | 'native',
): ToolPanelItem {
  return {
    key: `${keyPrefix}:${tool.id}`,
    id: tool.id,
    name: tool.name,
    description: tool.description,
    category: tool.category,
    modelFacingName: tool.modelFacingName,
    source: tool.source,
    serverId: tool.serverId,
    serverName: tool.serverName,
    enabled: tool.enabled,
    autoExecute: tool.autoExecute,
    permissionGuard: tool.permissionGuard,
    executionMode: tool.executionMode,
    renderKind: tool.renderKind,
    parameters: tool.parameters?.map(toToolPanelParameter) ?? [],
  }
}

function detailRow(
  label: string,
  value: string | number | boolean | null | undefined,
  options: Pick<DetailRow, 'mono'> = {},
): DetailRow | null {
  if (value === null || value === undefined || value === '') return null
  return { label, value: String(value), ...options }
}

function compactList(values: Array<string | undefined> | undefined): string {
  return values?.filter(Boolean).join(', ') || ''
}

function formatBoolean(value: boolean | undefined): string {
  if (value === undefined) return ''
  return value ? 'On' : 'Off'
}

function formatSource(value: string | undefined): string {
  if (!value) return ''
  if (value === 'codex-native') return 'Codex native'
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function formatToken(value: string | undefined): string {
  if (!value) return ''
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]/g)
    .filter(Boolean)
    .map(part => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatParameterMeta(param: ToolPanelParameter): string {
  const parts: string[] = [param.type]
  if (param.required) parts.push('required')
  if (param.enum?.length) parts.push(`one of ${param.enum.join(', ')}`)
  return parts.join(' · ')
}

function formatConditions(skill: SystemPromptSkillSnapshot): string {
  const entries = Object.entries(skill.conditions || {})
    .map(([key, value]) => {
      if (!Array.isArray(value) || value.length === 0) return ''
      return `${formatToken(key)}: ${value.join(', ')}`
    })
    .filter(Boolean)
  return entries.join(' · ')
}

function getToolSubtitle(tool: ToolPanelItem): string {
  return [
    formatSource(tool.source),
    tool.modelFacingName && tool.modelFacingName !== tool.name ? `model: ${tool.modelFacingName}` : '',
    tool.parameters.length ? `${tool.parameters.length} params` : 'no params',
  ].filter(Boolean).join(' · ')
}

function getToolDetailRows(tool: ToolPanelItem): DetailRow[] {
  return [
    detailRow('ID', tool.id, { mono: true }),
    detailRow('Model name', tool.modelFacingName, { mono: true }),
    detailRow('Source', formatSource(tool.source)),
    detailRow('Category', formatToken(tool.category)),
    detailRow('Permission', formatToken(tool.permissionGuard)),
    detailRow('Execution', formatToken(tool.executionMode)),
    detailRow('Render', formatToken(tool.renderKind)),
    detailRow('Enabled', formatBoolean(tool.enabled)),
    detailRow('Auto execute', formatBoolean(tool.autoExecute)),
    detailRow('Server', tool.serverName || tool.serverId),
  ].filter(Boolean) as DetailRow[]
}

function getSkillSubtitle(skill: SystemPromptSkillSnapshot): string {
  return [
    formatSource(skill.source),
    formatToken(skill.category),
    skill.tags?.length ? `${skill.tags.length} tags` : '',
    skill.files?.length ? `${skill.files.length} files` : '',
  ].filter(Boolean).join(' · ')
}

function getSkillDetailRows(skill: SystemPromptSkillSnapshot): DetailRow[] {
  return [
    detailRow('ID', skill.id, { mono: true }),
    detailRow('Source', formatSource(skill.source)),
    detailRow('Category', formatToken(skill.category)),
    detailRow('Enabled', formatBoolean(skill.enabled)),
    detailRow('Path', skill.path, { mono: true }),
    detailRow('Directory', skill.directoryPath, { mono: true }),
    detailRow('Relative path', skill.relativePath, { mono: true }),
    detailRow('Root', skill.rootPath, { mono: true }),
    detailRow('Allowed tools', compactList(skill.allowedTools)),
    detailRow('Related skills', compactList(skill.relatedSkills)),
    detailRow('Platforms', compactList(skill.platforms)),
    detailRow('Conditions', formatConditions(skill)),
  ].filter(Boolean) as DetailRow[]
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshSnapshot()
  }, 180)
}

async function refreshSnapshot() {
  const sessionId = props.sessionId
  if (!sessionId) {
    snapshot.value = null
    error.value = 'No session selected'
    return
  }

  const currentRequest = ++requestId
  loading.value = true
  error.value = ''

  try {
    const response = await platformApi.getSystemPromptSnapshot(sessionId)
    if (currentRequest !== requestId) return
    if (!response.success || !response.snapshot) {
      throw new Error(response.error || 'Failed to load system prompt')
    }
    snapshot.value = response.snapshot
  } catch (err) {
    if (currentRequest !== requestId) return
    error.value = err instanceof Error ? err.message : 'Failed to load system prompt'
  } finally {
    if (currentRequest === requestId) loading.value = false
  }
}

async function copyPrompt() {
  if (!snapshot.value?.systemPrompt) return
  const success = await copyTextToClipboard(snapshot.value.systemPrompt)
  if (!success) return
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copied.value = false
    copiedTimer = null
  }, 1200)
}

const panelSummary = computed(() => {
  const snap = snapshot.value
  if (!snap) return ''
  return [snap.model || snap.providerId, formattedChars.value].filter(Boolean).join(' · ')
})

watch(refreshKey, scheduleRefresh, { immediate: true })
watch(panelSummary, summary => emit('summaryChange', summary), { immediate: true })

defineExpose({
  refreshSnapshot,
})

onBeforeUnmount(() => {
  requestId++
  if (refreshTimer) clearTimeout(refreshTimer)
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<style scoped>
.system-prompt-panel {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 9px 10px 10px;
}

.system-prompt-scroll {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.system-prompt-state {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  color: var(--ui-text-muted-fg);
  font-size: 12px;
}

.system-prompt-state.error,
.system-prompt-warning {
  color: var(--ui-status-danger-fg, var(--danger));
}

.system-prompt-warning {
  padding: 7px 8px;
  border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, currentColor 7%, transparent);
  font-size: 11.5px;
  line-height: 1.35;
}

/* 书目词条:label …… value。无框无底,悬停点线描实,活动项朱砂。 */
.system-prompt-meta-grid {
  display: flex;
  flex-direction: column;
}

.system-prompt-meta-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 3px 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.system-prompt-meta-leader {
  flex: 1 1 auto;
  height: 0;
  min-width: 10px;
  border-bottom: 1.5px dotted color-mix(in srgb, var(--ui-border-default-border) 85%, transparent);
  transform: translateY(1px);
}

.system-prompt-meta-item:hover span {
  color: var(--ui-text-primary-fg);
}

.system-prompt-meta-item:hover .system-prompt-meta-leader {
  border-bottom-style: solid;
  border-bottom-color: var(--ui-text-muted-fg);
}

.system-prompt-meta-item.active span,
.system-prompt-meta-item.active strong {
  color: var(--ui-accent-primary-fg, var(--accent-color));
}

.system-prompt-meta-item.active .system-prompt-meta-leader {
  border-bottom-style: solid;
  border-bottom-color: var(--ui-accent-primary-fg, var(--accent-color));
  opacity: 0.5;
}

.system-prompt-group-head {
  color: var(--ui-text-muted-fg);
  font-size: 10.5px;
  font-weight: 650;
  text-transform: uppercase;
}

.system-prompt-meta-item span {
  flex: 0 0 auto;
  color: var(--ui-text-muted-fg);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 550;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.system-prompt-meta-item strong {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-primary-fg);
  font-size: 11.5px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.system-prompt-meta-item strong.muted {
  color: var(--ui-text-muted-fg);
}

.system-prompt-group {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.system-prompt-detail {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.system-prompt-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.system-prompt-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  overflow: visible;
}

.system-prompt-chip-list.compact {
  gap: 4px;
}

.system-prompt-chip {
  max-width: 100%;
  overflow: hidden;
  padding: 3px 6px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-primary-fg, var(--accent-color)) 24%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--ui-accent-primary-fg, var(--accent-color)) 8%, transparent);
  color: color-mix(in srgb, var(--ui-text-primary-fg) 86%, var(--ui-accent-primary-fg, var(--accent-color)));
  font-size: 11px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.system-prompt-chip.inactive {
  border-color: color-mix(in srgb, var(--ui-border-default-border) 34%, transparent);
  background: color-mix(in srgb, var(--ui-surface-panel-bg) 52%, transparent);
  color: var(--ui-text-muted-fg);
}

.system-prompt-chip.more {
  border-color: color-mix(in srgb, var(--ui-border-default-border) 42%, transparent);
  background: color-mix(in srgb, var(--ui-surface-panel-bg) 62%, transparent);
  color: var(--ui-text-muted-fg);
}

.system-prompt-collapse-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.system-prompt-collapse-panel {
  min-width: 0;
}

.system-prompt-collapse-panel :deep(.collapse-panel-header) {
  min-height: 30px;
  padding: 5px 7px;
}

.system-prompt-collapse-panel :deep(.collapse-panel-title) {
  min-width: 0;
}

.system-prompt-collapse-panel :deep(.collapse-panel-content) {
  padding: 0 7px 7px;
}

.system-prompt-detail-title {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.system-prompt-detail-name {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-primary-fg);
  font-size: 11.5px;
  font-weight: 650;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.system-prompt-detail-name.inactive {
  color: var(--ui-text-muted-fg);
}

.system-prompt-detail-subtitle {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-muted-fg);
  font-size: 10.5px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.system-prompt-detail-body {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}

.system-prompt-description,
.system-prompt-param-desc {
  margin: 0;
  color: var(--ui-text-secondary-fg);
  font-size: 11.5px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.system-prompt-detail-list {
  display: grid;
  grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
  gap: 4px 8px;
  min-width: 0;
  margin: 0;
}

.system-prompt-detail-list div {
  display: contents;
}

.system-prompt-detail-list dt,
.system-prompt-subhead {
  color: var(--ui-text-muted-fg);
  font-size: 10.5px;
  font-weight: 650;
  line-height: 1.35;
  text-transform: uppercase;
}

.system-prompt-detail-list dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--ui-text-primary-fg);
  font-size: 11.5px;
  line-height: 1.35;
}

.system-prompt-detail-list dd.mono,
.system-prompt-param-name,
.system-prompt-file-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

.system-prompt-subgroup {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.system-prompt-param-list,
.system-prompt-file-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.system-prompt-param-list li,
.system-prompt-file-list li {
  min-width: 0;
  padding: 5px 0;
  border-top: 1px solid color-mix(in srgb, var(--ui-border-default-border) 28%, transparent);
}

.system-prompt-param-list li:first-child,
.system-prompt-file-list li:first-child {
  border-top: 0;
}

.system-prompt-param-head,
.system-prompt-file-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.system-prompt-param-name,
.system-prompt-file-name {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-primary-fg);
  font-size: 11px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.system-prompt-param-type,
.system-prompt-file-type {
  flex: 0 0 auto;
  color: var(--ui-text-muted-fg);
  font-size: 10.5px;
  line-height: 1.25;
}

.system-prompt-param-desc {
  margin-top: 3px;
  color: var(--ui-text-muted-fg);
}

.system-prompt-empty {
  margin: 0;
  color: var(--ui-text-muted-fg);
  font-size: 11.5px;
}

.system-prompt-info-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  margin: 0;
}

.system-prompt-info-list div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid color-mix(in srgb, var(--ui-border-default-border) 30%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--ui-surface-panel-bg) 48%, transparent);
}

.system-prompt-info-list dt {
  color: var(--ui-text-muted-fg);
  font-size: 10.5px;
  font-weight: 650;
  text-transform: uppercase;
}

.system-prompt-info-list dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--ui-text-primary-fg);
  font-size: 11.5px;
  line-height: 1.35;
}

.system-prompt-prompt-section {
  overflow: hidden;
}

.system-prompt-copy-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
}

.system-prompt-copy-button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-state-hover-bg) 68%, transparent);
  color: var(--ui-text-primary-fg);
}

.system-prompt-copy-button:disabled {
  cursor: default;
  opacity: 0.5;
}

.system-prompt-copy-button.copied {
  color: var(--ui-accent-primary-fg, var(--accent-color));
}

.system-prompt-text {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  margin: 0;
  padding: 9px;
  overflow: auto;
  border: 1px solid color-mix(in srgb, var(--ui-border-default-border) 34%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--ui-surface-code-block-bg) 82%, transparent);
  color: var(--ui-text-primary-fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

</style>

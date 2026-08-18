<template>
  <section
    class="variables-panel"
    aria-label="Session variables"
  >
    <div
      v-if="variables.length === 0"
      class="variables-state"
    >
      No variables yet
    </div>

    <div
      v-else
      class="variables-groups"
    >
      <section
        v-for="group in variableGroups"
        :key="group.scope"
        class="variables-group"
      >
        <div class="variables-group-head">
          <span class="variables-group-title">{{ group.label }}</span>
          <span class="variables-group-count">{{ group.items.length }}</span>
        </div>
        <div class="variables-rows">
          <div
            v-for="variable in group.items"
            :key="variable.name"
            class="variables-item"
          >
            <button
              type="button"
              class="variables-row"
              :aria-expanded="expandedName === variable.name"
              @click="toggleExpanded(variable.name)"
            >
              <code class="variables-name">{{ variable.name }}</code>
              <i
                class="variables-leader"
                aria-hidden="true"
              />
              <span
                class="variables-value"
                :class="{ 'is-empty': !variable.value }"
              >{{ compactValue(variable.value) }}</span>
            </button>
            <div
              v-if="expandedName === variable.name"
              class="variables-detail"
            >
              <pre
                v-for="(value, index) in expandedValues(variable)"
                :key="index"
                class="variables-detail-value"
              >{{ value }}</pre>
              <p
                v-if="variable.description"
                class="variables-detail-description"
              >
                {{ variable.description }}
              </p>
              <div class="variables-detail-meta">
                <span>{{ group.label.toLowerCase() }}</span>
                <span v-if="variable.type && variable.type !== 'string'">{{ variable.type }}</span>
                <span v-if="variable.state">state</span>
                <span v-if="variable.readonly">readonly</span>
                <span v-if="variable.updatedAt">{{ formatAge(variable.updatedAt) }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ContextVariable } from '@/types'
import { useSessionsStore } from '@/stores/sessions'

const props = withDefaults(defineProps<{
  sessionId?: string
}>(), {
  sessionId: undefined,
})

const emit = defineEmits<{
  summaryChange: [summary: string]
}>()

const sessionsStore = useSessionsStore()
const expandedName = ref<string | null>(null)

const variables = computed<ContextVariable[]>(() => {
  if (!props.sessionId) return []
  return sessionsStore.sessionVariables.get(props.sessionId) ?? []
})

const variableGroups = computed(() => {
  const byScope = (scope: VariableScopeGroup) =>
    variables.value.filter(variable => resolveScope(variable) === scope)
  return [
    { scope: 'session', label: 'Session', items: byScope('session') },
    { scope: 'agent', label: 'Agent', items: byScope('agent') },
    { scope: 'project', label: 'Project', items: byScope('project') },
    { scope: 'global', label: 'Global', items: byScope('global') },
  ].filter(group => group.items.length > 0)
})

const summary = computed(() => {
  const count = variables.value.length
  if (count === 0) return ''
  const latest = [...variables.value]
    .filter(variable => typeof variable.updatedAt === 'number')
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
  return latest ? `${count} · ${latest.name}` : `${count}`
})

type VariableScopeGroup = 'global' | 'session' | 'agent' | 'project'

function resolveScope(variable: ContextVariable): VariableScopeGroup {
  if (variable.scope === 'global' || variable.scope === 'session'
    || variable.scope === 'agent' || variable.scope === 'project') return variable.scope
  return ['user_note_dir', 'work_note_dir'].includes(variable.name) ? 'global' : 'session'
}

function compactValue(value: string | undefined): string {
  if (!value) return 'not set'
  const singleLine = value.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= 44) return singleLine
  // Paths, timestamps and ids carry their signal at both ends — a head-only
  // cut ("/Users/yitiansong/dat…") shows the least informative half.
  return `${singleLine.slice(0, 18)}…${singleLine.slice(-22)}`
}

function expandedValues(variable: ContextVariable): string[] {
  if (Array.isArray(variable.values) && variable.values.length > 0) return variable.values
  return [variable.value || '-']
}

function formatAge(updatedAt: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - updatedAt) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function toggleExpanded(name: string) {
  expandedName.value = expandedName.value === name ? null : name
}

watch(summary, value => emit('summaryChange', value), { immediate: true })

watch(
  () => props.sessionId,
  (sessionId) => {
    expandedName.value = null
    if (sessionId) sessionsStore.fetchVariables(sessionId)
  },
)

onMounted(() => {
  if (props.sessionId) sessionsStore.fetchVariables(props.sessionId)
})
</script>

<style scoped>
.variables-panel {
  --variables-muted: var(--ui-text-muted-fg);
  --variables-accent: var(--ui-accent-primary-fg);

  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  color: var(--ui-text-primary-fg);
}

.variables-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 92px;
  color: var(--variables-muted);
  font-size: 12px;
}

.variables-groups {
  display: grid;
  flex: 1 1 auto;
  align-content: start;
  gap: 12px;
  min-height: 0;
  overflow: auto;
  padding-right: 2px;
}

.variables-group {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.variables-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.variables-group-title {
  color: color-mix(in srgb, var(--ui-text-primary-fg) 82%, var(--variables-muted));
  font-size: 11.5px;
  font-weight: 650;
}

.variables-group-count {
  flex: 0 0 auto;
  color: var(--variables-muted);
  font-size: 11px;
  font-weight: 650;
}

.variables-rows {
  display: grid;
  gap: 3px;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
}

/* 书目行:名 …… 值,点线引导 */
.variables-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  min-height: 18px;
  padding: 1px 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.variables-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: color-mix(in srgb, var(--ui-text-primary-fg) 90%, var(--variables-muted));
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.variables-leader {
  flex: 1 1 auto;
  height: 0;
  min-width: 10px;
  border-bottom: 1.5px dotted color-mix(in srgb, var(--ui-border-default-border) 85%, transparent);
  transform: translateY(1px);
}

.variables-value {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 55%;
  overflow: hidden;
  color: var(--variables-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.variables-row:hover .variables-value {
  color: color-mix(in srgb, var(--ui-text-primary-fg) 72%, var(--variables-muted));
}

.variables-value.is-empty {
  color: color-mix(in srgb, var(--variables-muted) 70%, transparent);
  font-style: italic;
}

.variables-detail {
  display: grid;
  gap: 5px;
  margin: 2px 0 5px;
  padding-left: 10px;
  border-left: 1.5px solid color-mix(in srgb, var(--variables-accent) 42%, transparent);
}

.variables-detail-value {
  margin: 0;
  overflow-x: auto;
  color: var(--ui-text-secondary-fg);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

.variables-detail-description {
  margin: 0;
  color: var(--variables-muted);
  font-size: 11px;
  line-height: 1.35;
}

.variables-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--variables-muted);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
</style>

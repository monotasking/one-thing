<template>
  <section class="ledger-section">
    <div class="section-header-row">
      <h3 class="section-label">
        Models
        <span class="count-note">{{ ledger.rows.value.length }} available · ★ default</span>
      </h3>
    </div>

    <div class="ledger-toolbar">
      <Input
        v-model="ledger.searchQuery.value"
        variant="ledger"
        class="ledger-search"
        type="search"
        :prefix-icon="Search"
        clearable
        :spellcheck="false"
        aria-label="Search models"
      />
      <div
        class="ledger-chips"
        role="group"
        aria-label="Filter models by capability"
      >
        <Button
          v-for="chip in FILTER_CHIPS"
          :key="chip.value"
          unstyled
          class="ledger-chip"
          :class="{ sel: ledger.capabilityFilter.value === chip.value }"
          native-type="button"
          @click="ledger.capabilityFilter.value = chip.value"
        >
          {{ chip.label }}
        </Button>
      </div>
    </div>

    <div class="ledger-table">
      <div
        class="ledger-head"
        aria-hidden="true"
      >
        <span />
        <span>Model</span>
        <span>Provider</span>
        <span class="num">Context</span>
        <span>Capabilities</span>
        <span />
      </div>

      <div
        v-for="row in ledger.filteredRows.value"
        :key="row.key"
        class="ledger-row-block"
      >
        <div
          class="ledger-row"
          role="button"
          tabindex="0"
          :aria-expanded="ledger.expandedRowKey.value === row.key"
          @click="ledger.toggleRowExpanded(row)"
          @keydown.enter.prevent="ledger.toggleRowExpanded(row)"
          @keydown.space.prevent="ledger.toggleRowExpanded(row)"
        >
          <Button
            unstyled
            class="row-star"
            :class="{ set: row.isDefault }"
            native-type="button"
            :aria-label="row.isDefault
              ? `${row.modelId} is the default model`
              : `Set ${row.modelId} as default model`"
            @click.stop="ledger.setDefault(row)"
          >
            <Star
              :size="13"
              :fill="row.isDefault ? 'currentColor' : 'none'"
            />
          </Button>

          <span class="row-model">
            <span class="row-model-id">{{ row.modelId }}</span>
            <span
              v-if="row.isCustom"
              class="row-custom-tag"
            >custom</span>
          </span>

          <span class="row-provider">
            <ProviderIcon
              :provider="row.providerId"
              :size="13"
            />
            <span class="row-provider-name">{{ row.providerName }}</span>
          </span>

          <span class="row-ctx num">{{ row.contextLabel || '—' }}</span>

          <span class="row-caps">
            <Tooltip
              v-if="row.caps.vision"
              text="Image input"
            >
              <Eye :size="12" />
            </Tooltip>
            <Tooltip
              v-if="row.caps.tools"
              text="Tools"
            >
              <Wrench :size="12" />
            </Tooltip>
            <Tooltip
              v-if="row.caps.reasoning"
              text="Reasoning"
            >
              <Brain :size="12" />
            </Tooltip>
            <Tooltip
              v-if="row.caps.image"
              text="Image output"
            >
              <Image :size="12" />
            </Tooltip>
          </span>

          <span class="row-tune-hint">
            Tune
            <ChevronDown
              class="row-chevron"
              :class="{ expanded: ledger.expandedRowKey.value === row.key }"
              :size="13"
            />
          </span>
        </div>

        <div
          v-if="ledger.expandedRowKey.value === row.key"
          class="ledger-tune"
          @click.stop
        >
          <!-- C2 推翻 C1 的「逐模型调参与空间无关」:用户 08-18 要的是
               「完整、独立的两套」,逐模型覆盖也跟着空间走。说清楚它只影响
               当前空间,免得用户以为改一次到处生效。 -->
          <p class="tune-scope-note">
            仅当前空间
          </p>
          <div class="tune-line">
            <span class="tune-label">Style</span>
            <template v-if="row.supportsTemperature">
              <div class="tune-seg">
                <Button
                  unstyled
                  class="seg-btn"
                  :class="{ sel: ledger.styleState(row) === 'default' }"
                  native-type="button"
                  @click="ledger.setStylePreset(row, null)"
                >
                  Default
                </Button>
                <Button
                  v-for="preset in STYLE_PRESETS"
                  :key="preset.value"
                  unstyled
                  class="seg-btn"
                  :class="{ sel: ledger.styleState(row) === preset.value }"
                  native-type="button"
                  @click="ledger.setStylePreset(row, preset.value)"
                >
                  {{ preset.label }}
                </Button>
              </div>
              <span class="tune-value">
                {{ ledger.effectiveTemperature(row).toFixed(1) }}
                <template v-if="ledger.styleState(row) === 'custom'"> · custom</template>
              </span>
            </template>
            <span
              v-else
              class="tune-hint"
            >not supported by this model</span>
          </div>

          <div class="tune-line">
            <span class="tune-label">Output</span>
            <template v-if="row.maxOutputLimit > 0">
              <div class="tune-seg">
                <Button
                  v-for="preset in OUTPUT_PRESETS"
                  :key="preset.value"
                  unstyled
                  class="seg-btn"
                  :class="{ sel: ledger.outputState(row) === preset.value }"
                  native-type="button"
                  @click="ledger.setOutputPreset(row, preset.value)"
                >
                  {{ preset.label }}
                </Button>
              </div>
              <span class="tune-value">
                {{ ledger.effectiveMaxOutput(row).toLocaleString() }} tokens
                <template v-if="ledger.outputState(row) === 'custom'"> · custom</template>
              </span>
            </template>
            <span
              v-else
              class="tune-hint"
            >no limit data for this model</span>
          </div>

          <div class="tune-line tune-caps-line">
            <span class="tune-label">Capabilities</span>
            <div class="tune-caps">
              <span
                v-for="cap in CAPABILITY_KEYS"
                :key="cap.key"
                class="tune-cap"
              >
                <component
                  :is="cap.icon"
                  :size="12"
                  class="tune-cap-icon"
                />
                <span class="tune-cap-name">{{ cap.label }}</span>
                <span class="tune-tristate">
                  <Button
                    v-for="opt in TRISTATE_OPTIONS"
                    :key="String(opt.value)"
                    unstyled
                    class="tristate-btn"
                    :class="{ sel: ledger.capabilityOverrideState(row, cap.key) === opt.value }"
                    native-type="button"
                    :aria-label="`${cap.label}: ${opt.hint}`"
                    @click="ledger.setCapabilityOverride(row, cap.key, opt.value ?? null)"
                  >
                    {{ opt.label }}
                  </Button>
                </span>
              </span>
              <Button
                v-if="ledger.hasCapabilityOverride(row)"
                unstyled
                class="tune-action"
                native-type="button"
                @click="ledger.resetCapabilityOverrides(row)"
              >
                Reset overrides
              </Button>
            </div>
          </div>

          <div class="tune-line tune-foot">
            <template v-if="renamingRowKey === row.key">
              <Input
                ref="renameInputRef"
                v-model="renameValue"
                variant="ledger"
                size="small"
                class="rename-input"
                :spellcheck="false"
                aria-label="New model ID"
                @keydown.enter.prevent="commitRename(row)"
                @keydown.esc.prevent="cancelRename"
              />
              <Button
                unstyled
                class="tune-action"
                native-type="button"
                @click="commitRename(row)"
              >
                Save
              </Button>
              <Button
                unstyled
                class="tune-action"
                native-type="button"
                @click="cancelRename"
              >
                Cancel
              </Button>
              <ErrorNote
                v-if="renameError"
                class="tune-error"
                size="sm"
                :message="renameError"
              />
            </template>
            <template v-else>
              <Button
                v-if="row.isCustom"
                unstyled
                class="tune-action"
                native-type="button"
                @click="startRename(row)"
              >
                Rename
              </Button>
              <Tooltip :text="removeTitle(row)">
                <Button
                  unstyled
                  class="tune-action danger"
                  native-type="button"
                  @click="handleRemove(row)"
                >
                  Remove from list
                </Button>
              </Tooltip>
              <ErrorNote
                v-if="removeError === row.key"
                class="tune-error"
                size="sm"
              >
                Each provider keeps at least one model — manage it under Connections.
              </ErrorNote>
            </template>
          </div>
        </div>
      </div>

      <div
        v-if="ledger.filteredRows.value.length === 0"
        class="ledger-empty"
      >
        <template v-if="ledger.rows.value.length === 0">
          No models yet — connect a provider below and pick models via “Manage models”.
        </template>
        <template v-else>
          No models match the current filter.
        </template>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { Brain, ChevronDown, Eye, Image, Search, Star, Wrench } from 'lucide-vue-next'
import Button from '@/components/common/Button.vue'
import Input from '@/components/common/Input.vue'
import ErrorNote from '@/components/common/ErrorNote.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import ProviderIcon from '../ProviderIcon.vue'
import type { AppSettings, ModelCapabilityOverride, ProviderInfo } from '@/types'
import type { CapabilityFilter, LedgerRow, OutputPreset, StylePreset } from './useModelLedger'
import { STYLE_PRESET_TEMPERATURES, useModelLedger } from './useModelLedger'

const props = defineProps<{
  settings: AppSettings
  providers: ProviderInfo[]
}>()

const emit = defineEmits<{
  'update:settings': [settings: AppSettings]
}>()

const ledger = useModelLedger(props, (event, value) => emit(event, value))

onMounted(() => {
  ledger.warmModelCaches()
})

const FILTER_CHIPS: Array<{ value: CapabilityFilter, label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'vision', label: 'Vision' },
  { value: 'tools', label: 'Tools' },
  { value: 'reasoning', label: 'Reasoning' },
  { value: 'image', label: 'Image' },
]

const STYLE_PRESETS: Array<{ value: StylePreset, label: string, temperature: number }> = [
  { value: 'precise', label: 'Precise', temperature: STYLE_PRESET_TEMPERATURES.precise },
  { value: 'balanced', label: 'Balanced', temperature: STYLE_PRESET_TEMPERATURES.balanced },
  { value: 'creative', label: 'Creative', temperature: STYLE_PRESET_TEMPERATURES.creative },
]

const OUTPUT_PRESETS: Array<{ value: OutputPreset, label: string }> = [
  { value: 'lean', label: 'Lean' },
  { value: 'standard', label: 'Standard' },
  { value: 'max', label: 'Max' },
]

const CAPABILITY_KEYS: Array<{
  key: keyof ModelCapabilityOverride
  label: string
  icon: any
}> = [
  { key: 'vision', label: 'Vision', icon: Eye },
  { key: 'tools', label: 'Tools', icon: Wrench },
  { key: 'reasoning', label: 'Reasoning', icon: Brain },
  { key: 'imageOutput', label: 'Image out', icon: Image },
]

const TRISTATE_OPTIONS: Array<{
  value: boolean | undefined
  label: string
  hint: string
}> = [
  { value: undefined, label: 'Auto', hint: 'defer to models.dev metadata' },
  { value: true, label: 'On', hint: 'force enabled' },
  { value: false, label: 'Off', hint: 'force disabled' },
]

const renamingRowKey = ref<string | null>(null)
const renameValue = ref('')
const renameError = ref('')
const renameInputRef = ref<Array<InstanceType<typeof Input>> | InstanceType<typeof Input> | null>(null)
const removeError = ref<string | null>(null)

function startRename(row: LedgerRow) {
  renamingRowKey.value = row.key
  renameValue.value = row.modelId
  renameError.value = ''
  nextTick(() => {
    const el = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value
    el?.focus()
    el?.select()
  })
}

function cancelRename() {
  renamingRowKey.value = null
  renameValue.value = ''
  renameError.value = ''
}

function commitRename(row: LedgerRow) {
  const result = ledger.renameModel(row, renameValue.value)
  if (!result.ok) {
    renameError.value = result.reason === 'duplicate'
      ? 'A model with this ID already exists for this provider.'
      : 'Model ID cannot be empty.'
    return
  }
  cancelRename()
}

function handleRemove(row: LedgerRow) {
  const result = ledger.removeModel(row)
  removeError.value = result.ok ? null : row.key
}

function removeTitle(row: LedgerRow): string {
  return row.isDefault
    ? 'Remove from the model list (the provider falls back to its next model)'
    : 'Remove from the model list'
}
</script>

<style scoped>
.ledger-section {
  min-width: 0;
}

.section-header-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.section-label {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0;
  flex: 1;
}

.count-note {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0.02em;
}

/* Toolbar: hairline search + ring chips. */
.ledger-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 4px;
  padding-bottom: 10px;
}

/* Toolbar search: `<Input variant="ledger">` with prefix icon + built-in
   clear; only the width budget lives here. */
.ledger-search {
  min-width: 180px;
  max-width: 260px;
  flex: 1;
}

.ledger-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.ledger-chip {
  padding: 1px 11px 2px;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  border-radius: 999px;
  background: transparent;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default), border-color var(--duration-fast) var(--ease-default);
}

.ledger-chip:hover {
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

.ledger-chip.sel {
  border-color: var(--settings-accent, var(--ui-accent-primary-fg));
  color: var(--settings-accent, var(--ui-accent-primary-fg));
}

/* Table: heavy top rule, mono column caps, hairline rows. */
.ledger-table {
  border-top: 2px solid var(--settings-ink, var(--ui-text-primary-fg));
  min-width: 0;
}

.ledger-head,
.ledger-row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) minmax(90px, auto) 58px minmax(72px, auto) auto;
  align-items: center;
  gap: 12px;
}

.ledger-head {
  padding: 7px 2px;
  border-bottom: 1px solid var(--settings-rule, var(--ui-border-default-border));
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.ledger-row-block + .ledger-row-block {
  border-top: 1px solid var(--settings-rule-soft, var(--ui-border-subtle-border));
}

.ledger-row {
  width: 100%;
  padding: 9px 2px;
  cursor: pointer;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  transition: background var(--duration-fast) var(--ease-default);
}

.ledger-row:hover {
  background: color-mix(in srgb, var(--settings-ink, var(--ui-text-primary-fg)) 4%, transparent);
}

.ledger-row:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--settings-ink, var(--ui-text-primary-fg)) 24%, transparent);
  outline-offset: -2px;
}

.row-star {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  color: var(--settings-ink-5, var(--ui-text-faint-fg, var(--ui-text-muted-fg)));
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default), transform var(--duration-fast) var(--ease-default);
}

.row-star:hover {
  color: var(--settings-accent, var(--ui-accent-primary-fg));
  transform: scale(1.15);
}

.row-star.set {
  color: var(--settings-accent, var(--ui-accent-primary-fg));
}

.row-model {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.row-model-id {
  overflow: hidden;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-family: var(--font-mono, monospace);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-custom-tag {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  border-bottom: 1px dotted var(--settings-rule, var(--ui-border-default-border));
  flex: none;
}

.row-provider {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--settings-ink-2, var(--ui-text-secondary-fg));
  font-size: 12px;
}

.row-provider-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.num {
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
}

.row-ctx {
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-size: 11.5px;
  text-align: right;
}

.row-caps {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
}

.row-tune-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  white-space: nowrap;
}

.ledger-row:hover .row-tune-hint {
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

.row-chevron {
  transition: transform var(--duration-normal) var(--ease-default);
}

.row-chevron.expanded {
  transform: rotate(180deg);
}

/* Tune drawer: dashed inset under the row, single-line controls. */
.ledger-tune {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 2px 12px 38px;
  border-top: 1px dashed var(--settings-rule-soft, var(--ui-border-subtle-border));
}

.tune-line {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  min-height: 24px;
}

.tune-label {
  width: 84px;
  flex: none;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.tune-seg {
  display: inline-flex;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
}

.seg-btn {
  padding: 2px 12px 3px;
  border-left: 1px solid var(--settings-rule, var(--ui-border-default-border));
  background: transparent;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-size: 11.5px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default), background var(--duration-fast) var(--ease-default);
}

.seg-btn:first-child {
  border-left: 0;
}

.seg-btn:hover {
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

.seg-btn.sel {
  background: var(--settings-accent, var(--ui-accent-primary-fg));
  color: var(--settings-paper, var(--ui-surface-app-bg));
}

.tune-value {
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

.tune-hint {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 11.5px;
}

.tune-error {
  flex-shrink: 1;
}

.tune-caps-line {
  align-items: flex-start;
}

.tune-caps-line .tune-label {
  padding-top: 3px;
}

.tune-caps {
  display: flex;
  align-items: center;
  gap: 8px 18px;
  flex-wrap: wrap;
  min-width: 0;
}

.tune-cap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tune-cap-icon {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
}

.tune-cap-name {
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-size: 11.5px;
}

.tune-tristate {
  display: inline-flex;
  border: 1px solid var(--settings-rule-soft, var(--ui-border-subtle-border));
}

.tristate-btn {
  padding: 0 7px 1px;
  border-left: 1px solid var(--settings-rule-soft, var(--ui-border-subtle-border));
  background: transparent;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  cursor: pointer;
}

.tristate-btn:first-child {
  border-left: 0;
}

.tristate-btn:hover {
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

.tristate-btn.sel {
  background: color-mix(in srgb, var(--settings-accent, var(--ui-accent-primary-fg)) 85%, transparent);
  color: var(--settings-paper, var(--ui-surface-app-bg));
}

.tune-foot {
  gap: 16px;
}

.tune-action {
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default);
}

.tune-action:hover {
  color: var(--settings-ink, var(--ui-text-primary-fg));
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--settings-accent, var(--ui-accent-primary-fg));
}

.tune-action.danger:hover {
  text-decoration-color: var(--ui-status-danger-fg, var(--color-danger));
}

/* Inline rename: `<Input variant="ledger">` owns the frame; the mono face
   and width floor stay local. */
.rename-input {
  min-width: 220px;
}

.rename-input :deep(.app-input-inner) {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

.ledger-empty {
  padding: 22px 2px;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 12.5px;
}
.tune-scope-note {
  margin: 0 0 6px;
  font-size: 11px;
  color: var(--ui-text-muted);
}

</style>

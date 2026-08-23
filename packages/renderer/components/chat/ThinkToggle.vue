<template>
  <div
    v-if="visible"
    class="thinking-control"
    @click.stop
  >
    <Tooltip
      :text="tooltipText"
      :disabled="tooltipDisabled"
    >
      <Select
        class="think-select"
        :class="{ active: selectionActive }"
        :style="thinkSelectStyle"
        size="small"
        teleported
        placement="top"
        popper-class="inputbox-select-dropdown think-select-dropdown"
        :model-value="thinkingSelectValue"
        :options="thinkSelectOptions"
        :aria-label="tooltipText"
        :popper-style="thinkDropdownStyle"
        @change="handleThinkSelect"
        @visible-change="handleThinkVisibleChange"
      >
        <template #prefix>
          <Brain :size="14" />
        </template>

        <template #label>
          <span class="think-value">{{ currentSelectionLabel }}</span>
        </template>

        <template #option="{ option }">
          <span class="think-option-row">
            <span class="think-option-main">
              <span class="think-option-text">{{ thinkOptionLabel(option) }}</span>
              <span
                v-if="thinkOptionDescription(option)"
                class="think-option-description"
              >
                {{ thinkOptionDescription(option) }}
              </span>
            </span>
            <Check
              v-if="isThinkSelectOptionSelected(option)"
              class="think-option-check"
              :size="13"
            />
          </span>
        </template>
      </Select>
    </Tooltip>
  </div>
</template>

<script setup lang="ts">
import Select from '@/components/common/Select.vue'
import { computed, ref, type StyleValue } from 'vue'
import { Brain, Check } from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import { useSessionsStore } from '@/stores/sessions'
import type { AIProvider, OpenRouterModel, ThinkingEffort } from '@shared/ipc'
import type { SelectModelValue, SelectOptionLike } from '@/components/common/select'
import Tooltip from '../common/Tooltip.vue'
import { resolveProviderModelSelection } from '@/stores/helpers/provider-model'
import { useSpaceProviderView } from '@/composables/useSpaceProviderView'
import { useSessionAgentModel } from '@/composables/useSessionAgentModel'
import { resolveOnethingModelCapabilities } from '@onething/runtime/providers/model-capability'

interface Props {
  sessionId?: string
}

interface EffortOption {
  value: ThinkingEffort
  label: string
  description?: string
}

interface ServiceTierOption {
  value: string
  label: string
  description?: string
}

type ThinkOption =
  | { kind: 'off'; label: string; description?: string }
  | { kind: 'on'; label: string; description?: string }
  | { kind: 'effort'; value: ThinkingEffort; label: string; description?: string }
  | { kind: 'speed'; value: string | null; label: string; description?: string }

interface ThinkOptionGroup {
  key: 'thinking' | 'speed'
  label: string
  options: ThinkOption[]
}

interface ThinkSelectOption {
  value: string
  label: string
  description?: string
  option: ThinkOption
}

interface CodexModelMetadata {
  defaultReasoningEffort?: ThinkingEffort
  supportedReasoningEfforts?: Array<{
    effort?: ThinkingEffort
    value?: ThinkingEffort
    name?: ThinkingEffort
    reasoningEffort?: ThinkingEffort
    reasoning_effort?: ThinkingEffort
    description?: string
  }>
  serviceTiers?: Array<string | {
    id?: string
    value?: string
    name?: string
    label?: string
    description?: string
  }>
}

const props = defineProps<Props>()

const settingsStore = useSettingsStore()
const sessionsStore = useSessionsStore()

/**
 * 当前空间的 provider 视图(批 B9)。ThinkToggle 也会「改默认」——切换思考档
 * 的那一对模型(deepseek-chat ↔ deepseek-reasoner)走的是同一条改默认的路,
 * 所以落点也得跟着空间走。
 */
const spaceView = useSpaceProviderView({
  settings: () => settingsStore.settings,
  providers: () => settingsStore.availableProviders || [],
})

const tooltipDisabled = ref(false)

function handleThinkVisibleChange(visible: boolean) {
  tooltipDisabled.value = visible
}

const THINKING_PAIRS: Record<string, { normal: string; thinking: string }> = {
  deepseek: { normal: 'deepseek-chat', thinking: 'deepseek-reasoner' },
}


const CODEX_FALLBACK_EFFORT_OPTIONS: EffortOption[] = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X High' },
]

const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X High',
  max: 'Max',
}

const thinkDropdownStyle = computed<StyleValue>(() => ({
  width: '190px',
}))

const currentSession = computed(() => {
  const sid = props.sessionId
  if (!sid) return null
  return sessionsStore.getSessionItem(sid) || null
})

const sessionAgentModel = useSessionAgentModel(currentSession)

const currentSelection = computed(() => resolveProviderModelSelection({
  settings: settingsStore.settings,
  session: currentSession.value,
  agentModel: sessionAgentModel.value,
  spaceDefault: spaceView.spaceDefault.value,
}))

const currentProvider = computed(() => currentSelection.value.providerId)

const currentModel = computed(() => currentSelection.value.model)

const cachedModelInfo = computed<OpenRouterModel | undefined>(() => {
  if (!currentProvider.value || !currentModel.value) return undefined
  return settingsStore
    .getCachedModels(currentProvider.value)
    .find((model) => model.id === currentModel.value)
})

const codexMetadata = computed<CodexModelMetadata>(() => {
  return (cachedModelInfo.value?.providerMetadata?.codex ?? {}) as CodexModelMetadata
})

const isCodexProvider = computed(() => currentProvider.value === 'codex')

const customProviderApiType = computed<'openai' | 'anthropic' | null>(() => {
  const id = currentProvider.value
  if (!id?.startsWith('custom-')) return null
  const custom = settingsStore.settings?.ai?.customProviders?.find((entry) => entry.id === id)
  return custom?.apiType ?? 'openai'
})

// Single source of truth: the model-capability ledger. Same resolver the
// engine uses — no local pattern lists.
const resolvedCapabilities = computed(() => {
  if (!currentProvider.value || !currentModel.value) return null
  const providerConfig = settingsStore.settings?.ai?.providers?.[currentProvider.value]
  return resolveOnethingModelCapabilities({
    providerId: currentProvider.value,
    modelId: currentModel.value,
    customApiType: customProviderApiType.value ?? undefined,
    override: providerConfig?.modelCapabilitiesByModel?.[currentModel.value],
    registryEntry: providerConfig?.models?.[currentModel.value],
    modelMetadata: cachedModelInfo.value,
  })
})

const isNativeThinkingModel = computed(() => {
  const resolved = resolvedCapabilities.value
  if (!resolved?.reasoning) return false
  const profile = resolved.reasoningProfile
  // Always-thinking models with no knob (kimi k2-code, deepseek-reasoner)
  // expose nothing to configure — hide the control (or fall through to the
  // legacy model-pair toggle below).
  return !!profile && (profile.toggleable || profile.efforts.length > 0)
})

// What the provider does when nothing is configured comes from the ledger's
// profile (e.g. Claude only defaults on for Sonnet 5 / Fable; DeepSeek V4
// only thinks when explicitly enabled).
const defaultThinkingOn = computed(
  () => resolvedCapabilities.value?.reasoningProfile?.defaultOn ?? true,
)

const nativeThinkingEnabled = computed(() => {
  // Models whose reasoning cannot be turned off (o-series, grok, fable)
  // always count as thinking, regardless of any stored toggle.
  if (resolvedCapabilities.value?.reasoningProfile?.toggleable === false) return true
  const map =
    settingsStore.settings?.ai?.providers?.[currentProvider.value]?.thinkingByModel
  const stored = map?.[currentModel.value]
  if (typeof stored === 'boolean') return stored
  return defaultThinkingOn.value
})

const pair = computed(() => {
  if (isNativeThinkingModel.value) return null
  return THINKING_PAIRS[currentProvider.value] || null
})

const visible = computed(() => isNativeThinkingModel.value || !!pair.value)

const thinking = computed(() => {
  if (isNativeThinkingModel.value) return nativeThinkingEnabled.value
  if (!pair.value) return false
  return currentModel.value === pair.value.thinking
})

const codexEffortOptions = computed<EffortOption[]>(() => {
  const levels = codexMetadata.value.supportedReasoningEfforts
  if (!Array.isArray(levels) || levels.length === 0) {
    return CODEX_FALLBACK_EFFORT_OPTIONS
  }

  const seen = new Set<ThinkingEffort>()
  const options: EffortOption[] = []
  for (const level of levels) {
    const value = normalizeEffort(level.effort ?? level.reasoningEffort ?? level.reasoning_effort ?? level.value ?? level.name)
    if (!value || value === 'max' || seen.has(value)) continue
    seen.add(value)
    options.push({
      value,
      label: EFFORT_LABELS[value],
      description: typeof level.description === 'string' ? level.description : undefined,
    })
  }
  return options.length > 0 ? options : CODEX_FALLBACK_EFFORT_OPTIONS
})

const effortOptions = computed<EffortOption[]>(() => {
  // Codex keeps its provider-direct metadata source (supportedReasoningEfforts);
  // every other provider's levels come from the capability ledger's profile.
  if (isCodexProvider.value) return codexEffortOptions.value
  const profile = resolvedCapabilities.value?.reasoningProfile
  if (!profile) return []
  // `'none'` is in the ledger's effort list as a WIRE capability marker
  // (gpt-5.1+ takes `reasoning_effort: 'none'`), not as a picker rung — the
  // stored `thinkingEffortByModel` vocabulary is `ThinkingEffort`, which has no
  // such value. The provider turns a thinking-off intent into it; the picker
  // keeps offering exactly the rungs it offered before.
  return profile.efforts
    .filter((value): value is ThinkingEffort => value !== 'none')
    .map(value => ({ value, label: EFFORT_LABELS[value] }))
})

const defaultEffort = computed<ThinkingEffort>(() => {
  if (isCodexProvider.value) {
    const metadataDefault = normalizeEffort(codexMetadata.value.defaultReasoningEffort)
    return metadataDefault && metadataDefault !== 'max' ? metadataDefault : 'medium'
  }
  return resolvedCapabilities.value?.reasoningProfile?.defaultEffort ?? 'high'
})

const currentEffort = computed<ThinkingEffort>(() => {
  const map =
    settingsStore.settings?.ai?.providers?.[currentProvider.value]?.thinkingEffortByModel
  const stored = normalizeEffort(map?.[currentModel.value])
  const mapped = isCodexProvider.value && stored === 'max' ? 'high' : stored
  const allowed = effortOptions.value.some((option) => option.value === mapped)
  if (mapped && allowed) return mapped
  return defaultEffort.value
})

const currentEffortLabel = computed(() => {
  return effortOptions.value.find((option) => option.value === currentEffort.value)?.label
    ?? EFFORT_LABELS[currentEffort.value]
})

const codexServiceTierOptions = computed<ServiceTierOption[]>(() => {
  if (!isCodexProvider.value) return []
  const tiers = codexMetadata.value.serviceTiers
  if (!Array.isArray(tiers) || tiers.length === 0) return []

  const seen = new Set<string>()
  const options: ServiceTierOption[] = []
  for (const tier of tiers) {
    const value = typeof tier === 'string' ? tier : tier.id ?? tier.value ?? tier.name
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    const label = typeof tier !== 'string'
      ? tier.label ?? tier.name ?? titleCaseServiceTier(trimmed)
      : titleCaseServiceTier(trimmed)
    options.push({
      value: trimmed,
      label,
      description: typeof tier !== 'string' ? tier.description : undefined,
    })
  }
  return options
})

const currentServiceTier = computed<string | null>(() => {
  if (!isCodexProvider.value) return null
  const map =
    settingsStore.settings?.ai?.providers?.[currentProvider.value]?.serviceTierByModel
  const value = map?.[currentModel.value]?.trim()
  if (!value || value.toLowerCase() === 'auto') return null
  return value
})

const currentServiceTierLabel = computed(() => {
  if (!currentServiceTier.value) return null
  return codexServiceTierOptions.value.find((option) => option.value === currentServiceTier.value)?.label
    ?? titleCaseServiceTier(currentServiceTier.value)
})

const currentSelectionLabel = computed(() => {
  const thinkingLabel = !thinking.value
    ? 'Off'
    : isNativeThinkingModel.value && effortOptions.value.length > 0
      ? currentEffortLabel.value
      : 'On'
  return currentServiceTierLabel.value
    ? `${thinkingLabel} · ${currentServiceTierLabel.value}`
    : thinkingLabel
})

const thinkSelectStyle = computed<StyleValue>(() => ({
  '--think-select-width': `${thinkSelectWidth(currentSelectionLabel.value)}px`,
}))

const selectionActive = computed(() => thinking.value || !!currentServiceTier.value)

const speedOptions = computed<ThinkOption[]>(() => {
  if (!isCodexProvider.value) return []
  const serviceOptions = codexServiceTierOptions.value
  if (serviceOptions.length === 0 && !currentServiceTier.value) return []
  const hasCurrentTier = serviceOptions.some((option) => option.value === currentServiceTier.value)
  return [
    { kind: 'speed', value: null, label: 'Auto' },
    ...serviceOptions.map((option) => ({
      kind: 'speed' as const,
      value: option.value,
      label: option.label,
      description: option.description,
    })),
    ...(currentServiceTier.value && !hasCurrentTier
      ? [{
        kind: 'speed' as const,
        value: currentServiceTier.value,
        label: titleCaseServiceTier(currentServiceTier.value),
      }]
      : []),
  ]
})

const tooltipText = computed(() => {
  if (!currentModel.value) return isCodexProvider.value ? 'Choose thinking and speed' : 'Choose thinking mode'
  return isCodexProvider.value
    ? `Choose thinking and speed for ${currentModel.value}`
    : `Choose thinking mode for ${currentModel.value}`
})

const thinkingOptions = computed<ThinkOption[]>(() => {
  // No Off for models whose reasoning cannot be disabled (o-series, grok,
  // fable) — offering one would silently do nothing.
  const offOptions: ThinkOption[] =
    resolvedCapabilities.value?.reasoningProfile?.toggleable === false
      ? []
      : [{ kind: 'off', label: 'Off' }]
  if (isNativeThinkingModel.value && effortOptions.value.length > 0) {
    return [
      ...offOptions,
      ...effortOptions.value.map((option) => ({ kind: 'effort' as const, ...option })),
    ]
  }
  return [
    ...offOptions,
    { kind: 'on', label: 'On' },
  ]
})

const optionGroups = computed<ThinkOptionGroup[]>(() => {
  const groups: ThinkOptionGroup[] = [
    { key: 'thinking', label: 'Thinking', options: thinkingOptions.value },
  ]
  if (speedOptions.value.length > 0) {
    groups.push({ key: 'speed', label: 'Speed', options: speedOptions.value })
  }
  return groups
})

const flatOptions = computed<ThinkOption[]>(() => optionGroups.value.flatMap((group) => group.options))

const thinkingSelectValue = computed(() => `current:${currentSelectionLabel.value}`)

const thinkSelectOptions = computed<SelectOptionLike[]>(() => {
  return optionGroups.value.map((group) => ({
    label: group.label,
    options: group.options.map(toThinkSelectOption),
  }))
})

function normalizeEffort(value: unknown): ThinkingEffort | null {
  if (
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  ) {
    return value
  }
  return null
}

function titleCaseServiceTier(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ') || value
}

function thinkSelectWidth(label: string): number {
  const text = label.trim() || 'Off'
  const visualLength = Array.from(text).reduce((total, char) => {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char)) return total + 1.7
    if (/[A-Z0-9]/.test(char)) return total + 1.05
    if (/[-_./·]/.test(char)) return total + 0.65
    if (char === ' ') return total + 0.45
    return total + 0.9
  }, 0)

  return Math.round(Math.max(92, Math.min(240, 62 + visualLength * 7.2)))
}

function optionKey(option: ThinkOption): string {
  if (option.kind === 'effort') return `effort-${option.value}`
  if (option.kind === 'speed') return `speed-${option.value ?? 'auto'}`
  return option.kind
}

function isOptionSelected(option: ThinkOption): boolean {
  if (option.kind === 'off') return !thinking.value
  if (option.kind === 'on') {
    return thinking.value
      && (!isNativeThinkingModel.value || effortOptions.value.length === 0)
  }
  if (option.kind === 'speed') return option.value === currentServiceTier.value
  return thinking.value && currentEffort.value === option.value
}

function toThinkSelectOption(option: ThinkOption): ThinkSelectOption {
  return {
    value: optionKey(option),
    label: option.label,
    description: option.description,
    option,
  }
}

function asThinkSelectOption(option: SelectOptionLike): ThinkSelectOption | null {
  if (!option || typeof option !== 'object' || Array.isArray(option)) return null
  const candidate = option as Partial<ThinkSelectOption>
  if (!candidate.option || typeof candidate.label !== 'string') return null
  return candidate as ThinkSelectOption
}

function thinkOptionLabel(option: SelectOptionLike): string {
  return asThinkSelectOption(option)?.label || ''
}

function thinkOptionDescription(option: SelectOptionLike): string {
  return asThinkSelectOption(option)?.description || ''
}

function isThinkSelectOptionSelected(option: SelectOptionLike): boolean {
  const selectOption = asThinkSelectOption(option)
  return selectOption ? isOptionSelected(selectOption.option) : false
}

async function handleThinkSelect(value: SelectModelValue): Promise<void> {
  if (Array.isArray(value) || typeof value !== 'string') return
  const option = flatOptions.value.find((item) => optionKey(item) === value)
  if (!option) return
  await selectOption(option)
}

async function selectOption(option: ThinkOption): Promise<void> {
  if (option.kind === 'off') {
    await setThinkingEnabled(false)
  } else if (option.kind === 'on') {
    await setThinkingEnabled(true)
  } else if (option.kind === 'speed') {
    await setCodexServiceTier(option.value)
  } else {
    await setNativeThinkingEffort(option.value)
  }
}

async function setThinkingEnabled(enabled: boolean): Promise<void> {
  if (isNativeThinkingModel.value) {
    await setNativeThinkingEnabled(enabled)
    return
  }
  if (pair.value) {
    await setLegacyPairThinking(enabled)
  }
}

async function setNativeThinkingEnabled(enabled: boolean, effort?: ThinkingEffort): Promise<void> {
  const provider = currentProvider.value as AIProvider
  const model = currentModel.value
  if (!provider || !model) return

  await settingsStore.updateProviderThinking(provider, model, {
    enabled,
    ...(effort
      ? { effort: isCodexProvider.value && effort === 'max' ? 'high' as const : effort }
      : {}),
  })
}

async function setNativeThinkingEffort(effort: ThinkingEffort): Promise<void> {
  await setNativeThinkingEnabled(true, effort)
}

async function setCodexServiceTier(serviceTier: string | null): Promise<void> {
  const provider = currentProvider.value as AIProvider
  const model = currentModel.value
  if (provider !== 'codex' || !model) return

  await settingsStore.updateProviderThinking(provider, model, { serviceTier })
}

async function setLegacyPairThinking(enabled: boolean): Promise<void> {
  if (!pair.value) return

  const target = enabled ? pair.value.thinking : pair.value.normal
  const provider = currentProvider.value as AIProvider

  // **会话置顶先落**:它是这次点击的主语(「这条会话用 thinking 档」),而
  // 「顺手把空间默认也改了」是副产物。反过来写的话,一次 overlay 落盘失败/挂起
  // 就会把会话那一格一起卡住 —— 用户点了没反应,而他要的那件事根本不依赖它。
  const sid = props.sessionId || sessionsStore.currentSessionId
  if (sid) {
    await sessionsStore.updateSessionModel(sid, provider, target)
  }

  // 改默认永远写当前空间的 overlay(C1),与 ModelSelector.selectOption 同一条。
  await spaceView.setDefaultSelection(provider, target)
}
</script>

<style scoped>
.thinking-control {
  --think-accent: var(--ui-message-thinking-fg);
  --think-accent-border: color-mix(in srgb, var(--think-accent) 50%, transparent);
  --think-accent-bg: color-mix(in srgb, var(--think-accent) 10%, transparent);
  --think-accent-bg-strong: color-mix(in srgb, var(--think-accent) 18%, transparent);

  display: inline-flex;
  align-items: center;
  min-width: 0;
  flex: 0 0 auto;
}

.think-select {
  width: var(--think-select-width, 112px);
}

/* Ghost control: resident ~4% surface signals "clickable" without a
   border; hover raises to full hover strength. */
.think-select :deep(.app-select-control) {
  min-height: 28px;
  padding: 3px 7px 3px 9px;
  border-radius: 7px;
  border-color: transparent;
  background: color-mix(in srgb, var(--ui-state-hover-bg) 45%, transparent);
  color: var(--ui-text-muted-fg);
}

.think-select :deep(.app-select-control:hover),
.think-select.is-open :deep(.app-select-control) {
  color: var(--ui-text-primary-fg);
  border-color: transparent;
  background: var(--ui-state-hover-bg);
  box-shadow: none;
}

/* Suppress the base Select :focus styles — the think toggle is a subtle
   text label, not a form input.  Its hover / is-open affordances are
   enough; a lingering focus ring after click looks stuck. */
.think-select :deep(.app-select-control:focus-visible),
.think-select :deep(.app-select-control:focus-visible) {
  color: var(--ui-text-muted-fg);
  border-color: transparent;
  background: color-mix(in srgb, var(--ui-state-hover-bg) 45%, transparent);
  box-shadow: none;
}

.think-select.active :deep(.app-select-control) {
  color: var(--ui-text-primary-fg);
  border-color: transparent;
  background: color-mix(in srgb, var(--ui-state-hover-bg) 45%, transparent);
}

.think-select.active :deep(.app-select-control:hover),
.think-select.active.is-open :deep(.app-select-control) {
  background: var(--ui-state-hover-bg);
}

.think-select :deep(.app-select-single-value),
.think-value {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-primary-fg);
  font-size: 12px;
  font-weight: 520;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.think-select:not(.active) .think-value {
  color: var(--ui-text-muted-fg);
}

.think-option-row {
  min-width: 0;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
}

.think-option-main {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.think-option-text,
.think-option-description {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.think-option-text {
  font-size: 12px;
  font-weight: 600;
}

.think-option-description {
  color: var(--ui-text-muted-fg);
  font-size: 10.5px;
}

.think-option-check {
  flex: 0 0 auto;
  color: var(--ui-accent-primary-fg);
}
</style>

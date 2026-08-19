<template>
  <div
    ref="selectorRef"
    class="model-selector"
    :class="{ compact: isCompact }"
    @click.stop
  >
    <button
      ref="triggerRef"
      type="button"
      class="model-trigger"
      :class="{ 'is-open': open }"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-label="displayName || 'Select model'"
      @click="toggleFlyout"
    >
      <ProviderIcon
        v-if="isCompact"
        :provider="currentProvider"
        :size="16"
      />
      <span
        v-else
        class="model-text"
      >{{ displayName }}</span>
      <ChevronDown
        v-if="!isCompact"
        class="model-trigger-caret"
        :size="11"
        :stroke-width="2"
      />
    </button>

    <!-- Geometry comes from the floating kernel (P1); this component only says
         what the layer hangs off. The anchor is the COMPOSER box, not the chip:
         the flyout has always spanned the composer's full width 9px above its
         top edge (it used to be a Teleport into `.composer-anchor` carrying
         `left:0; right:0; bottom:calc(100% + 9px)`), because the toolbar cell it
         is triggered from clips (`.toolbar-left` is overflow:hidden). Anchoring
         the kernel to that same box with `width: 'anchor'` reproduces the old
         coordinates exactly and adds flip / viewport clamping / scroll tracking.
         Slot content stays in this component's style scope. -->
    <Popover
      :open="open"
      v-bind="flyoutPopover"
      @update:open="value => value || closeFlyout()"
      @close="handleFlyoutClose"
    >
      <ComposerExtensionPanel
        floating
        :visible="open"
        :placement="placement"
        class="model-flyout"
        title="Model"
        :count="filteredCount"
        empty-text="No models found"
        empty-hint="Pick models per provider in Settings"
      >
        <template #subheader>
          <div class="model-flyout-search">
            <SearchIcon
              :size="12"
              :stroke-width="2"
            />
            <input
              ref="searchRef"
              v-model="query"
              type="text"
              placeholder="Search models…"
              spellcheck="false"
              aria-label="Search models"
              @input="focusIdx = 0"
              @keydown="handleSearchKeydown"
            >
          </div>
          <div
            class="model-flyout-providers"
            role="tablist"
            aria-label="Providers"
          >
            <button
              type="button"
              class="provider-cell"
              :class="{ on: providerFilter === 'all' }"
              @click="setProviderFilter('all')"
            >
              All<span class="provider-cell-count">{{ totalModelCount }}</span>
            </button>
            <button
              v-for="provider in visibleProviders"
              :key="provider.id"
              type="button"
              class="provider-cell"
              :class="{ on: providerFilter === provider.id }"
              @click="setProviderFilter(provider.id)"
            >
              {{ providerLabel(provider) }}<span class="provider-cell-count">{{ providerOptions.get(provider.id)?.length || 0 }}</span>
            </button>
          </div>
        </template>

        <div
          ref="listRef"
          class="model-flyout-list"
          role="listbox"
          aria-label="Models"
        >
          <template
            v-for="group in filteredGroups"
            :key="group.providerId"
          >
            <div
              v-if="providerFilter === 'all'"
              class="model-group-label"
              aria-hidden="true"
            >
              <span>{{ group.providerName }}</span>
              <span class="model-group-rule" />
            </div>
            <div
              v-for="entry in group.options"
              :key="`${group.providerId}:${entry.option.modelId}`"
              class="model-row"
              :class="{ current: isCurrent(entry.option), focused: entry.index === focusIdx }"
              :data-model-index="entry.index"
              role="option"
              :aria-selected="isCurrent(entry.option)"
              @click="selectOption(entry.option)"
              @mouseenter="focusIdx = entry.index"
            >
              <span
                class="model-dot"
                aria-hidden="true"
              />
              <span class="model-main">
                <span class="model-line">
                  <span class="model-name">{{ entry.option.modelName }}</span>
                  <span
                    v-if="entry.option.modelId !== entry.option.modelName"
                    class="model-id"
                  >{{ entry.option.modelId }}</span>
                  <span
                    v-if="formatContext(entry.option.contextLength)"
                    class="model-context"
                  >{{ formatContext(entry.option.contextLength) }}</span>
                </span>
                <span
                  v-if="entry.option.capabilities.length"
                  class="model-badges"
                >
                  <span
                    v-for="capability in entry.option.capabilities"
                    :key="capability"
                    class="model-badge"
                  >{{ capability }}</span>
                </span>
              </span>
            </div>
          </template>
        </div>
      </ComposerExtensionPanel>
    </Popover>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ChevronDown, Search as SearchIcon } from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import { useSpaceProviderView } from '@/composables/useSpaceProviderView'
import { useSessionsStore } from '@/stores/sessions'
import type { AIProvider, OpenRouterModel } from '@shared/ipc'
import { providerFamilyDisplayName } from '@shared/provider-families'
import ProviderIcon from '../settings/ProviderIcon.vue'
import ComposerExtensionPanel from './ComposerExtensionPanel.vue'
import Popover from '@/components/common/Popover.vue'
import type { FloatingCloseReason } from '@/composables/floating/useFloatingLayer'
import type { ComputedPosition } from '@/composables/floating/compute-position'
import { resolveProviderModelSelection } from '@/stores/helpers/provider-model'
import { useSessionAgentModel } from '@/composables/useSessionAgentModel'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.model-selector')

interface Props {
  sessionId?: string
}

interface ModelPickerOption {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  description?: string
  contextLength: number
  capabilities: string[]
}

const props = defineProps<Props>()

const settingsStore = useSettingsStore()

/**
 * 「当前空间的 provider 视图」(批 B7)。模型选择器只列**这个空间配好的** provider,
 * 模型清单也按空间取 —— 切 workspace 就自动切过去,不需要用户再填一张表。
 * 默认空间下这一支恒等于今天的行为(视图内部落回 settings.ai),零回归。
 */
const spaceView = useSpaceProviderView({
  settings: () => settingsStore.settings,
  providers: () => settingsStore.availableProviders || [],
})
const sessionsStore = useSessionsStore()

const selectorRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const composerAnchorEl = ref<HTMLElement | null>(null)
const isCompact = ref(false)
let resizeObserver: ResizeObserver | null = null

const open = ref(false)
const query = ref('')
const providerFilter = ref<'all' | string>('all')
const focusIdx = ref(0)
const placement = ref<'up' | 'down'>('up')

/** The gap the flyout has always kept from the composer's top edge. */
const FLYOUT_GAP = 9

/**
 * Everything about *where* the layer lands is the kernel's (ui-system.md §1);
 * what stays here is which box it hangs off and how wide it is.
 */
const flyoutPopover = computed(() => ({
  // `.composer-anchor` is the real anchor — see the template comment. The chip
  // is only the fallback for mounts that have no composer around them.
  anchor: composerAnchorEl.value ?? selectorRef.value,
  placement: 'top-start' as const,
  offset: FLYOUT_GAP,
  // Full composer width, exactly as `left: 0; right: 0` used to give.
  width: 'anchor' as const,
  // The panel draws its own notched frame and shadow; a second surface under
  // it would double the border.
  surface: false,
  // Same stop as before the migration: a composer flyout is dropdown +1
  // (ComposerExtensionPanel's own rule), under InputBox's +2 command toast.
  zOffset: 1,
  // `scroll: false` = follow the scroll, do not dismiss on it.
  closeOn: { esc: true, outside: true, scroll: false },
  onPositioned: onFlyoutPositioned,
}))

/** Fires on every (re)placement — open, scroll, resize, content resize. */
function onFlyoutPositioned(position: ComputedPosition): void {
  // The panel grows out of the composer edge, so it needs to know which way it
  // went once the kernel flips it.
  placement.value = position.side === 'top' ? 'up' : 'down'
}

function handleFlyoutClose(reason: FloatingCloseReason) {
  // Esc hands the caret back to the control it came from; an outside click has
  // already put focus somewhere the user chose.
  if (reason === 'esc') triggerRef.value?.focus()
}

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
  // 批 B9:会话/agent 都没表达过选择时,先问当前空间的默认再落全局。
  spaceDefault: spaceView.spaceDefault.value,
}))

const currentProvider = computed(() => (currentSelection.value.providerId || 'claude') as AIProvider)

const currentModel = computed(() => currentSelection.value.model)

const displayName = computed(() => {
  if (!currentModel.value) return 'Select model'
  return settingsStore.getModelDisplayName(currentModel.value)
})

const visibleProviders = computed(() => {
  const settings = settingsStore.settings
  const providers = settingsStore.availableProviders || []
  if (!settings?.ai?.providers) return []

  return providers.filter((provider) => {
    const config = settings.ai.providers[provider.id]
    const isCurrent = provider.id === currentProvider.value
    const isCustom = settingsStore.isCustomProvider(provider.id)
    const selectedModels = spaceView.selectedModelsOf(provider.id)
    const customDefaultModel = isCustom ? config?.model : ''
    const hasModels = selectedModels.length > 0 || (isCurrent && !!currentModel.value) || !!customDefaultModel
    // 「这个空间配了凭证没有」——没配的 provider 列出来只会让用户选中一个
    // 起不了流的模型。**C1 起 default 也过这道闸**(方案 §2):它是默认空间
    // 唯一有意的可见变化 —— 配了模型没配 key 的 provider 从选择器消失,而它
    // 本来就发不出去。
    const usableHere = spaceView.isConfigured(provider.id)
    // 批 B9:开关也 per-space —— 视图内部仍走 `isProviderEnabledIn`(家族派生
    // 不能在调用点各写一遍),只是多接了空间覆盖这一层读取源。
    return spaceView.isProviderEnabled(provider.id) && hasModels && usableHere
  })
})

const providerOptions = computed(() => {
  const map = new Map<string, ModelPickerOption[]>()
  for (const provider of visibleProviders.value) {
    map.set(provider.id, buildProviderModelOptions(provider.id, providerLabel(provider)))
  }
  return map
})

const totalModelCount = computed(() => {
  let total = 0
  for (const options of providerOptions.value.values()) total += options.length
  return total
})

const filteredGroups = computed(() => {
  const normalized = query.value.trim().toLowerCase()
  let index = 0
  return visibleProviders.value
    .filter(provider => providerFilter.value === 'all' || provider.id === providerFilter.value)
    .map(provider => ({
      providerId: provider.id,
      providerName: providerLabel(provider),
      options: (providerOptions.value.get(provider.id) || [])
        .filter(option => matchesQuery(option, normalized))
        .map(option => ({ option, index: index++ })),
    }))
    .filter(group => group.options.length > 0)
})

const filteredFlat = computed(() => filteredGroups.value.flatMap(group => group.options.map(entry => entry.option)))

const filteredCount = computed(() => filteredFlat.value.length)

watch(
  currentProvider,
  (provider) => {
    if (!provider) return
    void loadModelsForProvider(provider)
  },
  { immediate: true },
)

/** ErrorCard "切换模型…" dispatches this event; scroll into view, pulse, open. */
function handleOpenModelSelectorEvent(event: Event) {
  const detail = (event as CustomEvent<{ sessionId?: string }>).detail
  if (detail?.sessionId && props.sessionId && detail.sessionId !== props.sessionId) return
  const el = selectorRef.value
  if (!el) return
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  el.classList.remove('attention-pulse')
  // restart the animation on repeated clicks
  void el.offsetWidth
  el.classList.add('attention-pulse')
  if (!open.value) void openFlyout()
  window.setTimeout(() => el.classList.remove('attention-pulse'), 1600)
}

function checkCompactMode() {
  if (!selectorRef.value) return

  const parent = selectorRef.value.closest('.toolbar-left') as HTMLElement | null
  if (!parent) {
    isCompact.value = window.innerWidth < 550
    return
  }

  const parentRect = parent.getBoundingClientRect()
  const siblings = Array.from(parent.children) as HTMLElement[]
  const usedWidth = siblings
    .filter((sibling) => sibling !== selectorRef.value)
    .reduce((total, sibling) => total + sibling.getBoundingClientRect().width + 4, 0)

  isCompact.value = parentRect.width - usedWidth < 120
}

onMounted(() => {
  // The box the flyout is glued to — the same one the command/file/path pickers
  // hang off. Without one (isolated mounts, tests) the chip is the fallback.
  composerAnchorEl.value = selectorRef.value?.closest('.composer-anchor') as HTMLElement | null

  checkCompactMode()

  const parent = selectorRef.value?.closest('.toolbar-left')
  if (parent) {
    resizeObserver = new ResizeObserver(checkCompactMode)
    resizeObserver.observe(parent)
  }

  window.addEventListener('resize', checkCompactMode)
  window.addEventListener('onething:open-model-selector', handleOpenModelSelectorEvent)
  composerAnchorEl.value?.addEventListener('mousedown', handleComposerMousedown)
})

onUnmounted(() => {
  window.removeEventListener('resize', checkCompactMode)
  window.removeEventListener('onething:open-model-selector', handleOpenModelSelectorEvent)
  composerAnchorEl.value?.removeEventListener('mousedown', handleComposerMousedown)
  resizeObserver?.disconnect()
  resizeObserver = null
})

function providerLabel(provider: { id: string; name: string }): string {
  return providerFamilyDisplayName(provider.id, provider.name)
}

function buildProviderModelOptions(providerId: string, providerName: string): ModelPickerOption[] {
  const config = settingsStore.settings?.ai?.providers?.[providerId]
  const ids = [...spaceView.selectedModelsOf(providerId)]

  if (providerId === currentProvider.value && currentModel.value && !ids.includes(currentModel.value)) {
    ids.unshift(currentModel.value)
  }

  if (settingsStore.isCustomProvider(providerId) && config?.model && !ids.includes(config.model)) {
    ids.unshift(config.model)
  }

  const cachedModels = settingsStore.getCachedModels(providerId)
  return ids.map((id) => {
    const model = cachedModels.find((item) => item.id === id)
    const modelName = settingsStore.getModelDisplayName(id) || model?.name || id
    return {
      providerId,
      providerName,
      modelId: id,
      modelName,
      description: model?.description,
      contextLength: model?.context_length || 0,
      capabilities: capabilityLabels(providerId, model),
    }
  })
}

function matchesQuery(option: ModelPickerOption, normalized: string): boolean {
  if (!normalized) return true
  return [
    option.modelName,
    option.modelId,
    option.providerName,
    option.description || '',
    ...option.capabilities,
  ].some((part) => part.toLowerCase().includes(normalized))
}

function isCurrent(option: ModelPickerOption): boolean {
  return option.providerId === currentProvider.value && option.modelId === currentModel.value
}

function formatContext(length: number): string {
  if (!length) return ''
  if (length >= 1000000) return `${(length / 1000000).toFixed(1)}M`
  if (length >= 1000) return `${Math.round(length / 1000)}K`
  return String(length)
}

function toggleFlyout() {
  if (open.value) {
    closeFlyout()
  } else {
    void openFlyout()
  }
}

async function openFlyout() {
  open.value = true
  query.value = ''
  providerFilter.value = 'all'
  for (const provider of visibleProviders.value) {
    void loadModelsForProvider(provider.id)
  }
  await nextTick()
  const currentIndex = filteredFlat.value.findIndex(isCurrent)
  focusIdx.value = currentIndex >= 0 ? currentIndex : 0
  scrollFocusedIntoView()
  searchRef.value?.focus()
}

function closeFlyout() {
  open.value = false
}

function setProviderFilter(filter: 'all' | string) {
  providerFilter.value = filter
  focusIdx.value = 0
  searchRef.value?.focus()
}

function cycleProviderFilter(backwards: boolean) {
  const order: Array<'all' | string> = ['all', ...visibleProviders.value.map(provider => provider.id)]
  const current = order.indexOf(providerFilter.value)
  const next = (current + (backwards ? order.length - 1 : 1)) % order.length
  setProviderFilter(order[next])
}

async function selectOption(option: ModelPickerOption) {
  closeFlyout()

  // **会话置顶先落**(与 ThinkToggle 同一条):它是这次点击的主语,而「顺手把
  // 空间默认也改了」是副产物 —— 一次 overlay 落盘失败不该把它一起卡住。
  const effectiveSessionId = props.sessionId || sessionsStore.currentSessionId
  if (effectiveSessionId) {
    await sessionsStore.updateSessionModel(effectiveSessionId, option.providerId, option.modelId)
  }

  // 「改默认」永远写**当前空间的 overlay**(C1)。批 B9 时 default 走的是
  // `saveAIProviderDefault`(settings.ai),那条支路正是「默认模型不独立」的病根。
  await spaceView.setDefaultSelection(option.providerId, option.modelId)
}

function handleSearchKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    focusIdx.value = Math.min(focusIdx.value + 1, filteredFlat.value.length - 1)
    scrollFocusedIntoView()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    focusIdx.value = Math.max(focusIdx.value - 1, 0)
    scrollFocusedIntoView()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const option = filteredFlat.value[focusIdx.value]
    if (option) void selectOption(option)
  } else if (event.key === 'Tab') {
    event.preventDefault()
    cycleProviderFilter(event.shiftKey)
  }
}

function scrollFocusedIntoView() {
  void nextTick(() => {
    const row = listRef.value?.querySelector<HTMLElement>(`[data-model-index="${focusIdx.value}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  })
}

/* The kernel dismisses presses that land outside the layer AND outside its
   anchor — and the anchor here is the whole composer box, so to the kernel a
   press on the editor or on a neighbouring toolbar picker reads as "inside".
   Those must still dismiss: the picker is a transient overlay on the composer,
   not a second panel to stack beside. This listener is bound to the composer
   itself (the flyout is teleported to body, so its own presses never reach it)
   and covers exactly the half the kernel cannot see; the chip keeps its toggle. */
function handleComposerMousedown(event: MouseEvent) {
  if (!open.value) return
  const target = event.target as Node | null
  if (target && selectorRef.value?.contains(target)) return
  closeFlyout()
}

async function loadModelsForProvider(providerId: string) {
  try {
    await settingsStore.fetchModelsForProvider(providerId)
  } catch (error) {
    log.warn('provider models load failed', {}, error)
  }
}

function capabilityLabels(providerId: string, model?: OpenRouterModel): string[] {
  if (providerId === 'codex' && !model) {
    return ['Tools', 'Reasoning', 'Image input', 'Image generation']
  }

  const labels: string[] = []
  const codexMetadata = model?.providerMetadata?.codex as Record<string, unknown> | undefined

  if (model?.supported_parameters?.includes('tools') || !!codexMetadata) {
    labels.push('Tools')
  }
  if (
    model?.supported_parameters?.includes('reasoning') ||
    Array.isArray(codexMetadata?.supportedReasoningEfforts) ||
    codexMetadata?.supportsReasoningSummaries === true
  ) {
    labels.push('Reasoning')
  }
  if (model?.architecture?.input_modalities?.includes('image')) {
    labels.push('Image input')
  }
  if (model?.architecture?.output_modalities?.includes('image')) {
    labels.push('Image output')
  }
  if (Array.isArray(codexMetadata?.nativeTools) && codexMetadata.nativeTools.includes('image_generation')) {
    labels.push('Image generation')
  }
  if (
    (Array.isArray(codexMetadata?.serviceTiers) && codexMetadata.serviceTiers.length > 0) ||
    (Array.isArray(codexMetadata?.additionalSpeedTiers) && codexMetadata.additionalSpeedTiers.length > 0)
  ) {
    labels.push('Speed')
  }

  return labels
}
</script>

<style scoped>
.model-selector {
  min-width: 0;
  display: flex;
  align-items: stretch;
}

.model-selector.attention-pulse {
  animation: model-selector-pulse 0.8s ease-out 2;
  border-radius: 8px;
}

@keyframes model-selector-pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--ui-border-focus-border) 55%, transparent);
  }
  100% {
    box-shadow: 0 0 0 6px transparent;
  }
}

/* Ghost control: resident ~4% surface signals "clickable" without a
   border; hover raises to full hover strength. The toolbar cell-fill
   rules in InputBox.vue stretch it edge-to-edge inside the toolbar. */
.model-trigger {
  min-width: 0;
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  border: none;
  border-radius: 6px;
  background: color-mix(in srgb, var(--ui-state-hover-bg) 45%, transparent);
  color: var(--ui-text-muted-fg);
  font: inherit;
  cursor: pointer;
  transition: color var(--duration-normal) var(--ease-default), background var(--duration-normal) var(--ease-default);
}

.model-trigger:hover,
.model-trigger.is-open {
  background: var(--ui-state-hover-bg);
  color: var(--ui-text-primary-fg);
}

/* Suppress the focus ring — the model cell is a subtle text label, not a
   form input; its hover / is-open affordances are enough. A lingering
   focus ring after click looks stuck. */
.model-trigger:focus-visible,
.model-trigger:focus-visible {
  outline: none;
}

.model-trigger-caret {
  flex-shrink: 0;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  transition: transform var(--duration-normal) var(--ease-default);
}

/* Compact trigger: the provider mark joins the ink palette — a full-color
   brand logo would be the only saturated pixel in the mono toolbar. */
.model-selector.compact .model-trigger :deep(svg) {
  filter: grayscale(1) contrast(1.1) opacity(0.75);
}

.model-trigger.is-open .model-trigger-caret {
  transform: rotate(180deg);
}

.model-text {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-primary-fg);
  font-size: 13px;
  font-weight: 520;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ————— MODEL flyout (Popover slot content — still this component's scope) ————— */

/* 画线风:方角,不用共享 shell 的 12px 圆角。 */
.model-flyout.composer-extension-panel {
  border-radius: 0;
}

.model-flyout :deep(.composer-extension-body) {
  max-height: min(304px, 40vh);
}

.model-flyout-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 0.5px solid var(--composer-extension-divider);
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

.model-flyout-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--ui-text-primary-fg);
  font-family: inherit;
  font-size: 12.5px;
}

.model-flyout-search input::placeholder {
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

/* Provider filter: 画线 tabs on the ruled line — the active tab draws an
   ink stroke over the row's own rule instead of filling the cell. */
.model-flyout-providers {
  display: flex;
  align-items: stretch;
  min-height: 28px;
  border-bottom: 0.5px solid var(--composer-extension-divider);
  overflow-x: auto;
  /* NO `scrollbar-width` here: in Chromium, setting the standard property
     disables ::-webkit-scrollbar styling entirely and resurrects the fat
     native bar. The hairline below is the whole affordance. */
}

/* Rest: invisible. Hovering the row surfaces a 3px ink hairline — enough
   "more tabs this way" without a resident chrome strip. */
.model-flyout-providers::-webkit-scrollbar {
  height: 3px;
}

.model-flyout-providers::-webkit-scrollbar-thumb {
  background: transparent;
}

.model-flyout-providers:hover::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--ui-border-strong-border) 55%, transparent);
}

.model-flyout-providers::-webkit-scrollbar-track {
  background: transparent;
}

.provider-cell {
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: var(--ui-text-muted-fg);
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default);
}

.provider-cell::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -0.5px;
  height: 1.5px;
  background: currentColor;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.provider-cell:hover {
  color: var(--ui-text-primary-fg);
}

.provider-cell:hover::after {
  opacity: 0.3;
}

.provider-cell.on {
  color: var(--ui-accent-primary-fg);
}

.provider-cell.on::after {
  opacity: 1;
}

.provider-cell-count {
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-weight: 500;
  letter-spacing: 0;
}

.model-flyout-list {
  display: flex;
  flex-direction: column;
}

.model-group-label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 3px;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  font-weight: 650;
  letter-spacing: 1.6px;
  text-transform: uppercase;
}

.model-group-rule {
  flex: 1;
  height: 1px;
  background: var(--composer-extension-divider);
}

/* 行语言(ui-system.md §1「列表行的两种状态不能是同一种记号」):
   面 register —— 瞬时态(hover / 键盘)与持久态(current)各走一条通道,
   靠 2px 呼吸缝把两块底色读开。缝写 2px 而不是 1px:列表是普通块容器,
   相邻行的纵向 margin 会合并取大值,写 1px 得到的就是 1px。
   圈点从此只说「哪一个在跑」,不再兼职说「手指着哪一行」—— 那是底色的活。 */
.model-row {
  /* 选中底只定义一次,下面「加深一档」贴着它写,两处数值不会各自漂移。 */
  --model-row-selected-bg: color-mix(in srgb, var(--ui-accent-primary-fg) 11%, transparent);

  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-height: 32px;
  /* 与 .composer-extension-row 同一套内缩:横向 4px 让底色块不贴框。 */
  margin: 2px 4px;
  padding: 6px 8px;
  border-radius: 3px;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default);
}

/* 键盘 active 与鼠标 hover 是同一视觉通道,所以挂在同一条规则上;
   `.focused` 由方向键与 mouseenter 共同写入,几何只在基类里。 */
.model-row:hover,
.model-row.focused {
  background: var(--ui-state-hover-bg);
}

.model-row.current {
  background: var(--model-row-selected-bg);
}

/* 指着一行「已经选中的」行。少了这条,选中行就是死区:`.current` 与
   `:hover` 同为 (0,2,0) 且写在后面,底色块会把 hover 整个吞掉(Select 的
   box 变体实测过)。做法是在选中底上加深一档,掺的是 --ui-text-primary-fg
   ——「往对立色调混」,浅色主题它是深的、深色主题它是浅的,两边都成立;
   单纯抬 accent 的 alpha 在深色主题里几乎不动。混色一律 in srgb:
   oklch 的 color-mix 在近中性色上会泛粉(模型选择器当年踩过)。 */
.model-row.current:hover,
.model-row.current.focused {
  background: color-mix(
    in srgb,
    var(--model-row-selected-bg) 92%,
    var(--ui-text-primary-fg)
  );
}

.model-dot {
  flex: 0 0 auto;
  box-sizing: border-box;
  width: 7px;
  height: 7px;
  margin-top: 4px;
  border: 1.5px solid var(--ui-accent-primary-fg);
  border-radius: 50%;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.model-row.current .model-dot {
  background: var(--ui-accent-primary-fg);
  opacity: 1;
}

.model-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.model-line {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.model-name {
  color: var(--ui-text-secondary-fg);
  font-size: 12.25px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color var(--duration-fast) var(--ease-default);
}

.model-row:hover .model-name,
.model-row.focused .model-name {
  color: var(--ui-text-primary-fg);
}

.model-row.current .model-name {
  color: var(--ui-accent-primary-fg);
  font-weight: 600;
}

.model-id {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-muted-fg);
  font-size: 10.5px;
  opacity: 0.75;
}

/* 侧栏注记:context 长度与能力 badge 都不再是药丸底色,
   一律 mono 小字大写(同 agent-row-meta 记号),用留白而非填色分隔。 */
.model-context {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.08em;
  line-height: 1.4;
}

/* Capabilities: wrapping (not truncation) keeps every badge visible at any
   composer width. */
.model-badges {
  display: flex;
  flex-wrap: wrap;
  column-gap: 10px;
  row-gap: 2px;
}

.model-badge {
  flex: 0 0 auto;
  white-space: nowrap;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  line-height: 1.4;
  text-transform: uppercase;
}

.model-row.current .model-badge {
  color: color-mix(in srgb, var(--ui-accent-primary-fg) 72%, var(--ui-text-muted-fg) 28%);
}
</style>

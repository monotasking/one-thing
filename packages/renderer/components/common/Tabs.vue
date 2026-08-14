<template>
  <component
    :is="as"
    ref="rootRef"
    class="app-tabs"
    :class="tabsClasses"
  >
    <div
      ref="tabNavRef"
      class="app-tabs-nav"
      role="tablist"
      :aria-orientation="isVertical ? 'vertical' : 'horizontal'"
    >
      <div
        ref="tabListRef"
        class="app-tabs-nav-scroll"
        :class="{
          'is-overflow-start': hasOverflowStart,
          'is-overflow-end': hasOverflowEnd,
        }"
        @scroll.passive="updateOverflowState"
      >
        <div
          v-for="tabPane in normalizedPanes"
          :id="getTabId(tabPane.uid)"
          :key="tabPane.uid"
          class="app-tabs-tab"
          :class="{
            'is-active': tabPane.active,
            'is-disabled': tabPane.disabled,
            'is-closable': isPaneClosable(tabPane),
          }"
          role="tab"
          :tabindex="getPaneTabIndex(tabPane)"
          :aria-selected="tabPane.active ? 'true' : 'false'"
          :aria-controls="getPanelId(tabPane.uid)"
          :aria-disabled="tabPane.disabled ? 'true' : undefined"
          :data-pane-index="tabPane.index"
          :data-active="tabPane.active ? 'true' : undefined"
          @click="handleTabClick(tabPane, $event)"
          @keydown="handleTabKeydown($event, tabPane)"
        >
          <span class="app-tabs-tab-label">
            <TabLabel :pane="tabPane" />
          </span>

          <Tooltip
            v-if="isPaneClosable(tabPane)"
            :text="`Close ${tabPane.label || tabPane.name}`"
          >
            <button
              class="app-tabs-close"
              type="button"
              :aria-label="`Close ${tabPane.label || tabPane.name}`"
              @click.stop="handleTabRemove(tabPane.name)"
            >
              <X
                :size="13"
                :stroke-width="2"
                aria-hidden="true"
              />
            </button>
          </Tooltip>
        </div>
      </div>

      <div
        v-if="canAdd || $slots.actions"
        class="app-tabs-nav-actions"
      >
        <Tooltip
          v-if="canAdd"
          text="Add tab"
        >
          <button
            ref="addButtonRef"
            class="app-tabs-add"
            type="button"
            aria-label="Add tab"
            @click="handleTabAdd"
          >
            <slot name="add-icon">
              <Plus
                :size="14"
                :stroke-width="2"
                aria-hidden="true"
              />
            </slot>
          </button>
        </Tooltip>

        <slot name="actions" />
      </div>
    </div>

    <div class="app-tabs-content">
      <slot />
    </div>
  </component>
</template>

<script setup lang="ts">
import { Plus, X } from 'lucide-vue-next'
import Tooltip from './Tooltip.vue'
import {
  computed,
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  watch,
  type Component,
  type PropType,
} from 'vue'
import {
  tabsContextKey,
  type TabPaneName,
  type TabPaneState,
  type TabsBeforeLeave,
  type TabsPaneContext,
  type TabsPosition,
  type TabsType,
} from './tabs'

defineOptions({
  name: 'Tabs',
})

interface NormalizedTabPane extends TabsPaneContext {
  state: TabPaneState
}

const TabLabel = defineComponent({
  name: 'TabLabel',
  props: {
    pane: {
      type: Object as PropType<NormalizedTabPane>,
      required: true,
    },
  },
  setup(props) {
    return () => {
      const pane = props.pane
      const rendered = pane.state.renderLabel?.({
        active: pane.active,
        disabled: pane.disabled,
        index: pane.index,
        label: pane.label,
        name: pane.name,
      })
      return rendered ?? h('span', pane.label)
    }
  },
})

const props = withDefaults(defineProps<{
  as?: string | Component
  modelValue?: string | number
  defaultValue?: string | number
  type?: TabsType
  closable?: boolean
  addable?: boolean
  editable?: boolean
  tabPosition?: TabsPosition
  stretch?: boolean
  beforeLeave?: TabsBeforeLeave
  tabindex?: string | number
}>(), {
  as: 'div',
  modelValue: undefined,
  defaultValue: undefined,
  type: '',
  closable: false,
  addable: false,
  editable: false,
  tabPosition: 'top',
  stretch: false,
  beforeLeave: undefined,
  tabindex: 0,
})

const emit = defineEmits<{
  'update:modelValue': [name: TabPaneName]
  'tab-click': [pane: TabsPaneContext, event: MouseEvent | KeyboardEvent]
  'tab-change': [name: TabPaneName]
  'tab-remove': [name: TabPaneName]
  'tab-add': []
  edit: [targetName: TabPaneName | undefined, action: 'add' | 'remove']
}>()

const rootRef = ref<HTMLElement | null>(null)
const tabNavRef = ref<HTMLElement | null>(null)
const tabListRef = ref<HTMLElement | null>(null)
const addButtonRef = ref<HTMLElement | null>(null)
const panes = shallowRef<TabPaneState[]>([])
const currentName = ref<TabPaneName | undefined>(props.modelValue ?? props.defaultValue)
const pendingLeaveToken = ref(0)

const hasOverflowStart = ref(false)
const hasOverflowEnd = ref(false)
let overflowObserver: ResizeObserver | null = null

const isControlled = computed(() => props.modelValue !== undefined)
const resolvedType = computed(() => props.type || 'line')
const isVertical = computed(() => props.tabPosition === 'left' || props.tabPosition === 'right')
const canAdd = computed(() => props.addable || props.editable)

/**
 * 段排序:同段内保持注册次序(`Array.prototype.sort` 稳定),段之间按 `order`。
 *
 * 不声明 `order` 的消费者全体落在同一段(0),排序退化成恒等 —— 与从前逐字节
 * 一致。声明了的(工作台的工作区域页签)才被拉到尾段,而那正是"重排数据数组
 * 搬不动页签条"这件事从前无解的地方。
 */
const orderedPanes = computed<TabPaneState[]>(() =>
  [...panes.value].sort((left, right) => left.order.value - right.order.value))

const normalizedPanes = computed<NormalizedTabPane[]>(() => orderedPanes.value.map((pane, index) => {
  const name = pane.name.value ?? index
  const label = pane.label.value || String(name)

  return {
    uid: pane.uid,
    state: pane,
    index,
    name,
    label,
    disabled: pane.disabled.value,
    closable: pane.closable.value,
    lazy: pane.lazy.value,
    active: namesEqual(currentName.value, name),
  }
}))

const tabsClasses = computed(() => [
  `app-tabs--${resolvedType.value}`,
  `app-tabs--${props.tabPosition}`,
  {
    'is-stretch': props.stretch,
    'is-vertical': isVertical.value,
    'is-editable': props.editable,
    'is-addable': canAdd.value,
  },
])

watch(
  () => props.modelValue,
  value => {
    if (value !== undefined) currentName.value = value
  },
)

watch(
  normalizedPanes,
  () => {
    ensureActivePane()
    void nextTick(updateOverflowState)
  },
  { immediate: true, flush: 'post' },
)

watch(
  currentName,
  () => {
    void nextTick(scrollToActiveTab)
  },
)

provide(tabsContextKey, {
  registerPane,
  unregisterPane,
  isPaneActive,
  getPaneName,
  getPaneTabId: getTabId,
  getPanePanelId: getPanelId,
})

function registerPane(pane: TabPaneState) {
  if (panes.value.some(item => item.uid === pane.uid)) return
  panes.value = [...panes.value, pane]
}

function unregisterPane(uid: number) {
  panes.value = panes.value.filter(pane => pane.uid !== uid)
}

function namesEqual(left: TabPaneName | undefined, right: TabPaneName | undefined) {
  return left === right
}

function ensureActivePane() {
  if (isControlled.value || normalizedPanes.value.length === 0) return

  const hasActivePane = normalizedPanes.value.some(pane => namesEqual(pane.name, currentName.value) && !pane.disabled)
  if (hasActivePane) return

  const preferred = props.defaultValue === undefined
    ? undefined
    : normalizedPanes.value.find(pane => namesEqual(pane.name, props.defaultValue) && !pane.disabled)
  const fallback = preferred ?? normalizedPanes.value.find(pane => !pane.disabled) ?? normalizedPanes.value[0]
  currentName.value = fallback?.name
}

function getPaneName(uid: number) {
  return normalizedPanes.value.find(pane => pane.uid === uid)?.name
}

function isPaneActive(uid: number) {
  return normalizedPanes.value.some(pane => pane.uid === uid && pane.active)
}

function getPaneContext(pane: NormalizedTabPane): TabsPaneContext {
  return {
    uid: pane.uid,
    index: pane.index,
    name: pane.name,
    label: pane.label,
    active: pane.active,
    disabled: pane.disabled,
    closable: pane.closable,
    lazy: pane.lazy,
  }
}

function isPaneClosable(pane: NormalizedTabPane) {
  return props.closable || props.editable || pane.closable
}

function getPaneTabIndex(pane: NormalizedTabPane) {
  if (pane.disabled) return -1
  return pane.active ? props.tabindex : -1
}

function getTabId(uid: number) {
  return `app-tabs-tab-${uid}`
}

function getPanelId(uid: number) {
  return `app-tabs-panel-${uid}`
}

async function handleTabClick(pane: NormalizedTabPane, event: MouseEvent) {
  await activatePane(pane, event)
}

async function activatePane(pane: NormalizedTabPane, event: MouseEvent | KeyboardEvent) {
  if (pane.disabled) {
    event.preventDefault()
    return
  }

  emit('tab-click', getPaneContext(pane), event)

  if (namesEqual(currentName.value, pane.name)) return

  const token = pendingLeaveToken.value + 1
  pendingLeaveToken.value = token
  const canLeave = await resolveBeforeLeave(pane.name, currentName.value)
  if (!canLeave || token !== pendingLeaveToken.value) return

  if (!isControlled.value) currentName.value = pane.name
  emit('update:modelValue', pane.name)
  emit('tab-change', pane.name)
}

async function resolveBeforeLeave(newName: TabPaneName, oldName: TabPaneName | undefined) {
  if (!props.beforeLeave) return true

  try {
    const result = await props.beforeLeave(newName, oldName)
    return result !== false
  } catch {
    return false
  }
}

function handleTabRemove(name: TabPaneName) {
  emit('tab-remove', name)
  emit('edit', name, 'remove')
}

function handleTabAdd() {
  emit('tab-add')
  emit('edit', undefined, 'add')
}

function handleTabKeydown(event: KeyboardEvent, pane: NormalizedTabPane) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    void activatePane(pane, event)
    return
  }

  if (event.key === 'Delete' && isPaneClosable(pane)) {
    event.preventDefault()
    handleTabRemove(pane.name)
    return
  }

  const direction = getKeyboardDirection(event)
  if (direction === 0) return

  event.preventDefault()
  const nextPane = findNextEnabledPane(pane.index, direction)
  if (!nextPane) return

  focusPane(nextPane)
  void activatePane(nextPane, event)
}

function getKeyboardDirection(event: KeyboardEvent) {
  if (event.key === 'Home') return Number.NEGATIVE_INFINITY
  if (event.key === 'End') return Number.POSITIVE_INFINITY
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return 1
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return -1
  return 0
}

function findNextEnabledPane(currentIndex: number, direction: number) {
  const enabledPanes = normalizedPanes.value.filter(pane => !pane.disabled)
  if (enabledPanes.length === 0) return undefined

  if (direction === Number.NEGATIVE_INFINITY) return enabledPanes[0]
  if (direction === Number.POSITIVE_INFINITY) return enabledPanes[enabledPanes.length - 1]

  const currentEnabledIndex = enabledPanes.findIndex(pane => pane.index === currentIndex)
  const nextIndex = currentEnabledIndex === -1
    ? 0
    : (currentEnabledIndex + direction + enabledPanes.length) % enabledPanes.length
  return enabledPanes[nextIndex]
}

function focusPane(pane: NormalizedTabPane) {
  const tab = tabListRef.value?.querySelector<HTMLElement>(`[data-pane-index="${pane.index}"]`)
  tab?.focus()
}

function updateOverflowState() {
  const el = tabListRef.value
  if (!el) return

  if (isVertical.value) {
    hasOverflowStart.value = el.scrollTop > 1
    hasOverflowEnd.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1
  } else {
    hasOverflowStart.value = el.scrollLeft > 1
    hasOverflowEnd.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
  }
}

onMounted(() => {
  updateOverflowState()
  if (typeof ResizeObserver === 'undefined') return
  overflowObserver = new ResizeObserver(updateOverflowState)
  if (tabListRef.value) overflowObserver.observe(tabListRef.value)
})

onBeforeUnmount(() => {
  overflowObserver?.disconnect()
  overflowObserver = null
})

function scrollToActiveTab() {
  const activeTab = tabListRef.value?.querySelector<HTMLElement>('[data-active="true"]')
  activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function removeFocus() {
  const activeElement = document.activeElement
  if (activeElement instanceof HTMLElement && tabListRef.value?.contains(activeElement)) {
    activeElement.blur()
  }
}

defineExpose({
  currentName,
  tabNavRef,
  tabListRef,
  tabBarRef: tabNavRef,
  /** "+" 钮的实体:`tab-add` 的消费者常要把一张浮层挂在它上面(工作台的页签
   *  选择器就是),而事件本身带不出元素。露出来总好过让消费者去 querySelector
   *  一个别人组件的类名。 */
  addButtonRef,
  scrollToActiveTab,
  removeFocus,
})
</script>

<style scoped>
.app-tabs {
  --app-tabs-border: var(--ui-border-subtle-border);
  --app-tabs-border-strong: var(--ui-border-default-border);
  --app-tabs-surface: transparent;
  --app-tabs-nav-bg: transparent;
  --app-tabs-content-bg: transparent;
  --app-tabs-hover-bg: var(--ui-tab-bar-item-hover-bg, var(--ui-state-hover-bg));
  --app-tabs-active-bg: var(--ui-tab-bar-item-active-bg, var(--ui-surface-elevated-bg));
  --app-tabs-text: var(--ui-tab-bar-item-fg, var(--ui-text-secondary-fg));
  --app-tabs-active-text: var(--ui-tab-bar-item-active-fg, var(--ui-text-primary-fg));
  --app-tabs-muted-text: var(--ui-text-muted-fg);
  --app-tabs-disabled-text: var(--ui-state-disabled-fg, var(--text-disabled));
  --app-tabs-accent: var(--ui-accent-primary-fg);
  --app-tabs-focus: color-mix(in srgb, var(--app-tabs-accent) 48%, transparent);

  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  color: var(--ui-text-primary-fg);
  font-family: var(--type-label-font, var(--font-body));
  font-size: var(--type-label-size, 13px);
  line-height: var(--type-leading-control, 1.3);
  letter-spacing: 0;
}

.app-tabs--bottom {
  flex-direction: column-reverse;
}

.app-tabs--left,
.app-tabs--right {
  flex-direction: row;
  align-items: stretch;
}

.app-tabs--right {
  flex-direction: row-reverse;
}

.app-tabs-nav {
  position: relative;
  display: flex;
  align-items: stretch;
  flex: 0 0 auto;
  min-width: 0;
  min-height: 0;
  border-color: var(--app-tabs-border);
}

.app-tabs--left .app-tabs-nav,
.app-tabs--right .app-tabs-nav {
  flex-direction: column;
}

.app-tabs--top .app-tabs-nav {
  border-bottom: 1px solid var(--app-tabs-border);
}

.app-tabs--bottom .app-tabs-nav {
  border-top: 1px solid var(--app-tabs-border);
}

.app-tabs--left .app-tabs-nav {
  border-right: 1px solid var(--app-tabs-border);
}

.app-tabs--right .app-tabs-nav {
  border-left: 1px solid var(--app-tabs-border);
}

.app-tabs-nav-scroll {
  display: flex;
  align-items: stretch;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 100%;
  overflow: auto hidden;
  scrollbar-width: none;
}

.app-tabs-nav-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 2px;
  padding: 0 6px;
}

.app-tabs.is-vertical .app-tabs-nav-actions {
  justify-content: flex-start;
  padding: 6px;
}

.app-tabs-nav-scroll::-webkit-scrollbar {
  display: none;
}

/* The scrollbar is hidden, so fade the clipped edge to signal more tabs. */
.app-tabs-nav-scroll.is-overflow-start {
  mask-image: linear-gradient(to right, transparent, black 18px);
}

.app-tabs-nav-scroll.is-overflow-end {
  mask-image: linear-gradient(to right, black calc(100% - 18px), transparent);
}

.app-tabs-nav-scroll.is-overflow-start.is-overflow-end {
  mask-image: linear-gradient(to right, transparent, black 18px, black calc(100% - 18px), transparent);
}

.app-tabs.is-vertical .app-tabs-nav-scroll.is-overflow-start {
  mask-image: linear-gradient(to bottom, transparent, black 18px);
}

.app-tabs.is-vertical .app-tabs-nav-scroll.is-overflow-end {
  mask-image: linear-gradient(to bottom, black calc(100% - 18px), transparent);
}

.app-tabs.is-vertical .app-tabs-nav-scroll.is-overflow-start.is-overflow-end {
  mask-image: linear-gradient(to bottom, transparent, black 18px, black calc(100% - 18px), transparent);
}

.app-tabs--left .app-tabs-nav-scroll,
.app-tabs--right .app-tabs-nav-scroll {
  flex-direction: column;
  min-width: 132px;
  max-height: 100%;
  overflow: hidden auto;
}

.app-tabs-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* Shrink before the strip starts scrolling; the floor keeps tabs clickable. */
  flex: 0 1 auto;
  gap: 6px;
  min-width: 44px;
  min-height: 34px;
  max-width: 240px;
  padding: 0 14px;
  border: 0;
  color: var(--app-tabs-text);
  font: inherit;
  font-weight: var(--type-label-weight, 500);
  text-align: center;
  white-space: nowrap;
  outline: none;
  cursor: pointer;
  user-select: none;
  transition:
    background var(--duration-fast) var(--ease-default),
    color var(--duration-fast) var(--ease-default),
    box-shadow var(--duration-fast) var(--ease-default);
}

.app-tabs.is-stretch:not(.is-vertical) .app-tabs-tab {
  flex: 1 1 0;
  max-width: none;
}

.app-tabs.is-vertical .app-tabs-tab {
  justify-content: flex-start;
  flex-shrink: 0;
  width: 100%;
  max-width: none;
  text-align: left;
}

.app-tabs-tab:hover:not(.is-disabled) {
  color: var(--app-tabs-active-text);
  background: var(--app-tabs-hover-bg);
}

.app-tabs-tab:focus-visible {
  box-shadow: inset 0 0 0 2px var(--app-tabs-focus);
}

.app-tabs-tab.is-active {
  color: var(--app-tabs-active-text);
}

.app-tabs-tab.is-disabled {
  color: var(--app-tabs-disabled-text);
  cursor: not-allowed;
}

.app-tabs--line .app-tabs-tab::after {
  position: absolute;
  content: "";
  background: var(--app-tabs-accent);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.app-tabs--line .app-tabs-tab.is-active::after {
  opacity: 1;
}

.app-tabs--top.app-tabs--line .app-tabs-tab::after,
.app-tabs--bottom.app-tabs--line .app-tabs-tab::after {
  right: 12px;
  left: 12px;
  height: 2px;
}

.app-tabs--top.app-tabs--line .app-tabs-tab::after {
  bottom: -1px;
}

.app-tabs--bottom.app-tabs--line .app-tabs-tab::after {
  top: -1px;
}

.app-tabs--left.app-tabs--line .app-tabs-tab::after,
.app-tabs--right.app-tabs--line .app-tabs-tab::after {
  top: 8px;
  bottom: 8px;
  width: 2px;
}

.app-tabs--left.app-tabs--line .app-tabs-tab::after {
  right: -1px;
}

.app-tabs--right.app-tabs--line .app-tabs-tab::after {
  left: -1px;
}

.app-tabs--card .app-tabs-nav,
.app-tabs--border-card .app-tabs-nav {
  background: var(--app-tabs-nav-bg);
}

.app-tabs--card .app-tabs-tab,
.app-tabs--border-card .app-tabs-tab {
  min-height: 32px;
  margin-bottom: -1px;
  border: 1px solid transparent;
  border-bottom-color: var(--app-tabs-border);
  border-radius: 7px 7px 0 0;
}

.app-tabs--bottom.app-tabs--card .app-tabs-tab,
.app-tabs--bottom.app-tabs--border-card .app-tabs-tab {
  margin-top: -1px;
  margin-bottom: 0;
  border-top-color: var(--app-tabs-border);
  border-bottom-color: transparent;
  border-radius: 0 0 7px 7px;
}

.app-tabs--left.app-tabs--card .app-tabs-tab,
.app-tabs--left.app-tabs--border-card .app-tabs-tab,
.app-tabs--right.app-tabs--card .app-tabs-tab,
.app-tabs--right.app-tabs--border-card .app-tabs-tab {
  margin-right: -1px;
  margin-bottom: 0;
  border-right-color: var(--app-tabs-border);
  border-bottom-color: transparent;
  border-radius: 7px 0 0 7px;
}

.app-tabs--right.app-tabs--card .app-tabs-tab,
.app-tabs--right.app-tabs--border-card .app-tabs-tab {
  margin-right: 0;
  margin-left: -1px;
  border-right-color: transparent;
  border-left-color: var(--app-tabs-border);
  border-radius: 0 7px 7px 0;
}

.app-tabs--card .app-tabs-tab.is-active,
.app-tabs--border-card .app-tabs-tab.is-active {
  z-index: 1;
  border-color: var(--app-tabs-border);
  border-bottom-color: var(--app-tabs-content-bg);
  background: var(--app-tabs-content-bg);
}

.app-tabs--bottom.app-tabs--card .app-tabs-tab.is-active,
.app-tabs--bottom.app-tabs--border-card .app-tabs-tab.is-active {
  border-top-color: var(--app-tabs-content-bg);
  border-bottom-color: var(--app-tabs-border);
}

.app-tabs--left.app-tabs--card .app-tabs-tab.is-active,
.app-tabs--left.app-tabs--border-card .app-tabs-tab.is-active {
  border-right-color: var(--app-tabs-content-bg);
}

.app-tabs--right.app-tabs--card .app-tabs-tab.is-active,
.app-tabs--right.app-tabs--border-card .app-tabs-tab.is-active {
  border-left-color: var(--app-tabs-content-bg);
}

.app-tabs--border-card {
  --app-tabs-content-bg: var(--ui-surface-panel-bg);
  --app-tabs-nav-bg: color-mix(in srgb, var(--ui-surface-elevated-bg) 44%, transparent);

  overflow: hidden;
  border: 1px solid var(--app-tabs-border);
  border-radius: 8px;
  background: var(--app-tabs-content-bg);
}

.app-tabs--border-card.app-tabs--top .app-tabs-nav {
  border-top: 0;
  border-right: 0;
  border-left: 0;
}

.app-tabs--border-card.app-tabs--bottom .app-tabs-nav {
  border-right: 0;
  border-bottom: 0;
  border-left: 0;
}

.app-tabs--border-card.app-tabs--left .app-tabs-nav {
  border-top: 0;
  border-bottom: 0;
  border-left: 0;
}

.app-tabs--border-card.app-tabs--right .app-tabs-nav {
  border-top: 0;
  border-right: 0;
  border-bottom: 0;
}

.app-tabs-tab-label {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Slotted label content must inherit the squeeze so text ellipsizes
   instead of hard-clipping when tabs shrink. */
.app-tabs-tab-label :deep(span) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-tabs-close,
.app-tabs-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--app-tabs-muted-text);
  outline: none;
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-default),
    border-color var(--duration-fast) var(--ease-default),
    color var(--duration-fast) var(--ease-default);
}

.app-tabs-close:hover,
.app-tabs-add:hover {
  border-color: var(--ui-tab-bar-action-hover-border, var(--app-tabs-border));
  background: var(--ui-tab-bar-action-hover-bg, var(--app-tabs-hover-bg));
  color: var(--ui-tab-bar-action-hover-fg, var(--app-tabs-active-text));
}

.app-tabs-close:focus-visible,
.app-tabs-add:focus-visible {
  box-shadow: 0 0 0 2px var(--app-tabs-focus);
}

.app-tabs-content {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding: 12px 0 0;
}

.app-tabs--bottom .app-tabs-content {
  padding: 0 0 12px;
}

.app-tabs.is-vertical .app-tabs-content {
  padding: 0 0 0 12px;
}

.app-tabs--right .app-tabs-content {
  padding: 0 12px 0 0;
}

.app-tabs--border-card .app-tabs-content {
  padding: 14px;
}
</style>

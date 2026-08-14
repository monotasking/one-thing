<template>
  <div
    v-if="shouldRenderContent"
    v-show="isActive"
    :id="panelId"
    ref="paneRef"
    class="app-tab-pane"
    :class="{ 'is-active': isActive }"
    role="tabpanel"
    :aria-labelledby="tabId"
    :aria-hidden="isActive ? undefined : 'true'"
    :data-name="paneName === undefined ? undefined : String(paneName)"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed, getCurrentInstance, inject, onBeforeUnmount, ref, useAttrs, watch, type VNodeChild } from 'vue'
import { tabsContextKey, type TabPaneName, type TabPaneState } from './tabs'

defineOptions({
  name: 'TabPane',
})

const props = withDefaults(defineProps<{
  label?: string
  disabled?: boolean
  name?: string | number
  closable?: boolean
  lazy?: boolean
  /** 页签段(越小越靠前);缺省 0 = 与其余页签同段,次序仍是注册次序。 */
  order?: number
}>(), {
  label: '',
  disabled: false,
  name: undefined,
  closable: false,
  lazy: false,
  order: 0,
})

const slots = defineSlots<{
  default?: () => VNodeChild
  label?: (props: {
    active: boolean
    disabled: boolean
    index: number
    label: string
    name: TabPaneName
  }) => VNodeChild
}>()

const attrs = useAttrs()
const tabs = inject(tabsContextKey, null)
const paneRef = ref<HTMLElement | null>(null)
const paneUid = getCurrentInstance()?.uid ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
const resolvedName = computed<TabPaneName | undefined>(() => {
  const propName = props.name
  if (propName !== undefined) return propName
  const attrName = attrs.name
  return typeof attrName === 'string' || typeof attrName === 'number' ? attrName : undefined
})

const paneState: TabPaneState = {
  uid: paneUid,
  element: paneRef,
  label: computed(() => props.label),
  name: resolvedName,
  disabled: computed(() => props.disabled),
  closable: computed(() => props.closable),
  lazy: computed(() => props.lazy),
  order: computed(() => props.order),
  renderLabel: props => slots.label?.(props),
}

tabs?.registerPane(paneState)

const paneName = computed(() => tabs?.getPaneName(paneUid) ?? resolvedName.value)
const isActive = computed(() => tabs?.isPaneActive(paneUid) ?? true)
const tabId = computed(() => tabs?.getPaneTabId(paneUid))
const panelId = computed(() => tabs?.getPanePanelId(paneUid))
const hasRendered = ref(false)

watch(
  isActive,
  active => {
    if (active) hasRendered.value = true
  },
  { immediate: true },
)

const shouldRenderContent = computed(() => !props.lazy || hasRendered.value)

onBeforeUnmount(() => {
  tabs?.unregisterPane(paneUid)
})
</script>

<style scoped>
.app-tab-pane {
  min-width: 0;
  min-height: 0;
  outline: none;
}
</style>

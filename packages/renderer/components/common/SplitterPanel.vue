<template>
  <component
    :is="as"
    ref="panelRef"
    class="splitter-panel"
    :class="{
      'is-collapsible': collapsible,
      'is-collapsed': isCollapsed,
      'is-static': !resizable,
      'is-flex': flex,
    }"
    :style="panelStyle"
    :data-size="panelSize"
    :data-size-unit="sizeUnit"
    :data-collapsed="isCollapsed ? 'true' : 'false'"
  >
    <slot
      :size="panelSize"
      :collapsed="isCollapsed"
      :toggle-collapsed="toggleCollapsed"
    />
  </component>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch, type Component, type StyleValue } from 'vue'
import { splitterContextKey, type SplitterLength, type SplitterPanelState, type SplitterSizeUnit } from './splitter'

defineOptions({
  name: 'SplitterPanel',
})

const props = withDefaults(defineProps<{
  as?: string | Component
  size?: number
  sizeUnit?: SplitterSizeUnit
  flex?: boolean
  min?: number
  max?: number
  resizable?: boolean
  collapsible?: boolean
  collapsed?: boolean
  collapsedSize?: number
  collapseThreshold?: number
  padding?: SplitterLength
}>(), {
  as: 'div',
  size: undefined,
  sizeUnit: 'percent',
  flex: false,
  min: undefined,
  max: undefined,
  resizable: true,
  collapsible: false,
  collapsed: undefined,
  collapsedSize: 0,
  collapseThreshold: undefined,
  padding: undefined,
})

const emit = defineEmits<{
  'update:size': [size: number]
  'update:collapsed': [collapsed: boolean]
}>()

const splitter = inject(splitterContextKey, null)
const panelRef = ref<HTMLElement | null>(null)
const panelKey = Symbol('splitter-panel')

const panelState: SplitterPanelState = {
  key: panelKey,
  element: panelRef,
  size: computed(() => props.size),
  sizeUnit: computed(() => props.sizeUnit),
  flex: computed(() => props.flex),
  min: computed(() => props.min),
  max: computed(() => props.max),
  resizable: computed(() => props.resizable),
  collapsible: computed(() => props.collapsible),
  collapsed: computed(() => props.collapsed),
  collapsedSize: computed(() => props.collapsedSize),
  collapseThreshold: computed(() => props.collapseThreshold),
  emitSize: size => emit('update:size', size),
  emitCollapsed: collapsed => emit('update:collapsed', collapsed),
}

if (splitter) {
  splitter.registerPanel(panelState)
}

watch(
  () => [
    props.size,
    props.sizeUnit,
    props.flex,
    props.min,
    props.max,
    props.resizable,
    props.collapsible,
    props.collapsed,
    props.collapsedSize,
    props.collapseThreshold,
  ],
  () => splitter?.syncPanelSizes(),
)

const panelSize = computed(() => splitter?.getPanelSize(panelKey) ?? props.size ?? 0)
const isCollapsed = computed(() => splitter?.isPanelCollapsed(panelKey) ?? props.collapsed === true)

const panelStyle = computed<StyleValue>(() => {
  const style = {
    ...(splitter?.getPanelStyle(panelKey) as Record<string, string | number> | undefined),
  } as Record<string, string | number>

  if (props.padding !== undefined) {
    style.padding = typeof props.padding === 'number' ? `${props.padding}px` : props.padding
  }

  return style
})

function toggleCollapsed() {
  splitter?.togglePanelCollapsed(panelKey)
}

onBeforeUnmount(() => {
  splitter?.unregisterPanel(panelKey)
})
</script>

<style scoped>
.splitter-panel {
  display: flex;
  flex-direction: column;
  align-self: stretch;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  transition:
    flex-grow var(--duration-normal) var(--ease-default),
    flex-basis var(--duration-normal) var(--ease-default);
}

/* 拖拽期间关过渡。不能写 `:global(.splitter.is-dragging) .splitter-panel`:
   scoped 编译会把 :global() 后面的后代整段丢掉,规则被截成 `.splitter.is-dragging`
   —— transition:none 落在容器上,面板自己的 flex 过渡照跑,拖起来边缘滞后、松手还
   继续滑(2026-08-18 真机复现)。祖先门直接裸写,Vue 只给最后一个复合选择器加
   [data-v-x],作用域仍在。 */
.splitter.is-dragging .splitter-panel {
  transition: none;
}

.splitter-panel.is-collapsed {
  pointer-events: none;
}
</style>

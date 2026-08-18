<template>
  <component
    :is="as"
    ref="rootRef"
    class="splitter"
    :class="[
      `layout-${resolvedLayout}`,
      {
        'is-dragging': activeHandleIndex !== -1,
        'is-lazy': lazy,
        'is-disabled': disabled,
      },
    ]"
    :style="rootStyle"
    :data-layout="resolvedLayout"
  >
    <slot />

    <Button
      v-for="(_, index) in resizerCount"
      :key="`splitter-resizer-${index}`"
      unstyled
      native-type="button"
      class="splitter-resizer splitter-bar"
      :class="{
        'is-active': activeHandleIndex === index,
        'is-disabled': !canResizeHandle(index),
      }"
      :style="getResizerStyle(index)"
      role="separator"
      :aria-orientation="separatorOrientation"
      :aria-disabled="!canResizeHandle(index) ? 'true' : undefined"
      :tabindex="canResizeHandle(index) ? 0 : -1"
      :data-index="index"
      @mousedown="startResize($event, index)"
      @dblclick.prevent="toggleHandlePanel(index)"
      @keydown="handleResizerKeydown($event, index)"
    >
      <span class="splitter-resizer-line" />
    </Button>
  </component>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  provide,
  ref,
  shallowRef,
  type Component,
  type StyleValue,
} from 'vue'
import {
  isFiniteSize,
  normalizeSplitterLength,
  roundSplitterSize,
  splitterContextKey,
  type SplitterLayout,
  type SplitterLength,
  type SplitterPanelState,
  type SplitterSizeUnit,
} from './splitter'

defineOptions({
  name: 'Splitter',
})

const props = withDefaults(defineProps<{
  as?: string | Component
  layout?: SplitterLayout
  direction?: SplitterLayout
  vertical?: boolean
  lazy?: boolean
  disabled?: boolean
  gap?: SplitterLength
  resizerSize?: SplitterLength
  resizerHitSize?: SplitterLength
  keyboardStep?: number
  keyboardLargeStep?: number
}>(), {
  as: 'div',
  layout: 'horizontal',
  direction: undefined,
  vertical: false,
  lazy: false,
  disabled: false,
  gap: 0,
  resizerSize: 2,
  resizerHitSize: 10,
  keyboardStep: 2,
  keyboardLargeStep: 10,
})

const emit = defineEmits<{
  'resize-start': [sizes: number[]]
  resize: [sizes: number[]]
  'resize-end': [sizes: number[]]
  collapse: [payload: { index: number; collapsed: boolean; sizes: number[] }]
}>()

const rootRef = ref<HTMLElement | null>(null)
const panels = shallowRef<SplitterPanelState[]>([])
const committedSizes = ref<number[]>([])
const pendingSizes = ref<number[] | null>(null)
const activeHandleIndex = ref(-1)
const startCoordinate = ref(0)
const startSizes = ref<number[]>([])
const containerAxisSize = ref(0)
const restoreSizes = new Map<symbol, number>()
let previousBodyCursor = ''
let previousBodyUserSelect = ''
let syncQueued = false
let dragListenersAttached = false
let resizeObserver: ResizeObserver | null = null

const resolvedLayout = computed<SplitterLayout>(() => {
  if (props.vertical) return 'vertical'
  return props.direction ?? props.layout
})

const separatorOrientation = computed(() => resolvedLayout.value === 'horizontal' ? 'vertical' : 'horizontal')
const resizerCount = computed(() => Math.max(0, panels.value.length - 1))

const rootStyle = computed<StyleValue>(() => ({
  '--splitter-gap': normalizeSplitterLength(props.gap, '0px'),
  '--splitter-resizer-size': normalizeSplitterLength(props.resizerSize, '2px'),
  '--splitter-resizer-hit-size': normalizeSplitterLength(props.resizerHitSize, '10px'),
}))

function registerPanel(panel: SplitterPanelState) {
  if (panels.value.some(item => item.key === panel.key)) return
  panels.value = [...panels.value, panel]
  queuePanelSync(true)
}

function unregisterPanel(key: symbol) {
  const index = panels.value.findIndex(panel => panel.key === key)
  if (index === -1) return
  panels.value = panels.value.filter(panel => panel.key !== key)
  restoreSizes.delete(key)
  const next = committedSizes.value.slice()
  next.splice(index, 1)
  committedSizes.value = normalizeSizes(next, panels.value)
  emitPanelSizes(committedSizes.value)
  queuePanelSync(false)
}

function queuePanelSync(emitInitialSizes = false) {
  if (syncQueued) return
  syncQueued = true
  nextTick(() => {
    syncQueued = false
    sortPanelsByDomOrder()
    syncPanelSizes(emitInitialSizes)
  })
}

function sortPanelsByDomOrder() {
  const sorted = panels.value.slice().sort((a, b) => {
    const aElement = a.element.value
    const bElement = b.element.value
    if (!aElement || !bElement || aElement === bElement) return 0
    return aElement.compareDocumentPosition(bElement) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1
  })

  if (sorted.every((panel, index) => panel.key === panels.value[index]?.key)) return
  panels.value = sorted
}

function syncPanelSizes(emitInitialSizes = false) {
  const next = normalizeSizes(committedSizes.value, panels.value)
  commitSizes(next, {
    emitPanels: emitInitialSizes,
    emitResize: false,
  })
}

function normalizeSizes(previousSizes: number[], currentPanels: SplitterPanelState[]): number[] {
  const count = currentPanels.length
  if (count === 0) return []

  if (usesPercentOnlySizing(currentPanels)) {
    return normalizePercentSizes(previousSizes, currentPanels)
  }

  const next = Array.from<number | undefined>({ length: count })
  const missingIndexes: number[] = []

  for (let index = 0; index < count; index++) {
    const panel = currentPanels[index]
    const externalCollapsed = panel.collapsed.value === true
    const externalSize = panel.size.value
    const previousSize = previousSizes[index]

    if (externalCollapsed) {
      const collapsedSize = normalizePanelCollapsedSize(panel)
      next[index] = collapsedSize
      continue
    }

    if (panel.flex.value) {
      next[index] = 0
      continue
    }

    if (isFiniteSize(externalSize)) {
      const clamped = clampPanelSize(panel, externalSize)
      next[index] = clamped
      continue
    }

    if (isFiniteSize(previousSize)) {
      const clamped = clampPanelSize(panel, previousSize)
      next[index] = clamped
      continue
    }

    missingIndexes.push(index)
  }

  if (missingIndexes.length > 0) {
    const fallback = currentPanels.some(panel => panel.sizeUnit.value === 'px') ? 0 : 100 / missingIndexes.length
    for (const index of missingIndexes) {
      next[index] = clampPanelSize(currentPanels[index], fallback)
    }
  }

  return next.map(size => roundSplitterSize(size ?? 0))
}

function usesPercentOnlySizing(currentPanels: SplitterPanelState[]): boolean {
  return currentPanels.every(panel => panel.sizeUnit.value === 'percent' && !panel.flex.value)
}

function normalizePercentSizes(previousSizes: number[], currentPanels: SplitterPanelState[]): number[] {
  const count = currentPanels.length
  const next = Array.from<number | undefined>({ length: count })
  const missingIndexes: number[] = []
  const hasExplicitSize = currentPanels.some(panel => panel.collapsed.value === true || isFiniteSize(panel.size.value))
  let explicitTotal = 0

  for (let index = 0; index < count; index++) {
    const panel = currentPanels[index]
    const externalCollapsed = panel.collapsed.value === true
    const externalSize = panel.size.value
    const previousSize = previousSizes[index]

    if (externalCollapsed) {
      const collapsedSize = normalizePanelCollapsedSize(panel)
      next[index] = collapsedSize
      explicitTotal += collapsedSize
      continue
    }

    if (isFiniteSize(externalSize)) {
      const clamped = clampPanelSize(panel, externalSize)
      next[index] = clamped
      explicitTotal += clamped
      continue
    }

    if (!hasExplicitSize && isFiniteSize(previousSize)) {
      const clamped = clampPanelSize(panel, previousSize)
      next[index] = clamped
      explicitTotal += clamped
      continue
    }

    missingIndexes.push(index)
  }

  if (missingIndexes.length > 0) {
    const fallback = Math.max(0, 100 - explicitTotal) / missingIndexes.length
    for (const index of missingIndexes) {
      next[index] = clampPanelSize(currentPanels[index], fallback)
    }
  }

  return normalizeTotal(next.map(size => size ?? 0), 100)
}

function normalizeTotal(sizes: number[], targetTotal: number): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total <= 0) {
    const equal = targetTotal / Math.max(1, sizes.length)
    return sizes.map(() => roundSplitterSize(equal))
  }
  if (Math.abs(total - targetTotal) < 0.001) {
    return sizes.map(roundSplitterSize)
  }
  return sizes.map(size => roundSplitterSize(size / total * targetTotal))
}

function clampPanelSize(panel: SplitterPanelState, size: number): number {
  const min = normalizePanelMin(panel)
  const max = normalizePanelMax(panel)
  return Math.min(max, Math.max(min, size))
}

function normalizePanelMin(panel: SplitterPanelState): number {
  const min = panel.min.value
  return isFiniteSize(min) ? Math.max(0, min) : 0
}

function normalizePanelMax(panel: SplitterPanelState): number {
  const max = panel.max.value
  if (isFiniteSize(max)) return Math.max(0, max)
  return panelUnit(panel) === 'px' ? Number.POSITIVE_INFINITY : 100
}

function normalizePanelCollapsedSize(panel: SplitterPanelState): number {
  return Math.max(0, panel.collapsedSize.value)
}

function panelUnit(panel: SplitterPanelState): SplitterSizeUnit {
  return panel.sizeUnit.value
}

function sizeToPixels(panel: SplitterPanelState, size: number, axisSize = getContainerAxisSize()): number {
  if (panelUnit(panel) === 'px') return size
  return axisSize * size / 100
}

function pixelsToSize(panel: SplitterPanelState, pixels: number, axisSize = getContainerAxisSize()): number {
  if (panelUnit(panel) === 'px') return roundSplitterSize(pixels)
  if (axisSize <= 0) return 0
  return roundSplitterSize(pixels / axisSize * 100)
}

function normalizePanelMinPixels(panel: SplitterPanelState, axisSize = getContainerAxisSize()): number {
  return sizeToPixels(panel, normalizePanelMin(panel), axisSize)
}

function normalizePanelMaxPixels(panel: SplitterPanelState, axisSize = getContainerAxisSize()): number {
  return sizeToPixels(panel, normalizePanelMax(panel), axisSize)
}

function normalizePanelCollapsedPixels(panel: SplitterPanelState, axisSize = getContainerAxisSize()): number {
  return sizeToPixels(panel, normalizePanelCollapsedSize(panel), axisSize)
}

function clampPanelPixels(panel: SplitterPanelState, pixels: number, axisSize = getContainerAxisSize()): number {
  const min = normalizePanelMinPixels(panel, axisSize)
  const max = normalizePanelMaxPixels(panel, axisSize)
  return Math.min(max, Math.max(min, pixels))
}

function resolvePanelPixels(sourceSizes = displaySizes(), axisSize = getContainerAxisSize()): number[] {
  const resolved = Array.from<number>({ length: panels.value.length }).fill(0)
  const flexIndexes: number[] = []
  let usedPixels = 0

  panels.value.forEach((panel, index) => {
    const size = sourceSizes[index] ?? 0

    if (isSizeCollapsed(panel, size)) {
      const collapsedPixels = normalizePanelCollapsedPixels(panel, axisSize)
      resolved[index] = collapsedPixels
      usedPixels += collapsedPixels
      return
    }

    if (panel.flex.value) {
      flexIndexes.push(index)
      return
    }

    const pixels = clampPanelPixels(panel, sizeToPixels(panel, size, axisSize), axisSize)
    resolved[index] = pixels
    usedPixels += pixels
  })

  if (flexIndexes.length > 0) {
    const flexPixels = Math.max(0, axisSize - usedPixels) / flexIndexes.length
    for (const index of flexIndexes) {
      resolved[index] = clampPanelPixels(panels.value[index], flexPixels, axisSize)
    }
  }

  return resolved.map(roundSplitterSize)
}

function commitSizes(
  nextSizes: number[],
  options: {
    emitPanels: boolean
    emitResize: boolean
  },
) {
  const normalized = nextSizes.map(roundSplitterSize)
  committedSizes.value = normalized
  pendingSizes.value = null

  syncCollapsedStates(normalized)

  if (options.emitPanels) {
    emitPanelSizes(normalized)
  }

  if (options.emitResize) {
    emit('resize', normalized.slice())
  }
}

function emitPanelSizes(sizes: number[]) {
  panels.value.forEach((panel, index) => {
    if (panel.flex.value) return
    const size = sizes[index]
    if (isFiniteSize(size)) {
      panel.emitSize(size)
    }
  })
}

function syncCollapsedStates(sizes: number[]) {
  panels.value.forEach((panel, index) => {
    if (!panel.collapsible.value) return

    const collapsed = sizes[index] <= normalizePanelCollapsedSize(panel) + 0.001
    if (panel.collapsed.value !== undefined) {
      if (panel.collapsed.value !== collapsed) {
        panel.emitCollapsed(collapsed)
      }
      return
    }

    panel.emitCollapsed(collapsed)
  })
}

function displaySizes(): number[] {
  if (!props.lazy && pendingSizes.value) return pendingSizes.value
  return committedSizes.value
}

function positionSizes(): number[] {
  return pendingSizes.value ?? committedSizes.value
}

function getPanelIndex(key: symbol): number {
  return panels.value.findIndex(panel => panel.key === key)
}

/* 只写 flex 三件套,**不要**再往面板上挂 `--splitter-panel-size` 之类的内联自定义
   变量:祖先的自定义属性一变,Blink 会把所有引用了 var() 的后代样式全部重算 ——
   主面板是整棵聊天树的祖先,实测一次 10.9ms(3272 元素)vs 只改 flex-grow 0.1ms,
   拖分隔条时每帧一次,就是拖拽掉帧的大头(2026-08-18 trace)。当时也没有任何消费者。 */
function getPanelStyle(key: symbol): StyleValue {
  const index = getPanelIndex(key)
  const size = index === -1 ? 0 : displaySizes()[index] ?? 0
  const panel = index === -1 ? undefined : panels.value[index]
  const collapsed = panel ? isSizeCollapsed(panel, size) : false

  if (panel && usesPercentOnlySizing(panels.value)) {
    return {
      flexGrow: collapsed ? 0 : Math.max(0, size),
      flexShrink: collapsed ? 0 : 1,
      flexBasis: collapsed ? '0px' : '0%',
    }
  }

  if (!panel || collapsed) {
    return {
      flexGrow: 0,
      flexShrink: 0,
      flexBasis: '0px',
    }
  }

  if (panel.flex.value) {
    return {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: '0px',
    }
  }

  return {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: panelUnit(panel) === 'px'
      ? `${roundSplitterSize(size)}px`
      : `${roundSplitterSize(size)}%`,
  }
}

function getPanelSize(key: symbol): number {
  const index = getPanelIndex(key)
  return index === -1 ? 0 : roundSplitterSize(displaySizes()[index] ?? 0)
}

function isPanelCollapsed(key: symbol): boolean {
  const index = getPanelIndex(key)
  if (index === -1) return false
  return isSizeCollapsed(panels.value[index], displaySizes()[index] ?? 0)
}

function isSizeCollapsed(panel: SplitterPanelState, size: number): boolean {
  if (panel.collapsed.value === true) return true
  return panel.collapsible.value && size <= normalizePanelCollapsedSize(panel) + 0.001
}

function getResizerStyle(index: number): StyleValue {
  const axisSize = getContainerAxisSize()
  const pixels = resolvePanelPixels(positionSizes(), axisSize)
  const offset = pixels.slice(0, index + 1).reduce((sum, size) => sum + size, 0)
  const position = axisSize > 0 ? roundSplitterSize(offset / axisSize * 100) : 0

  if (resolvedLayout.value === 'horizontal') {
    return {
      left: `calc(${position}% - (var(--splitter-resizer-hit-size) / 2))`,
    }
  }

  return {
    top: `calc(${position}% - (var(--splitter-resizer-hit-size) / 2))`,
  }
}

function canResizeHandle(index: number): boolean {
  if (props.disabled) return false
  const left = panels.value[index]
  const right = panels.value[index + 1]
  return Boolean(left?.resizable.value && right?.resizable.value)
}

function startResize(event: MouseEvent, index: number) {
  if (!canResizeHandle(index)) return

  event.preventDefault()
  updateContainerAxisSize()
  activeHandleIndex.value = index
  startCoordinate.value = pointerCoordinate(event)
  startSizes.value = committedSizes.value.slice()
  pendingSizes.value = null

  previousBodyCursor = document.body.style.cursor
  previousBodyUserSelect = document.body.style.userSelect
  document.body.style.cursor = resolvedLayout.value === 'horizontal' ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', handleResize)
  document.addEventListener('mouseup', stopResize)
  dragListenersAttached = true
  emit('resize-start', committedSizes.value.slice())
}

function handleResize(event: MouseEvent) {
  if (activeHandleIndex.value === -1) return

  const axisSize = getContainerAxisSize()
  if (axisSize <= 0) return

  const delta = pointerCoordinate(event) - startCoordinate.value
  const next = resizePair(startSizes.value, activeHandleIndex.value, delta)

  if (props.lazy) {
    pendingSizes.value = next
    return
  }

  pendingSizes.value = next
  commitSizes(next, {
    emitPanels: true,
    emitResize: true,
  })
}

function stopResize() {
  if (activeHandleIndex.value === -1) return

  const finalSizes = pendingSizes.value ?? committedSizes.value
  if (props.lazy && pendingSizes.value) {
    commitSizes(finalSizes, {
      emitPanels: true,
      emitResize: true,
    })
  }

  emit('resize-end', committedSizes.value.slice())
  activeHandleIndex.value = -1
  pendingSizes.value = null
  startSizes.value = []
  removeDragListeners()
}

function removeDragListeners() {
  if (!dragListenersAttached) return
  document.removeEventListener('mousemove', handleResize)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = previousBodyCursor
  document.body.style.userSelect = previousBodyUserSelect
  dragListenersAttached = false
}

function pointerCoordinate(event: MouseEvent): number {
  return resolvedLayout.value === 'horizontal' ? event.clientX : event.clientY
}

function measureContainerAxisSize(): number {
  const element = rootRef.value
  if (!element) return 100

  const rect = element.getBoundingClientRect()
  const rectSize = resolvedLayout.value === 'horizontal' ? rect.width : rect.height
  const clientSize = resolvedLayout.value === 'horizontal' ? element.clientWidth : element.clientHeight
  return rectSize || clientSize || 100
}

function updateContainerAxisSize() {
  containerAxisSize.value = measureContainerAxisSize()
}

function getContainerAxisSize(): number {
  return containerAxisSize.value || measureContainerAxisSize()
}

function resizePair(sourceSizes: number[], index: number, delta: number): number[] {
  const leftPanel = panels.value[index]
  const rightPanel = panels.value[index + 1]
  if (!leftPanel || !rightPanel || !canResizeHandle(index)) return sourceSizes.slice()

  if (leftPanel.flex.value && rightPanel.flex.value) return sourceSizes.slice()

  const axisSize = getContainerAxisSize()
  const sourcePixels = resolvePanelPixels(sourceSizes, axisSize)
  const next = sourceSizes.slice()
  const pairTotal = (sourcePixels[index] ?? 0) + (sourcePixels[index + 1] ?? 0)
  let leftSize = sourcePixels[index] + delta
  let rightSize = pairTotal - leftSize

  const collapsedLeft = maybeCollapsedSize(leftPanel, leftSize)
  if (collapsedLeft !== undefined) {
    leftSize = collapsedLeft
    rightSize = pairTotal - leftSize
  } else {
    leftSize = clampPairSide(leftPanel, leftSize, pairTotal, rightPanel)
    rightSize = pairTotal - leftSize
  }

  const collapsedRight = maybeCollapsedSize(rightPanel, rightSize)
  if (collapsedRight !== undefined) {
    rightSize = collapsedRight
    leftSize = pairTotal - rightSize
  } else {
    rightSize = clampPairSide(rightPanel, rightSize, pairTotal, leftPanel)
    leftSize = pairTotal - rightSize
  }

  if (!leftPanel.flex.value) {
    next[index] = pixelsToSize(leftPanel, leftSize, axisSize)
  }
  if (!rightPanel.flex.value) {
    next[index + 1] = pixelsToSize(rightPanel, rightSize, axisSize)
  }
  return next
}

function maybeCollapsedSize(panel: SplitterPanelState, size: number): number | undefined {
  if (!panel.collapsible.value) return undefined
  const collapsedSize = normalizePanelCollapsedPixels(panel)
  const explicitThreshold = panel.collapseThreshold.value
  const threshold = isFiniteSize(explicitThreshold)
    ? sizeToPixels(panel, explicitThreshold)
    : Math.max(collapsedSize, normalizePanelMinPixels(panel) / 2)
  return size <= threshold ? collapsedSize : undefined
}

function clampPairSide(
  panel: SplitterPanelState,
  size: number,
  pairTotal: number,
  oppositePanel: SplitterPanelState,
): number {
  const min = normalizePanelMinPixels(panel)
  const max = Math.min(normalizePanelMaxPixels(panel), pairTotal - normalizePanelMinPixels(oppositePanel))
  return Math.min(max, Math.max(min, size))
}

function toggleHandlePanel(index: number) {
  const left = panels.value[index]
  const right = panels.value[index + 1]
  const panel = left?.collapsible.value ? left : right?.collapsible.value ? right : undefined
  if (!panel) return
  togglePanelCollapsed(panel.key)
}

function togglePanelCollapsed(key: symbol) {
  const index = getPanelIndex(key)
  const panel = panels.value[index]
  if (!panel?.collapsible.value) return

  const axisSize = getContainerAxisSize()
  const sizes = committedSizes.value.slice()
  const pixels = resolvePanelPixels(sizes, axisSize)
  const currentlyCollapsed = isPanelCollapsed(key)
  const neighborIndex = index < sizes.length - 1 ? index + 1 : index - 1
  if (neighborIndex < 0) return

  if (currentlyCollapsed) {
    const collapsedSize = normalizePanelCollapsedPixels(panel, axisSize)
    const preferredSize = restoreSizes.get(key) ?? Math.max(normalizePanelMinPixels(panel, axisSize), axisSize / Math.max(1, panels.value.length))
    const neighborMin = normalizePanelMinPixels(panels.value[neighborIndex], axisSize)
    const available = Math.max(0, pixels[neighborIndex] - neighborMin)
    const restored = Math.min(preferredSize, available)
    pixels[index] = collapsedSize + restored
    pixels[neighborIndex] = pixels[neighborIndex] - restored
    panel.emitCollapsed(false)
  } else {
    const collapsedSize = normalizePanelCollapsedPixels(panel, axisSize)
    restoreSizes.set(key, Math.max(normalizePanelMinPixels(panel, axisSize), pixels[index]))
    const released = Math.max(0, pixels[index] - collapsedSize)
    pixels[index] = collapsedSize
    pixels[neighborIndex] = pixels[neighborIndex] + released
    panel.emitCollapsed(true)
  }

  if (!panel.flex.value) {
    sizes[index] = pixelsToSize(panel, pixels[index], axisSize)
  }
  const neighbor = panels.value[neighborIndex]
  if (neighbor && !neighbor.flex.value) {
    sizes[neighborIndex] = pixelsToSize(neighbor, pixels[neighborIndex], axisSize)
  }

  commitSizes(sizes, {
    emitPanels: true,
    emitResize: true,
  })
  emit('collapse', {
    index,
    collapsed: !currentlyCollapsed,
    sizes: committedSizes.value.slice(),
  })
}

function handleResizerKeydown(event: KeyboardEvent, index: number) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    toggleHandlePanel(index)
    return
  }

  if (!canResizeHandle(index)) return

  const sign = keyboardDeltaSign(event)
  if (sign === 0) return

  event.preventDefault()
  const step = event.shiftKey ? props.keyboardLargeStep : props.keyboardStep
  const next = resizePair(committedSizes.value, index, resolveKeyboardDeltaPixels(index, sign * step))
  commitSizes(next, {
    emitPanels: true,
    emitResize: true,
  })
  emit('resize-end', committedSizes.value.slice())
}

function keyboardDeltaSign(event: KeyboardEvent): number {
  if (resolvedLayout.value === 'horizontal') {
    if (event.key === 'ArrowLeft') return -1
    if (event.key === 'ArrowRight') return 1
    return 0
  }

  if (event.key === 'ArrowUp') return -1
  if (event.key === 'ArrowDown') return 1
  return 0
}

function resolveKeyboardDeltaPixels(index: number, delta: number): number {
  const left = panels.value[index]
  const right = panels.value[index + 1]
  if (left && right && left.sizeUnit.value === 'percent' && right.sizeUnit.value === 'percent') {
    return getContainerAxisSize() * delta / 100
  }
  return delta
}

provide(splitterContextKey, {
  layout: resolvedLayout,
  registerPanel,
  unregisterPanel,
  syncPanelSizes: () => queuePanelSync(false),
  getPanelStyle,
  getPanelSize,
  isPanelCollapsed,
  togglePanelCollapsed,
})

onMounted(() => {
  updateContainerAxisSize()

  if (typeof ResizeObserver !== 'undefined' && rootRef.value) {
    resizeObserver = new ResizeObserver(() => {
      updateContainerAxisSize()
    })
    resizeObserver.observe(rootRef.value)
  }
})

onBeforeUnmount(() => {
  removeDragListeners()
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<style scoped>
.splitter {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
  gap: var(--splitter-gap);
}

.splitter.layout-horizontal {
  flex-direction: row;
}

.splitter.layout-vertical {
  flex-direction: column;
}

.splitter-resizer {
  position: absolute;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ui-accent-primary-fg);
  appearance: none;
  -webkit-app-region: no-drag;
}

.splitter.layout-horizontal .splitter-resizer {
  top: 0;
  bottom: 0;
  width: var(--splitter-resizer-hit-size);
  cursor: col-resize;
}

.splitter.layout-vertical .splitter-resizer {
  left: 0;
  right: 0;
  height: var(--splitter-resizer-hit-size);
  cursor: row-resize;
}

/* 停用的分隔条**不吃指针**(L4)。它的命中区有 12px 宽,坐在被收起的那一侧面板
   的边上;侧栏收起后左缘那 12px 正是浮层侧栏的 hover 触发区,一个既不能拖也不能
   聚焦的按钮压在上面,只会把触发区吃掉。 */
.splitter-resizer.is-disabled {
  cursor: default;
  opacity: 0.45;
  pointer-events: none;
}

.splitter-resizer-line {
  display: block;
  border-radius: 999px;
  background: transparent;
  transition:
    background-color var(--duration-normal) var(--ease-default),
    transform var(--duration-normal) var(--ease-default);
}

.splitter.layout-horizontal .splitter-resizer-line {
  width: var(--splitter-resizer-size);
  height: 100%;
}

.splitter.layout-vertical .splitter-resizer-line {
  width: 100%;
  height: var(--splitter-resizer-size);
}

.splitter-resizer:not(.is-disabled):hover .splitter-resizer-line,
.splitter-resizer:not(.is-disabled):focus-visible .splitter-resizer-line,
.splitter-resizer.is-active .splitter-resizer-line {
  background: currentColor;
}

.splitter-resizer:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ui-accent-primary-fg) 60%, transparent);
  outline-offset: -2px;
}
</style>

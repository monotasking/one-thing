<template>
  <div
    ref="wrapperRef"
    :class="['tooltip-wrapper', { 'tooltip-wrapper-detached': !!triggerEl }]"
    @mouseenter="onWrapperEnter"
    @mouseleave="onWrapperLeave"
  >
    <slot />
    <Teleport to="body">
      <Transition name="tooltip-fade">
        <div
          v-if="visible"
          ref="tooltipElRef"
          :class="['tooltip', { 'tooltip-rich': !!$slots.content, 'tooltip-interactive': interactive }]"
          :style="tooltipStyle"
          @mouseenter="handleTooltipEnter"
          @mouseleave="handleTooltipLeave"
        >
          <slot name="content">
            {{ text }}
          </slot>
          <div
            v-if="!$slots.content"
            class="tooltip-arrow"
            :style="arrowStyle"
          />
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onUnmounted, watch } from 'vue'
import {
  buildSafeTriangle,
  isPointInRect,
  isPointInTriangle,
  type SafeTriangle,
} from './safe-triangle.js'
import {
  hideOtherInteractiveTooltips,
  isPointOnAnotherTrigger,
  registerInteractiveTooltip,
  unregisterInteractiveTooltip,
  type InteractiveTooltip,
} from './interactive-tooltip-registry.js'

/** The measured half of a `DOMRect` — the only fields `updatePosition` reads. */
interface AnchorBox {
  top: number
  bottom: number
  left: number
  right: number
  width: number
  height: number
}

interface Props {
  /** Plain text body. Ignored when a `content` slot is provided. */
  text?: string
  delay?: number
  position?: 'top' | 'bottom' | 'left' | 'right'
  /** When true, the tooltip will not appear (e.g. while a dropdown is open). */
  disabled?: boolean
  /**
   * Let the pointer reach the tooltip itself, so its content can be read at
   * leisure. Travelling there is protected by a safe triangle (see
   * ./safe-triangle.ts); without it, the diagonal path across the rows in
   * between would dismiss the tooltip on the way.
   *
   * Off by default: a one-line label has nothing to travel to, and making it
   * hit-testable would only let it swallow clicks.
   */
  interactive?: boolean
  /**
   * Hover on this element instead of the wrapped content, and position against
   * it too. Lets a whole row act as the trigger without wrapping it — nesting a
   * wrapper around a row would break layout that depends on the row being a
   * direct child (negative margins, grid placement).
   *
   * With this set the component renders no box of its own; it exists only to
   * host the floating panel.
   */
  triggerEl?: HTMLElement | null
  /**
   * Position against a viewport POINT instead of the trigger's box (G2,
   * 2026-08-11). Same idea as the floating kernel's `VirtualAnchor` and
   * ContextMenu's `{x, y}`: a chart bubble hangs off the cursor, not off the
   * `<svg>` that happens to contain it.
   *
   * It only replaces the *measuring* rect. Hovering, the safe triangle and the
   * "am I still on the trigger" test all keep using the real element — a
   * zero-sized rect would answer that question wrong at every edge. So the
   * shape a chart wants is `:trigger-el="chartEl"` + `:virtual-anchor="cursor"`
   * (+ `:delay="0"`): the element decides *whether*, the point decides *where*.
   *
   * `null` (the default) is the pre-G2 path byte for byte.
   */
  virtualAnchor?: { x: number, y: number } | null
}

const props = withDefaults(defineProps<Props>(), {
  text: '',
  delay: 400,
  position: 'top',
  disabled: false,
  interactive: false,
  triggerEl: null,
  virtualAnchor: null,
})

const wrapperRef = ref<HTMLElement | null>(null)
const tooltipElRef = ref<HTMLElement | null>(null)
const visible = ref(false)
const tooltipPosition = ref({ top: 0, left: 0 })
const actualPosition = ref<'top' | 'bottom' | 'left' | 'right'>('top')
/**
 * How far the horizontal clamp had to push a top/bottom panel off the trigger's
 * centre (px, positive = panel moved right). The panel travels; the arrow must
 * not — it stays over the trigger by cancelling this shift.
 */
const horizontalClampShift = ref(0)

let showTimer: ReturnType<typeof setTimeout> | null = null
let travelTimer: ReturnType<typeof setTimeout> | null = null
let safeTriangle: SafeTriangle | null = null

/** This instance's entry in the shared registry below. */
const registration: InteractiveTooltip = {
  trigger: () => anchorEl(),
  hide: () => hideNow(),
}

/**
 * How long the pointer may sit still inside the safe triangle before the
 * tooltip gives up on it. Every move that lands inside the wedge re-arms this,
 * so it measures stalling rather than total journey time — the trip itself can
 * take as long as the user wants it to.
 */
const TRAVEL_GRACE_MS = 400

/**
 * Grace after the pointer leaves the panel. Long enough to survive clipping an
 * edge, short enough that a deliberate exit still feels immediate. A pointer
 * that genuinely left is closed by the next mousemove regardless, well before
 * this fires; it only backstops the case where no further move arrives (the
 * pointer left the window entirely).
 */
const PANEL_EXIT_GRACE_MS = 120

/**
 * Slack around the panel's edges. Hit-testing the exact rect makes the boundary
 * feel razor-thin — sub-pixel layout and pointer quantisation both put the
 * cursor "outside" while it visually sits on the edge.
 */
const PANEL_HALO = 12

function cancelShowTimer() {
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = null
  }
}

/** Restarts the close countdown, discarding any deadline already running. */
function armHideTimer(ms: number) {
  if (travelTimer) clearTimeout(travelTimer)
  travelTimer = setTimeout(hideNow, ms)
}

function clearTravelGrace() {
  if (travelTimer) {
    clearTimeout(travelTimer)
    travelTimer = null
  }
  safeTriangle = null
}

function hideNow() {
  clearTravelGrace()
  visible.value = false
}

/**
 * Decides, from the pointer position alone, whether this panel still has any
 * reason to be on screen.
 *
 * Runs for as long as the panel is visible rather than only after a
 * mouseleave. Hanging the whole close path off that one event meant any way of
 * missing it — a re-render swapping the element out, a synthetic pointer, a
 * platform quirk — left the panel stranded with nothing watching it. Position
 * is the thing that actually decides, so position is what gets checked.
 */
function handlePointerMove(event: MouseEvent) {
  if (!visible.value) return
  const point = { x: event.clientX, y: event.clientY }

  // On the panel: reading it. The panel's own mouseleave takes it from here.
  const panel = tooltipElRef.value?.getBoundingClientRect()
  if (panel && isPointInRect(point, panel, PANEL_HALO)) {
    clearTravelGrace()
    return
  }

  // Still on (or back on) the trigger.
  const trigger = anchorEl()?.getBoundingClientRect()
  if (trigger && isPointInRect(point, trigger)) {
    clearTravelGrace()
    return
  }

  // On a sibling trigger. In a vertical list the next row sits squarely inside
  // the wedge, so geometry alone would keep this panel up while the row below
  // opens its own — two panels at once, describing different things. Whatever
  // the pointer is now over wins, and this stays ahead of the wedge test so
  // that switching rows is always instant.
  if (isPointOnAnotherTrigger(point, registration)) {
    hideNow()
    return
  }

  // In the gap between trigger and panel, on the way there. Rebuild the wedge
  // from here rather than reusing the one anchored at the original exit: as the
  // pointer closes on the panel the wedge narrows with it, so it keeps tracking
  // the actual remaining path instead of sheltering an ever-wider region the
  // pointer has no intention of crossing.
  if (panel && safeTriangle && isPointInTriangle(point, safeTriangle)) {
    safeTriangle = buildSafeTriangle(point, panel, actualPosition.value)
    armHideTimer(TRAVEL_GRACE_MS)
    return
  }

  // Nowhere that justifies staying open.
  hideNow()
}

function onWrapperEnter() {
  if (props.triggerEl) return
  handleMouseEnter()
}

function onWrapperLeave(event: MouseEvent) {
  if (props.triggerEl) return
  handleMouseLeave(event)
}

function handleMouseEnter() {
  if (props.disabled) return
  clearTravelGrace()
  cancelShowTimer()
  showTimer = setTimeout(() => {
    // Only one interactive panel at a time; the previous one is describing
    // something the pointer has left.
    if (props.interactive) hideOtherInteractiveTooltips(registration)
    updatePosition()
    visible.value = true
    // The first pass had no element to measure and fell back to a guessed
    // height, which misplaces a tall panel near the top or bottom of a list.
    // Re-run once it exists, in the same frame, so the clamp uses real numbers.
    void nextTick(() => {
      if (visible.value) updatePosition()
    })
  }, props.delay)
}

function handleMouseLeave(event: MouseEvent) {
  cancelShowTimer()
  if (!props.interactive || !visible.value) {
    hideNow()
    return
  }

  const panel = tooltipElRef.value?.getBoundingClientRect()
  if (!panel) {
    hideNow()
    return
  }

  // Check here as well as during travel: a pointer that flicks to the next row
  // and stops produces no further mousemove, so waiting for one would leave
  // this panel up until the grace timer expires.
  const leavePoint = { x: event.clientX, y: event.clientY }
  if (isPointOnAnotherTrigger(leavePoint, registration)) {
    hideNow()
    return
  }

  safeTriangle = buildSafeTriangle(leavePoint, panel, actualPosition.value)
  armHideTimer(TRAVEL_GRACE_MS)
}

/** The pointer reached the tooltip; it stays up until the pointer leaves it. */
function handleTooltipEnter() {
  if (!props.interactive) return
  clearTravelGrace()
}

/**
 * Closing is left to the pointer arbiter rather than done here: this fires for
 * a cursor that merely grazed an edge just as readily as for one that left, and
 * only the next position tells the two apart. The timer is the backstop for
 * when no next position arrives.
 */
function handleTooltipLeave() {
  if (!props.interactive) return
  safeTriangle = null
  armHideTimer(PANEL_EXIT_GRACE_MS)
}

/**
 * Keeps a vertically centred tooltip inside the viewport. Measures the
 * rendered element when one exists, falling back to a rough height on the
 * first show (before it has been laid out).
 */
function clampVerticalCenter(center: number, padding: number): number {
  const height = tooltipElRef.value?.offsetHeight ?? 120
  const half = height / 2
  const min = padding + half
  const max = window.innerHeight - padding - half
  if (max < min) return center
  return Math.min(Math.max(center, min), max)
}

/**
 * The horizontal twin of `clampVerticalCenter`, for the top / bottom placements.
 * Those are centred on the trigger and only ever *flipped* vertically — nothing
 * held them inside the viewport sideways, so a long tooltip on a trigger near
 * the window edge ran off and got cut. Same padding budget as the vertical one.
 */
function clampHorizontalCenter(center: number, padding: number): number {
  // `|| 200` and not `?? 200`: on the first pass the element is not laid out
  // yet and reports 0 — a zero half-width would silently disable the clamp.
  // `handleMouseEnter` re-runs this on nextTick with the real number.
  const width = tooltipElRef.value?.offsetWidth || 200
  const half = width / 2
  const min = padding + half
  const max = window.innerWidth - padding - half
  // Wider than the viewport: no clamp can satisfy both edges — leave it centred
  // rather than pinning it to one side (identical bail-out to the vertical one).
  if (max < min) return center
  return Math.min(Math.max(center, min), max)
}

/** What the tooltip hovers on. Never the virtual anchor — see the prop's note. */
function anchorEl(): HTMLElement | null {
  return props.triggerEl ?? wrapperRef.value
}

/**
 * What the tooltip *measures against*. A virtual anchor is a zero-sized rect at
 * the point, exactly like `toAnchorRect()` in the floating kernel, so every
 * placement branch below reads it without a second code path.
 */
function anchorRect(): AnchorBox | null {
  const point = props.virtualAnchor
  if (point) {
    return {
      top: point.y, bottom: point.y, left: point.x, right: point.x, width: 0, height: 0,
    }
  }
  return anchorEl()?.getBoundingClientRect() ?? null
}

function updatePosition() {
  const rect = anchorRect()
  if (!rect) return

  const padding = 8

  // Handle left/right positions. These are vertically centred on the trigger,
  // which overflows the viewport for a tall tooltip near the top or bottom of
  // a list — clamp the centre so the whole panel stays on screen.
  if (props.position === 'left' || props.position === 'right') {
    actualPosition.value = props.position
    horizontalClampShift.value = 0
    tooltipPosition.value = {
      top: clampVerticalCenter(rect.top + rect.height / 2, padding),
      left: props.position === 'left' ? rect.left - padding : rect.right + padding
    }
    return
  }

  // Handle top/bottom positions
  const tooltipHeight = 32 // approximate tooltip height
  const spaceAbove = rect.top

  // Centred on the trigger, then clamped sideways: the vertical axis has flip,
  // the horizontal axis has only this — without it a long tooltip on an edge
  // trigger overflows the window and gets cut.
  const anchorCenterX = rect.left + rect.width / 2
  const left = clampHorizontalCenter(anchorCenterX, padding)
  horizontalClampShift.value = left - anchorCenterX

  // Determine position based on available space
  if (props.position === 'top' && spaceAbove > tooltipHeight + padding) {
    actualPosition.value = 'top'
    tooltipPosition.value = { top: rect.top - padding, left }
  } else if (props.position === 'bottom' || spaceAbove <= tooltipHeight + padding) {
    actualPosition.value = 'bottom'
    tooltipPosition.value = { top: rect.bottom + padding, left }
  } else {
    actualPosition.value = 'top'
    tooltipPosition.value = { top: rect.top - padding, left }
  }
}

const tooltipStyle = computed(() => {
  const pos = actualPosition.value
  if (pos === 'left') {
    return {
      top: `${tooltipPosition.value.top}px`,
      left: `${tooltipPosition.value.left}px`,
      transform: 'translate(-100%, -50%)'
    }
  }
  if (pos === 'right') {
    return {
      top: `${tooltipPosition.value.top}px`,
      left: `${tooltipPosition.value.left}px`,
      transform: 'translate(0, -50%)'
    }
  }
  return {
    top: `${tooltipPosition.value.top}px`,
    left: `${tooltipPosition.value.left}px`,
    transform: pos === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)'
  }
})

const arrowStyle = computed(() => {
  const pos = actualPosition.value
  if (pos === 'left') {
    return {
      top: '50%',
      left: '100%',
      transform: 'translateY(-50%) rotate(90deg)'
    }
  }
  if (pos === 'right') {
    return {
      top: '50%',
      right: '100%',
      left: 'auto',
      transform: 'translateY(-50%) rotate(-90deg)'
    }
  }
  // The panel may have been pushed sideways by the viewport clamp; the arrow
  // points at the trigger, not at the panel's own middle, so it walks back by
  // exactly that shift.
  const back = -horizontalClampShift.value
  const left = back === 0
    ? '50%'
    : `calc(50% ${back < 0 ? '-' : '+'} ${Math.abs(back)}px)`
  return {
    top: pos === 'top' ? '100%' : 'auto',
    bottom: pos === 'bottom' ? '100%' : 'auto',
    left,
    transform: pos === 'top' ? 'translateX(-50%)' : 'translateX(-50%) rotate(180deg)'
  }
})

function bindTrigger(element: HTMLElement | null | undefined) {
  if (!element) return
  element.addEventListener('mouseenter', handleMouseEnter)
  element.addEventListener('mouseleave', handleMouseLeave)
}

function unbindTrigger(element: HTMLElement | null | undefined) {
  if (!element) return
  element.removeEventListener('mouseenter', handleMouseEnter)
  element.removeEventListener('mouseleave', handleMouseLeave)
}

watch(
  () => props.triggerEl,
  (next, previous) => {
    unbindTrigger(previous)
    // The ref resolves after mount, so this fires once with the real element.
    bindTrigger(next)
    if (!next) hideNow()
  },
  { immediate: true },
)

/**
 * Follows the trigger while the panel is up. The panel is `position: fixed` at
 * coordinates taken once at open time, so scrolling the list it is anchored to
 * would otherwise strand it beside whatever row has since taken that spot.
 * Capture phase because the scrolling container is an ancestor of the trigger,
 * and scroll events from it do not bubble.
 */
function handleViewportChange() {
  if (visible.value) updatePosition()
}

/**
 * A moving virtual anchor is the whole point of one (the cursor over a chart),
 * so it re-places while up. Same shape as the kernel's anchor watcher: compare
 * the coordinates, not the object — a fresh `{x, y}` every mousemove would
 * otherwise re-place on frames where nothing moved.
 */
watch(
  () => props.virtualAnchor ? `${props.virtualAnchor.x},${props.virtualAnchor.y}` : null,
  () => {
    if (visible.value) updatePosition()
  },
)

watch(visible, (isVisible) => {
  if (isVisible) {
    document.addEventListener('mousemove', handlePointerMove)
    document.addEventListener('scroll', handleViewportChange, { capture: true, passive: true })
    window.addEventListener('resize', handleViewportChange, { passive: true })
  } else {
    document.removeEventListener('mousemove', handlePointerMove)
    document.removeEventListener('scroll', handleViewportChange, { capture: true })
    window.removeEventListener('resize', handleViewportChange)
  }
})

watch(
  () => props.interactive,
  (isInteractive) => {
    if (isInteractive) registerInteractiveTooltip(registration)
    else unregisterInteractiveTooltip(registration)
  },
  { immediate: true },
)

onUnmounted(() => {
  cancelShowTimer()
  clearTravelGrace()
  document.removeEventListener('mousemove', handlePointerMove)
  document.removeEventListener('scroll', handleViewportChange, { capture: true })
  window.removeEventListener('resize', handleViewportChange)
  unbindTrigger(props.triggerEl)
  unregisterInteractiveTooltip(registration)
})

watch(() => props.disabled, (d) => {
  if (d) {
    cancelShowTimer()
    hideNow()
  }
})
</script>

<style scoped>
.tooltip-wrapper {
  display: inline-flex;
  flex-shrink: 0;
}

/* Driven by an external trigger: render nothing here, or the empty box would
   still take a slot in the parent's flex row (and pick up its gap). The
   teleported panel is unaffected by this. */
.tooltip-wrapper-detached {
  display: none;
}

.tooltip {
  /* 2026-08-11 用户拍板:弃反色小卡,并入统一浮层面(与菜单/下拉同族)。
     文字回正色、边框走 subtle、投影走 floating 配方 —— tooltip 从此就是
     "最小号的浮层",壁纸模式下随浮层家族一起磨砂(反色豁免同步收回,
     见 wallpaper.css E 级)。旧的 --ui-surface-tooltip-* 反色 token 族保留
     不删:主题层仍在产出,想回反色改回这四行即可。 */
  --tooltip-bg: var(--ui-surface-menu-bg, var(--ui-surface-floating-bg));
  --tooltip-fg: var(--ui-text-primary-fg);
  --tooltip-border: var(--ui-border-subtle-border);
  --tooltip-shadow: var(--shadow-floating);

  position: fixed;
  z-index: var(--z-tooltip);
  padding: 6px 10px;
  /* `width: max-content` 是水平 clamp 的另一半:面板是 fixed 定位,不写它,
     贴近右缘时自然宽度会先被「left → 视口右缘」的剩余空间压扁成一列窄条,
     量出来的宽度让 clamp 误以为装得下(真机实锤)。max-content 让宽度只由
     内容决定,clamp 才有真实数字可用;max-width 兜住长文案。 */
  width: max-content;
  max-width: min(260px, calc(100vw - 24px));
  font-size: 12px;
  font-weight: 500;
  color: var(--tooltip-fg);
  background: var(--tooltip-bg);
  border: 0.5px solid var(--tooltip-border);
  border-radius: 6px;
  white-space: pre-line;
  pointer-events: none;
  box-shadow: var(--tooltip-shadow);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

/* Rich content sizes itself and drops the chrome meant for a one-line label:
   the arrow reads as noise against a multi-line card. */
.tooltip-interactive {
  pointer-events: auto;
}

.tooltip-rich {
  padding: 0;
  font-weight: 400;
  white-space: normal;
  background: transparent;
  border: none;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.tooltip-arrow {
  position: absolute;
  left: 50%;
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 5px solid var(--tooltip-bg);
}

/* Transition */
.tooltip-fade-enter-active,
.tooltip-fade-leave-active {
  transition: opacity var(--duration-normal) var(--ease-default);
}

.tooltip-fade-enter-from,
.tooltip-fade-leave-to {
  opacity: 0;
}
</style>

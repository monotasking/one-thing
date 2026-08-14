<template>
  <div
    ref="rootRef"
    class="process-rail"
    :class="{ 'is-open': expanded, 'is-solo': solo }"
  >
    <button
      v-if="!solo"
      type="button"
      class="process-rail-header"
      :aria-expanded="expanded"
      @click.stop="toggle"
    >
      <svg
        class="process-rail-chevron"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="9 6 15 12 9 18" />
      </svg>
      <span class="process-rail-summary">{{ summary }}</span>
      <!-- Duration sits outside the uppercased summary so the unit keeps
           its lowercase "s" (3.9s, not 3.9S). -->
      <span
        v-if="duration"
        class="process-rail-duration"
      >{{ duration }}</span>
      <span
        v-if="failedCount > 0"
        class="process-rail-failed"
      >
        <span
          class="process-rail-failed-dot"
          aria-hidden="true"
        />
        {{ failedCount }} 失败
      </span>
      <span
        v-if="streaming"
        class="process-rail-live"
        aria-hidden="true"
      />
    </button>
    <div
      v-if="hasBeenOpen"
      v-show="expanded || solo"
      class="process-rail-body"
      role="list"
    >
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { getExpansionIntent, setExpansionIntent } from '@/stores/helpers/expansion-intent'
import { beginCollapseCompensation } from '@/utils/collapse-compensation'
import { useDeferredAutoCollapse } from '@/composables/useDeferredAutoCollapse'

/**
 * Groups a run of "process" parts (reasoning + tool steps) behind a single
 * summary line, indented on a rail. The rail's own left border is the ONLY
 * vertical line in the whole process area — nested content (thought bodies,
 * tool details) expresses hierarchy with indent + tinted surfaces, enforced
 * by the :deep overrides below.
 *
 * Auto-open while streaming, auto-collapse when the stream ends; a manual
 * toggle wins permanently from then on — the stream boundary must never undo
 * what the user asked for. `solo` (single-step process) skips the summary
 * header entirely and always shows the row.
 */
interface Props {
  summary: string
  duration?: string
  streaming?: boolean
  solo?: boolean
  failedCount?: number
  /**
   * Stable address for the user's expansion intent. The local ref alone was
   * not enough: the rail remounts whenever its key changes, and a remount
   * silently reinstated "auto-open while streaming" over a user's collapse.
   * Omit it and the rail behaves exactly as before (local state only).
   */
  intentKey?: string
}

const props = withDefaults(defineProps<Props>(), {
  duration: '',
  streaming: false,
  solo: false,
  failedCount: 0,
  intentKey: '',
})

const rootRef = ref<HTMLElement | null>(null)
const userToggled = ref<boolean | null>(null)
let manualToggle = false

/**
 * 挂起中的自动收起:流已经结束(auto 想收),但用户正看着这条 rail,于是先
 * 保持展开。门在 `useDeferredAutoCollapse` 里,这里只是它在合成态里的那一票。
 */
const deferredOpen = ref(false)

const autoOpen = computed(() => Boolean(props.streaming))

// 用户 intent > deferredOpen > auto。
const expanded = computed(() => {
  const recorded = getExpansionIntent(props.intentKey)
  if (recorded !== undefined) return recorded
  if (userToggled.value !== null) return userToggled.value
  return autoOpen.value || deferredOpen.value
})

const RAIL_GATE_KEY = 'rail'
const autoCollapseGate = useDeferredAutoCollapse<string>({
  onDefer: () => {
    deferredOpen.value = true
  },
  // 放行(收起)与取消(用户介入 / 新一轮 streaming)都只是丢掉"保持展开"
  // 这一票;要不要真收由合成态说了算,补偿由下面那个 watcher 照常兜。
  onRelease: () => {
    deferredOpen.value = false
  },
})

/** 展开态此刻是否由 auto 说了算(用户表过态就没有"自动收起"可言)。 */
function autoOwnsExpansion(): boolean {
  return getExpansionIntent(props.intentKey) === undefined && userToggled.value === null
}

/**
 * 可见性门。**同步** flush 是刻意的:auto 想收的那一刻(streaming 翻假)就把
 * 裁决做完,`expanded` 才不会先翻假、再被挂起翻回真 —— 下面那个补偿 watcher
 * 看到的每一次 true→false 都是"这次真收"。此刻 DOM 还是展开态,几何量得准。
 */
watch(autoOpen, (streaming, prev) => {
  if (streaming) {
    // 新一轮 streaming 又把它自动展开了 —— 上一轮的挂起作废。
    autoCollapseGate.cancel(RAIL_GATE_KEY)
    deferredOpen.value = false
    return
  }
  if (!prev || !autoOwnsExpansion()) return
  autoCollapseGate.request(RAIL_GATE_KEY, rootRef.value)
}, { flush: 'sync' })

function toggle() {
  const next = !expanded.value
  manualToggle = true
  // 用户意图直接生效:挂起取消(cancel 会把 deferredOpen 归零)。
  autoCollapseGate.cancel(RAIL_GATE_KEY)
  userToggled.value = next
  setExpansionIntent(props.intentKey, next)
}

/**
 * 流结束时整条 rail(可能几百 px)塌成一行 summary —— 用户正在读的是 rail
 * **下方**流出的结果文本,内容会猛地上移。这是最典型的"自动塌缩"。
 *
 * pre-flush watcher 在 DOM 还是旧高度时量一次,nextTick 后把差值还给 scrollTop。
 * 手动点收起(`toggle`)置旗跳过:那是用户自己要的。
 *
 * 挂起中的那次收起被上面的门拦在 `expanded` 之外,所以这里看到的每一次
 * true→false 都是"这次真收" —— 补偿规范本身一个字没改。
 */
watch(expanded, (next, prev) => {
  const wasManual = manualToggle
  manualToggle = false
  if (wasManual || !prev || next) return
  const apply = beginCollapseCompensation(rootRef.value)
  if (!apply) return
  void nextTick(() => {
    apply()
  })
})

// The body mounts lazily (a collapsed historical rail costs nothing) but is
// never unmounted once opened: everything inside — tool panels, thought
// blocks — owns its own expansion state, and v-if would throw that away.
// A user who expanded a tool call mid-stream must find it still expanded
// after the rail auto-collapses and they reopen it.
const hasBeenOpen = ref(false)
watch(() => expanded.value || props.solo, (open) => {
  if (open) hasBeenOpen.value = true
}, { immediate: true })
</script>

<style scoped>
.process-rail {
  margin: 2px 0;
  /* @container queries inside the steps resolve against the rail (the
     timeline's own container-type is cancelled below: its style containment
     would trap the ledger counter, so the container role moves up here —
     one level above the counter scope on the body). */
  container-type: inline-size;
}

/* The header is the frame's top edge in BOTH states: a dashed rule runs
   through the summary (10px stub left, fill right). Expanding only attaches
   the body's remaining three sides below — the header box never changes, so
   the label cannot shift; no knockout background needed either. */
.process-rail-header {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 24px;
  padding: 0;
  border: none;
  border-radius: 0;
  background: none;
  color: var(--ui-text-muted-fg);
  /* Process summary is chrome: UI sans, not the reading font. */
  font-family: var(--font-sans, inherit);
  font-size: var(--type-meta-size);
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
}

/* Hover: text brightens only — no background band in either state. */
.process-rail-header:hover {
  color: var(--ui-text-primary-fg);
}

.process-rail-header::before,
.process-rail-header::after {
  content: '';
  align-self: center;
  border-top: 1px dashed color-mix(in srgb, var(--ui-border-strong-border, var(--ui-border-default-border)) 55%, transparent);
}

.process-rail-header::before {
  flex: 0 0 10px;
}

.process-rail-header::after {
  flex: 1 1 auto;
}

.process-rail-chevron {
  flex-shrink: 0;
  transition: transform var(--duration-normal) var(--ease-default);
}

.process-rail.is-open .process-rail-chevron {
  transform: rotate(90deg);
}

.process-rail-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ledger-label-font, var(--font-mono, monospace));
  font-size: var(--ledger-label-size, 10px);
  font-weight: var(--ledger-label-weight, 600);
  letter-spacing: var(--ledger-label-tracking, 0.14em);
  text-transform: uppercase;
}

.process-rail-duration {
  flex-shrink: 0;
  font-family: var(--ledger-label-font, var(--font-mono, monospace));
  font-size: var(--ledger-label-size, 10px);
  font-weight: var(--ledger-label-weight, 600);
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
}

.process-rail-failed {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--type-meta-size);
  color: var(--ui-status-danger-fg);
}

.process-rail-failed-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ui-status-danger-fg);
}

.process-rail-live {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ui-accent-primary-fg);
  animation: process-rail-pulse 1.2s ease-in-out infinite;
}

@keyframes process-rail-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .process-rail-live {
    animation: none;
  }

  .process-rail-chevron {
    transition: none;
  }
}

/* Blueprint group frame: the header's dashed rule is the top edge; the body
   supplies the other three sides, pulled up so its side borders meet the
   rule at the header's vertical center (24px header → −12px). */
.process-rail-body {
  position: relative;
  margin: -12px 0 4px;
  padding: 18px 12px 8px;
  border: 1px dashed color-mix(in srgb, var(--ui-border-strong-border, var(--ui-border-default-border)) 55%, transparent);
  border-top: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* Ledger numbering runs across the whole group, not per step-timeline.
     No containment here: it would trap the counter (see .process-rail). */
  counter-reset: tool-fig;
}

.process-rail-body :deep(.tool-activity-timeline) {
  counter-reset: none;
}

/* Solo (single step): no frame — the step's own figure frame is enough. */
.process-rail.is-solo .process-rail-body {
  margin: 0;
  padding: 0;
  border: none;
}

/* ========================================================================
   Flat-timeline overrides — "one container, one line".
   Scoped to .process-rail-body so components keep their own styling
   everywhere outside the rail.
   ======================================================================== */

/* Neutralize block margins the children bring along; the body's 2px gap
   owns the rhythm. */
.process-rail-body :deep(.tool-activity-timeline),
.process-rail-body :deep(.inline-reasoning) {
  margin: 0;
}

/* Thought full text paints itself (`.thought-body`, published by
   ThoughtHeader.vue — the same skin the top-of-message thought wears);
   the rail only indents it onto the rail column. */
.process-rail-body :deep(.inline-reasoning-content) {
  margin: 2px 0 6px 22px;
}

/* Tool detail pane: the figure frame styles itself (ToolStepDetails);
   the rail only positions it. */
.process-rail-body :deep(.tool-step-details) {
  margin: 8px 0 8px 22px;
}

/* Timeline row rhythm: uniform 24px rows; icon and text share a vertical
   center (the row's default flex-start top-aligns the 18px icon against
   22px text and reads as misaligned). */
.process-rail-body :deep(.operation-row) {
  min-height: 24px;
  align-items: center;
}
</style>

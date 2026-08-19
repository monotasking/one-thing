<template>
  <div
    v-if="hasVisibleContent"
    ref="bubbleRef"
    class="bubble"
    :class="{ editing: isEditing, [role]: true }"
    @mouseup="handleTextSelection"
  >
    <!-- Skill usage badge -->
    <div
      v-if="skillUsed && role === 'assistant'"
      class="skill-badge"
    >
      <svg
        class="skill-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
      <span class="skill-name">{{ skillUsed }}</span>
    </div>

    <!-- Edit mode for user messages -->
    <MessageInlineEdit
      v-if="isEditing"
      :initial-content="editContent || content"
      :boundary="bubbleRef"
      @submit="emit('submitEdit', $event)"
      @cancel="emit('cancelEdit')"
    />

    <!-- Normal display -->
    <div
      v-else
      class="content-display"
      @click="handleContentClick"
    >
      <!-- Collapsible wrapper (only for user messages) -->
      <div
        ref="contentRef"
        class="content-wrapper"
        :class="{
          collapsed: role === 'user' && isCollapsed && isOverflowing && !isStreaming,
          'has-overflow': role === 'user' && isOverflowing
        }"
        :style="role === 'user' && isCollapsed && isOverflowing && !isStreaming ? { maxHeight: maxCollapsedHeight + 'px' } : {}"
      >
        <!-- New contentParts-based rendering (2026-08-19 regrouping).

             Assistant turns split in two at the LAST tool round:
               · the WORK GROUP — top thought, inline thoughts, every tool
                 round and the interim narration between them — behind one
                 "Working · 12s" / "Worked · 41s" header (ProcessRail);
               · the TAIL — the answer after the last tool round — at full
                 volume, the only thing left on the page once the group folds.
             Thoughts and tool rounds are separate rows inside the group;
             nothing merges them into a per-run summary any more.

             The rail is ALWAYS mounted for assistant messages and runs
             frameless (`solo`) until the first tool row exists: the top
             thought lives inside it from the first frame, so the moment the
             turn starts calling tools the header appears around content that
             is already there instead of remounting it. -->
        <ProcessRail
          v-if="role === 'assistant'"
          class="work-group"
          :solo="!hasWorkGroup"
          :summary="workSummary"
          :duration="workDuration"
          :streaming="isWorkLive"
          :failed-count="workFailedCount"
          :intent-key="workIntentKey"
        >
          <!-- Top-of-message thought (`message.reasoning`), handed in by
                 MessageItem — it stays a MessageItem concern, only its place
                 in the flow moved into the group. -->
          <slot name="thinking" />
          <template
            v-for="{ part, key } in workEntries"
            :key="key"
          >
            <!-- Inline reasoning parts. Controlled by the expansion
                   intent record so a remount cannot undo a user's click. -->
            <InlineThought
              v-if="part.type === 'reasoning'"
              :name="key"
              :content="part.content"
              :expanded="inlineReasoningExpanded(key)"
              :live="isWorkLive"
              :live-markdown="shouldUseStreamingMarkdown(false)"
              :is-streaming="Boolean(isStreaming)"
              @update:expanded="(v: boolean) => setInlineReasoningExpanded(key, v)"
            />
            <!-- Tool activity — ONE render point. A row that starts as a
                   streaming-input synthetic step and later gains a real
                   step stays in THIS panel (same NestedCollapseGroup, same
                   `activity-<toolCallId>` key): it evolves in place instead
                   of moving house between two panels. See stepsByEntry. -->
            <StepsPanel
              v-else-if="entryStepsFor(key).length > 0"
              :steps="entryStepsFor(key)"
              :session-id="sessionId"
              :intent-scope="stepsIntentScope"
              :parent-intent-ids="workParentIntentIds"
              flat
              @open-file="(filePath) => emit('openFile', filePath)"
            />
            <!-- Interim narration between tool rounds and any indicator
                   that landed before the last round: same renderers as the
                   tail, just inside the group. -->
            <ContentPartView
              v-else-if="isContentPart(part)"
              :part="part"
              :is-user="false"
              :live="shouldUseStreamingMarkdown(false)"
              :is-streaming="Boolean(isStreaming)"
            />
          </template>
        </ProcessRail>

        <div
          v-if="tailEntries.length > 0"
          class="other-parts-container"
        >
          <template
            v-for="{ part, key } in tailEntries"
            :key="key"
          >
            <!-- A user message never has a work group, so an assistant
                   tail is content-only by construction; the reasoning branch
                   below covers the tool-less inline thought (rare: text →
                   thought → text with no tool between). -->
            <InlineThought
              v-if="part.type === 'reasoning'"
              :name="key"
              :content="part.content"
              :expanded="inlineReasoningExpanded(key)"
              :live="Boolean(isStreaming)"
              :live-markdown="shouldUseStreamingMarkdown(false)"
              :is-streaming="Boolean(isStreaming)"
              @update:expanded="(v: boolean) => setInlineReasoningExpanded(key, v)"
            />
            <ContentPartView
              v-else-if="isContentPart(part)"
              :part="part"
              :is-user="role === 'user'"
              :live="shouldUseStreamingMarkdown(role === 'user')"
              :is-streaming="Boolean(isStreaming)"
            />
          </template>
        </div>
        <!-- Fallback for messages without contentParts (user messages and
             empty edge cases). Assistant messages always have contentParts
             populated by rebuildContentParts before reaching here, so no
             tool-call rendering is needed in this branch. -->
        <div
          v-else-if="!(contentParts && contentParts.length > 0)"
          class="content md-code-block-scope md-inline-code-scope"
        >
          <MessageMarkdown
            :content="content"
            :is-user="role === 'user'"
            :live="shouldUseStreamingMarkdown(role === 'user')"
            :is-streaming="Boolean(isStreaming)"
          />
        </div>
      </div>

      <!-- Collapse/Expand button (only for user messages) -->
      <Button
        v-if="role === 'user' && isOverflowing && !isStreaming"
        unstyled
        class="collapse-toggle"
        :class="{ collapsed: isCollapsed }"
        @click.stop="toggleCollapse"
      >
        <svg
          class="collapse-icon"
          :class="{ rotated: !isCollapsed }"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span>{{ isCollapsed ? 'Show more' : 'Show less' }}</span>
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import { ref, computed, onBeforeUnmount, watch } from 'vue'
import StepsPanel from '../StepsPanel.vue'
import MessageInlineEdit from './MessageInlineEdit.vue'
import MessageMarkdown from './MessageMarkdown.vue'
import ProcessRail from './ProcessRail.vue'
import InlineThought from './InlineThought.vue'
import ContentPartView, { CONTENT_PART_TYPES } from './ContentPartView.vue'
import type { ToolCall, Step, ContentPart } from '@/types'
import type { AnchorRect } from '@/composables/floating/compute-position'
import { buildWorkRender, buildWorkSummary } from '@/stores/helpers/work-group'
import { formatDuration } from '@/utils/format-duration'
import { getExpansionIntent, setExpansionIntent } from '@/stores/helpers/expansion-intent'
import { useCollapsibleContent } from '@/composables/useCollapsibleContent'
import { hasVisibleReasoningContent } from './reasoning-summary'

interface Props {
  role: 'user' | 'assistant'
  content: string
  contentParts?: ContentPart[]
  toolCalls?: ToolCall[]
  steps?: Step[]
  skillUsed?: string
  isStreaming?: boolean
  isEditing?: boolean
  editContent?: string
  sessionId?: string  // Session ID for AgentExecutionPanel state management
  /** Stable address space for expansion-intent records (see expansion-intent.ts). */
  messageId?: string
  /** The message carries a top-of-message thought (`message.reasoning`) — the
   *  #thinking slot has something to render and counts as one 思考 step. */
  hasThinking?: boolean
  /** When the turn started (message timestamp): the work timer's origin. */
  startedAt?: number
}

const props = defineProps<Props>()

const emit = defineEmits<{
  submitEdit: [content: string]
  cancelEdit: []
  openMedia: [payload: { src: string; alt?: string; fileName?: string; mediaId?: string }]
  /** The selection's own box, in viewport coordinates — where the toolbar
   *  lands is the floating kernel's call, not this component's. */
  textSelection: [text: string, rect: AnchorRect]
  executeTool: [toolCall: ToolCall]
  openFile: [filePath: string]
}>()

const bubbleRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)
const hasBeenStreaming = ref(Boolean(props.isStreaming))

// Collapsible content (only user messages collapse)
const shouldTrackOverflow = computed(() => props.role === 'user')
const { isCollapsed, isOverflowing, toggleCollapse, maxCollapsedHeight } = useCollapsibleContent({
  contentRef,
  enabled: shouldTrackOverflow,
  isStreaming: () => Boolean(props.isStreaming),
  content: () => props.content,
})

// Every part flows through `otherPartEntries` in order — the old
// "first text part rendered separately" path is gone: with a work group the
// opening text belongs INSIDE the group (it precedes the last tool round),
// and rendering it elsewhere would remount it the moment the first tool
// call arrived.
//
// Keys derive from the part's position among the ANCHOR parts (or from an id
// it carries). Position among *all* parts is not usable: indicator parts
// (waiting / image-loading / plugin-status) are spliced out of the array by
// `removeTransientIndicators` when the stream ends, which shifts every index
// behind them and remounts half the message right at the stream boundary.
// The counter therefore skips those three types outright — by TYPE, not by
// the current value of `isTransientPart`: a plugin-status stops being
// transient the moment it settles (durationMs), and a predicate that flips
// mid-stream would shift the very indices it is meant to pin. The three
// skipped types carry ids of their own (turnIndex / pluginId+id), so nothing
// downgrades to a positional key.
const otherPartEntries = computed(() => {
  const parts = props.contentParts
  if (!parts) return []
  let sawVisiblePartBeforeWaiting = false
  let stableIndex = -1
  const entries: { part: ContentPart; key: string }[] = []

  parts.forEach((p) => {
    if (isAnchorPart(p)) stableIndex++
    const sourceIndex = stableIndex

    if (p.type === 'provider-data') {
      return
    }
    // 已撤下的插件状态留在数组里(保持 append-only,见 applyPluginStatus),
    // 但不渲染 —— 流结束时会被 removeTransientIndicators 统一收走。
    if (p.type === 'plugin-status' && p.cleared) {
      return
    }

    if (p.type === 'reasoning' && !hasVisibleReasoningContent(p.content)) {
      return
    }

    // Skip the initial waiting (handled by MessageThinking)
    if (p.type === 'waiting' && !sawVisiblePartBeforeWaiting) {
      return
    }

    if (p.type !== 'waiting') {
      sawVisiblePartBeforeWaiting = true
    }
    entries.push({ part: p, key: getOtherPartKey(p, sourceIndex) })
  })

  return entries
})

// ============ Work group (2026-08-19) ============
// An assistant turn splits in two at the LAST tool round: the work group
// (thoughts + tool rounds + interim narration, behind one Working/Worked
// header) and the tail (the answer after the last round, full volume).

/**
 * Parts that anchor a render key. The three indicator types are excluded:
 * they are spliced away at stream end, so neither the positional counter nor
 * a group's key may hang off them.
 */
function isAnchorPart(part: ContentPart): boolean {
  return part.type !== 'waiting'
    && part.type !== 'image-loading'
    && part.type !== 'plugin-status'
}

function isContentPart(part: ContentPart): boolean {
  return CONTENT_PART_TYPES.has(part.type)
}

const stepByToolCallId = computed(() => {
  const map = new Map<string, Step>()
  for (const step of props.steps ?? []) {
    if (step.toolCallId) map.set(step.toolCallId, step)
  }
  return map
})

/**
 * The work group's whole judgement lives in `buildWorkRender`
 * (`stores/helpers/work-group.ts`) — which entry renders which tool rows, the
 * tally behind the header, and where the group ends and the tail begins. This
 * computed is only its reactive wrapper.
 */
const workRender = computed(() => buildWorkRender({
  entries: otherPartEntries.value,
  role: props.role,
  hasThinking: props.hasThinking,
  findStep: toolCallId => stepByToolCallId.value.get(toolCallId),
  stepsForTurn: getStepsForTurn,
}))

const hasWorkGroup = computed(() => workRender.value.hasWorkGroup)
const workEntries = computed(() => workRender.value.workEntries)
const tailEntries = computed(() => workRender.value.tailEntries)

const EMPTY_STEPS: Step[] = []

function entryStepsFor(key: string): Step[] {
  return workRender.value.stepsByEntry.get(key) ?? EMPTY_STEPS
}

const workFailedCount = computed(() => workRender.value.stats.failedCount)

/** Header detail: what the work consisted of. "思考 3 步 · bash ×5 · read". */
const workSummary = computed(() => buildWorkSummary(workRender.value.stats))

const LIVE_STEP_STATUSES = new Set(['pending', 'running', 'awaiting-confirmation'])
const LIVE_TOOL_STATUSES = new Set(['pending', 'queued', 'executing', 'input-streaming'])

/**
 * The group is live while its OWN work is in flight: a tool still running,
 * or a streaming turn whose newest part is still process (thinking / about
 * to call the next tool). The moment the answer starts streaming after the
 * last round the header settles to "Worked" and the group folds — even
 * though the message as a whole is still streaming. Another tool call after
 * that flips it live again (and the rail re-opens).
 */
const isWorkLive = computed(() => {
  if (!props.isStreaming || !hasWorkGroup.value) return false
  for (const { part } of workEntries.value) {
    if (part.type === 'data-steps') {
      for (const step of getStepsForTurn(part.turnIndex)) {
        if (LIVE_STEP_STATUSES.has(step.status)) return true
      }
    } else if (part.type === 'tool-call') {
      if (part.toolCalls.some(tc => LIVE_TOOL_STATUSES.has(tc.status))) return true
    }
  }
  return tailEntries.value.every(({ part }) => !isAnchorPart(part))
})

// ---- Work duration: ticking while live, frozen at the moment work ended ----
// Live: elapsed since the turn started (`startedAt`, the message timestamp).
// Settled: the value the ticker showed when the group went live→settled in
// this instance; a message mounted already settled (history) falls back to
// the last tool end minus the turn start.
const workElapsedMs = ref(0)
const frozenWorkMs = ref<number | null>(null)
let workTimer: ReturnType<typeof setInterval> | null = null

function tickWork() {
  if (typeof props.startedAt === 'number') workElapsedMs.value = Math.max(0, Date.now() - props.startedAt)
}

function stopWorkTimer() {
  if (!workTimer) return
  clearInterval(workTimer)
  workTimer = null
}

watch(isWorkLive, (live, wasLive) => {
  if (live) {
    frozenWorkMs.value = null
    tickWork()
    if (!workTimer) workTimer = setInterval(tickWork, 250)
    return
  }
  stopWorkTimer()
  if (wasLive) {
    tickWork()
    frozenWorkMs.value = workElapsedMs.value
  }
}, { immediate: true })

onBeforeUnmount(stopWorkTimer)

const workDurationMs = computed<number>(() => {
  if (isWorkLive.value) return workElapsedMs.value
  if (frozenWorkMs.value !== null) return frozenWorkMs.value
  const { lastToolEnd } = workRender.value.stats
  if (typeof props.startedAt === 'number' && lastToolEnd > props.startedAt) return lastToolEnd - props.startedAt
  return 0
})

const workDuration = computed(() => formatDuration(workDurationMs.value, { style: 'work' }))

const useLiveAssistantMarkdown = computed(() =>
  props.role === 'assistant' && hasBeenStreaming.value,
)

function shouldUseStreamingMarkdown(isUser: boolean): boolean {
  return Boolean(props.isStreaming || (!isUser && useLiveAssistantMarkdown.value))
}

// Generate render keys for parts. `sourceIndex` is the part's index among the
// anchor parts of the original contentParts array, which is append-only
// during streaming and therefore stable.
function getOtherPartKey(part: ContentPart, sourceIndex: number): string {
  if (part.type === 'text') return `text-other-${sourceIndex}`
  if (part.type === 'reasoning') return inlineReasoningKey(part, sourceIndex)
  if (part.type === 'prompt-ref') return `prompt-ref-${part.promptId}-${part.bodyHash || sourceIndex}`
  if (part.type === 'skill-ref') return `skill-ref-${part.skillId}-${part.bodyHash || sourceIndex}`
  if (part.type === 'tool-call') return `tool-call-${part.toolCalls.map(tc => tc.id).join('-') || sourceIndex}`
  if (part.type === 'data-steps') return `steps-${part.turnIndex ?? sourceIndex}`
  if (part.type === 'waiting') return `waiting-${part.turnIndex ?? sourceIndex}`
  if (part.type === 'image-loading') return `image-loading-${part.turnIndex ?? sourceIndex}`
  // 按 (pluginId, id) 而不是位置:label 更新时格子必须原地换文案,
  // 用位置做 key 会让它整块重建,动画从头开始。
  if (part.type === 'plugin-status') return `plugin-status-${part.pluginId}-${part.id}`
  return `part-${sourceIndex}`
}

function inlineReasoningKey(part: Extract<ContentPart, { type: 'reasoning' }>, index: number): string {
  // Stable across streaming: a reasoning part keeps its position while its
  // content grows. Keying on the content fingerprint changed the key on every
  // chunk, so an expanded streaming block lost its state and snapped shut —
  // making it impossible to keep the last (still-streaming) thought open.
  return `reasoning-${part.turnIndex ?? index}`
}

// ============ Expansion intent (user record > live auto > static default) ============
// The records live outside the component tree (expansion-intent.ts) so a
// remount — the thing that used to reset every one of these — cannot undo a
// click. Without a messageId there is no stable address space, so the panels
// silently fall back to their own local state (unchanged behaviour).

const stepsIntentScope = computed(() => (props.messageId ? `steps-${props.messageId}` : ''))

const workIntentKey = computed(() => (props.messageId ? `rail-${props.messageId}-work` : ''))

/**
 * The work group this StepsPanel sits in, handed down as its parent intent
 * address: expanding a tool row records the group as expanded too, so the
 * group's "work ends → fold" auto-collapse cannot take the row away.
 * Cached so the prop keeps its identity across re-renders.
 */
const NO_PARENT_INTENTS: string[] = []
const workParentIntentIds = computed<string[]>(() =>
  workIntentKey.value ? [workIntentKey.value] : NO_PARENT_INTENTS,
)

// `key` is already `reasoning-<turnIndex>`; the messageId is spliced in so the
// address reads `reasoning-<messageId>-<turnIndex>`.
function inlineReasoningIntentKey(key: string): string {
  if (!props.messageId) return ''
  return `reasoning-${props.messageId}-${key.replace(/^reasoning-/, '')}`
}

/** `undefined` = uncontrolled: CollapsePanel keeps its own state. */
function inlineReasoningExpanded(key: string): boolean | undefined {
  if (!props.messageId) return undefined
  return getExpansionIntent(inlineReasoningIntentKey(key)) ?? false
}

function setInlineReasoningExpanded(key: string, expanded: boolean): void {
  setExpansionIntent(inlineReasoningIntentKey(key), expanded)
}

const hasVisibleContent = computed(() => {
  // Attachments render outside the bubble (in MessageItem), so an
  // attachment-only user message has no bubble shell at all.
  if (props.isEditing) return true
  if (props.role === 'user') {
    return Boolean(props.content || props.contentParts?.length)
  }
  // The !isStreaming fallback keeps persisted (historical) messages visible
  // even when they carry no content; only a still-empty streaming message
  // hides the bubble.
  return Boolean(
    props.content ||
    props.contentParts?.length ||
    props.hasThinking ||
    !props.isStreaming,
  )
})

watch(
  () => props.isStreaming,
  (isStreaming) => {
    if (isStreaming) hasBeenStreaming.value = true
  },
  { immediate: true },
)

function getStepsForTurn(turnIndex: number | undefined) {
  if (!props.steps) return []
  if (turnIndex === undefined) return props.steps
  return props.steps.filter(step => step.turnIndex === turnIndex)
}

// Text selection
function handleTextSelection() {
  if (props.role !== 'assistant') return

  setTimeout(() => {
    const selection = window.getSelection()
    const text = selection?.toString().trim()

    if (!text || text.length === 0) return

    const range = selection?.getRangeAt(0)
    if (!range) return

    // Report the selection box and stop there. Centering, flipping under the
    // selection when the top is cramped and keeping the bar inside the viewport
    // used to be hand-rolled right here against a *guessed* 320×44 toolbar;
    // it is now `useFloatingLayer` measuring the real one (P6).
    const rect = range.getBoundingClientRect()
    emit('textSelection', text, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    })
  }, 10)
}

function handleContentClick(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target.tagName === 'IMG') {
    const img = target as HTMLImageElement
    const src = img.src
    const alt = img.alt || ''

    // Check if alt text contains mediaId (format: "Generated Image|mediaId:xxx")
    const mediaIdMatch = alt.match(/\|mediaId:([a-f0-9-]+)/)
    if (mediaIdMatch) {
      emit('openMedia', { src, alt, mediaId: mediaIdMatch[1] })
    } else {
      // Non-media image (attachment, external URL, old format)
      emit('openMedia', { src, alt })
    }
  }
}
</script>

<style scoped>
.bubble {
  max-width: 80%;
  padding: var(--message-padding, 14px 18px);
  border-radius: 18px;
  border: 1px solid var(--ui-border-default-border);
  background: var(--ui-surface-elevated-bg);
  position: relative;
  transition: all var(--duration-normal) var(--ease-default);
  box-shadow: var(--ui-message-surface-shadow, var(--shadow));
}

.bubble.editing {
  transition: all var(--duration-normal) var(--ease-default);
}

.bubble.user.editing {
  box-shadow:
    0 4px 12px rgba(0, 0, 0, 0.3),
    0 0 0 2px color-mix(in srgb, var(--ui-accent-primary-fg) 40%, transparent);
}

html[data-theme='light'] .bubble.user.editing {
  box-shadow:
    0 4px 12px rgba(0, 0, 0, 0.04),
    0 0 0 2px color-mix(in srgb, var(--ui-accent-primary-fg) 30%, transparent);
}

/* AI messages: remove bubble styling */
.bubble.assistant {
  max-width: 100%;
  padding: 0;
  border-radius: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  transition: none;
}

/* User message bubble */
.bubble.user {
  /* Blueprint frame: zero fill, one outline. The surface variable stays a
     solid color for the collapse fade mask; behind a transparent bubble the
     visible surface is the chat background, with the solid bubble token as
     fallback (--ui-message-user-solid-bg keeps gradients out of color-mix). */
  --user-bubble-surface: var(--ui-surface-chat-bg, var(--ui-message-user-solid-bg));

  max-width: min(74%, 680px);
  /* A light ink wash inside the frame: the user's voice must be findable
     when scanning — a fully transparent box reads as an empty input, not a
     said thing. */
  background: color-mix(in srgb, var(--ui-text-primary-fg) 4%, transparent);
  /* Skin knob `bubbleRadius` (H3). The fallback IS the app's own value and the
     ONLY copy of it — the `standard` tier deliberately emits no variable, so
     "no plugin" and "plugin picked standard" both land here, byte for byte.
     A plugin only ever picks a tier name; the host looks the value up. */
  border-radius: var(--skin-bubble-radius, var(--radius-xs, 4px));
  border: 1px solid color-mix(in srgb, var(--ui-border-strong-border) 52%, transparent);
  box-shadow: var(--ui-message-user-shadow, none);
  width: fit-content;
  /* Single-character messages ("?") must stay a short entry, not collapse
     into a tall empty square. */
  min-width: 3.5em;
}

html[data-theme='light'] .bubble.user {
  box-shadow: var(--ui-message-user-shadow, 0 4px 12px rgba(0, 0, 0, 0.04));
}

/* Custom text selection highlight for AI messages */
.bubble.assistant ::selection {
  background: color-mix(in srgb, var(--ui-accent-primary-fg) 35%, transparent);
  color: inherit;
}

.bubble.assistant ::-moz-selection {
  background: color-mix(in srgb, var(--ui-accent-primary-fg) 35%, transparent);
  color: inherit;
}

html[data-theme='light'] .bubble.assistant ::selection {
  background: color-mix(in srgb, var(--ui-accent-primary-fg) 25%, transparent);
}

/* Skill badge */
.skill-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: color-mix(in srgb, var(--ui-accent-primary-fg) 10%, transparent);
  border-radius: 12px;
  margin-bottom: 8px;
  font-size: var(--type-caption-muted-size);
  line-height: var(--type-caption-muted-line-height);
  color: var(--ui-accent-primary-fg);
}

.skill-icon {
  width: 14px;
  height: 14px;
}

.skill-name {
  font-weight: var(--type-meta-weight);
}

/* Content display */
.content-display {
  width: 100%;
}

/* Collapsible content wrapper */
.content-wrapper {
  position: relative;
  overflow: visible;
  transition: max-height var(--duration-slow) var(--ease-default);
}

.content-wrapper.collapsed {
  overflow: hidden;
}

.bubble.assistant .content-wrapper {
  overflow: visible;
  transition: none;
}

/* 流内状态那一行的样式随组件搬到了 PluginStatusLine.vue —— scoped 样式跟着它走,
   留在这里只会因为 scoped 属性对不上而静默失效。 */

.image-generation-skeleton {
  position: relative;
  width: min(320px, 70vw);
  max-width: 100%;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  border-radius: 8px;
  border: 1px solid var(--ui-border-default-border);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--ui-accent-primary-fg) 8%, transparent), transparent 36%),
    var(--ui-surface-elevated-bg);
}

.image-generation-skeleton::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.16),
    transparent
  );
  animation: image-skeleton-shimmer 1.25s ease-in-out infinite;
}

html[data-theme='light'] .image-generation-skeleton::after {
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.72),
    transparent
  );
}

@keyframes image-skeleton-shimmer {
  100% {
    transform: translateX(100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .image-generation-skeleton::after {
    animation: none;
  }
}

/* Gradient mask at bottom when collapsed */
.content-wrapper.collapsed::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 60px;
  background: linear-gradient(
    to bottom,
    transparent,
    var(--user-bubble-surface, var(--ui-message-user-solid-bg, var(--ui-surface-chat-bg)))
  );
  pointer-events: none;
}

/* Collapse/Expand button */
.collapse-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  padding: 6px 0 5px;
  margin-top: 2px;
  background: transparent;
  border: none;
  color: color-mix(in srgb, var(--ui-text-muted-fg) 82%, transparent);
  font-size: var(--type-meta-size);
  font-weight: var(--type-meta-weight);
  line-height: var(--type-meta-line-height);
  cursor: pointer;
  transition: color var(--duration-normal) var(--ease-default);
}

.collapse-toggle:hover {
  color: var(--ui-accent-primary-fg);
}

.collapse-icon {
  transition: transform var(--duration-slow) var(--ease-default);
}

.collapse-icon.rotated {
  transform: rotate(180deg);
}

.content {
  --md-code-block-margin: calc(var(--content-spacing-px, 10px) * 0.98) 0;
  --md-code-copy-width: 22px;
  --md-code-copy-height: 21px;
  --md-code-copy-gap: 0;
  --md-code-copy-padding: 0;
  --md-code-copy-justify-content: center;
  --md-code-copy-transition: all var(--duration-normal) var(--ease-default);
  /* copy/copied icon visibility now comes from the shared defaults in markdown.css */
  --md-code-line-height: var(--type-code-line-height-px);
  --md-code-plain-fg: var(--hg-syntax-plain-fg, var(--text-code-block));

  display: flow-root;
  word-wrap: break-word;
  overflow-wrap: anywhere;
  font-family: var(--font-body);
  line-height: var(--message-line-height-px, var(--type-chat-comfortable-line-height-px));
  font-size: var(--message-font-size, var(--type-chat-comfortable-size));
  color: color-mix(in srgb, var(--ui-text-primary-fg) 96%, var(--ui-text-secondary-fg) 4%);
  letter-spacing: 0;
}

/* AI message text */
.bubble.assistant .content {
  color: var(--ui-message-assistant-fg);
}

.bubble.user .content {
  line-height: var(--message-line-height-px, var(--type-chat-comfortable-line-height-px));
  color: var(--ui-message-user-fg);
  /* Manuscript voice: the user's words are set in the display serif,
     independent of the chat reading-font setting. */
  font-family: var(--font-display, var(--font-sans));
}

.inline-reasoning {
  --reasoning-fg: var(--ui-message-thinking-fg);
  margin: 3px 0;
  color: var(--reasoning-fg);
}

/* Header paint and body skin both live in ThoughtHeader.vue (`.thought-header`
   / the unscoped `.thought-body`) so this block and MessageThinking cannot
   drift apart again. Only placement stays here. */
.inline-reasoning-body {
  margin-top: 4px;
}

/* Container for tool-calls, steps, and additional text parts */
.other-parts-container {
  position: relative;
}

/* Markdown content styles — compact for chat context */
.content :deep(p) {
  margin: 0 0 var(--content-paragraph-gap, 8px) 0;
}

.content :deep(p:last-child) {
  margin-bottom: 0;
}

/* Same as markdown.css: a streaming segment's last <p> keeps its gap unless
   the segment is the last one (see .md-segment note there). */
.content :deep(.md-segment:not(:last-of-type) > p:last-child) {
  margin-bottom: var(--content-paragraph-gap, 8px);
}

.content :deep(ul),
.content :deep(ol) {
  margin: var(--content-list-gap, 6px) 0;
  padding-left: 1.5em;
}

.content :deep(li) {
  margin: var(--content-list-item-gap, 2px) 0;
}

.content :deep(h1),
.content :deep(h2),
.content :deep(h3),
.content :deep(h4) {
  max-width: 100%;
  margin: var(--content-heading-top-gap, 8px) 0 var(--content-heading-bottom-gap, 3px) 0;
  font-weight: 620;
  line-height: var(--content-heading-line-height-px, 20px);
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* Chat context: headings are section markers, not page titles */
.content :deep(h1) { font-size: 1.08em; }
.content :deep(h2) { font-size: 1.04em; }
.content :deep(h3) { font-size: 1em; }

.content :deep(h1 + h1),
.content :deep(h1 + h2),
.content :deep(h1 + h3),
.content :deep(h2 + h1),
.content :deep(h2 + h2),
.content :deep(h2 + h3),
.content :deep(h3 + h1),
.content :deep(h3 + h2),
.content :deep(h3 + h3) {
  margin-top: var(--content-list-gap, 6px);
}

/* First heading has no top margin */
.content :deep(h1:first-child),
.content :deep(h2:first-child),
.content :deep(h3:first-child) {
  margin-top: 0;
}

.content :deep(blockquote) {
  margin: var(--content-paragraph-gap, 8px) 0;
  padding: 0.35em 0 0.35em 0.85em;
  border-left: 2px solid color-mix(in srgb, var(--ui-text-muted-fg) 42%, transparent);
  color: color-mix(in srgb, var(--ui-text-secondary-fg) 88%, var(--ui-text-muted-fg) 12%);
  border-radius: 0;
}

.content :deep(a) {
  color: var(--ui-accent-primary-fg);
  text-decoration: none;
}

.content :deep(a:hover) {
  text-decoration: underline;
}

/* Horizontal rule */
.content :deep(hr) {
  border: none;
  height: 1px;
  background: var(--ui-border-default-border);
  margin: var(--content-spacing-px, 11px) 0;
  opacity: 0.3;
}

/* Generated images */
.content :deep(img) {
  max-width: 400px;
  max-height: 400px;
  width: auto;
  height: auto;
  border-radius: 12px;
  margin: 8px 0;
  box-shadow: var(--ui-message-media-shadow, 0 4px 16px rgba(0, 0, 0, 0.2));
  cursor: pointer;
  transition: transform var(--duration-normal) var(--ease-default), box-shadow var(--duration-normal) var(--ease-default);
}

/* C2:两条 hover 阴影原来带字面 rgba 兜底。`--ui-message-media-hover-shadow` 在
   variables.css 的明暗两套里都有定义(575 / 1145 行),兜底从来没被用到 —— 删掉的
   是死码,实色 ΔRGB = 0。
   下面那条 light 规则不能删:它与本条特异性同为 (0,3,1),靠"写在后面"压住 light
   的**静息**阴影(1198 行),否则浅色主题下 hover 会被静息规则吃掉。两条现在同值,
   留着的是层叠次序不是颜色。 */
.content :deep(img:hover) {
  transform: scale(1.02);
  box-shadow: var(--ui-message-media-hover-shadow);
}

html[data-theme='light'] .content :deep(img) {
  box-shadow: var(--ui-message-media-shadow, 0 4px 16px rgba(0, 0, 0, 0.1));
}

html[data-theme='light'] .content :deep(img:hover) {
  box-shadow: var(--ui-message-media-hover-shadow);
}

/* Table styles */
/* Grid table (稿纸): a full but whisper-faint grid — subtle inner lines,
   a slightly darker outer frame, a paper-tinted header band and whisper
   zebra rows. Chosen from the four-scheme mockup in
   docs/design/table-styles/index.html (案三). */
/* The renderer wraps every table in .md-table-scroll; the wrapper scrolls,
   the table keeps real table layout at full column width. */
.content :deep(.md-table-scroll) {
  max-width: 100%;
  overflow-x: auto;
  margin: var(--content-spacing-px, 11px) 0;
}

.content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: var(--content-spacing-px, 11px) 0;
  border: 1px solid var(--ui-table-border, var(--ui-border-default-border));
}

.content :deep(.md-table-scroll > table) {
  margin: 0;
}

.content :deep(th),
.content :deep(td) {
  border: 1px solid var(--ui-border-subtle-border);
  padding: 7px 12px;
  text-align: left;
}

/* Numeric cells (classed by the markdown renderer) never wrap — a broken
   phone number reads as two numbers. Prose cells keep the body's anywhere
   wrapping, so no long-token column can starve the others into single-
   character vertical text. */
.content :deep(.md-cell-numeric) {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.content :deep(td) {
  background: var(--ui-table-row-bg, transparent);
}

.content :deep(tbody tr:nth-child(even) td) {
  background: color-mix(in srgb, var(--ui-table-header-bg, var(--ui-state-hover-bg)) 40%, transparent);
}

.content :deep(th) {
  background: var(--ui-table-header-bg, var(--ui-state-hover-bg));
  border-bottom: 1px solid var(--ui-table-border, var(--ui-border-default-border));
  font-size: 0.9em;
  font-weight: var(--type-body-strong-weight, 600);
  color: var(--ui-text-secondary-fg);
}

/* Code visuals are shared in styles/markdown.css via .md-code-block-scope and .md-inline-code-scope. */

/* MathJax / LaTeX styles */
.content :deep(mjx-container) {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 2px 0;
}

.content :deep(mjx-container[display="true"]) {
  display: block;
  text-align: center;
  margin: var(--content-spacing-px, 11px) 0;
  padding: 8px 0;
}

.content :deep(mjx-container svg) {
  max-width: 100%;
  height: auto;
}

/* MathJax SVGs render via currentColor; the semantic token resolves per theme */
.content :deep(mjx-container svg) {
  color: var(--ui-text-primary-fg);
}

</style>

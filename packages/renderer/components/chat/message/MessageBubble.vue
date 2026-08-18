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
        <!-- New contentParts-based rendering -->
        <template v-if="contentParts && contentParts.length > 0">
          <!-- Text 内容 - Waiting 状态由 MessageThinking 组件处理 -->
          <Transition
            name="text-fade"
            :css="false"
          >
            <div
              v-if="firstTextPart"
              class="content md-code-block-scope md-inline-code-scope"
            >
              <MessageMarkdown
                :content="firstTextPart.content"
                :is-user="role === 'user'"
                :live="shouldUseStreamingMarkdown(role === 'user')"
                :is-streaming="Boolean(isStreaming)"
              />
            </div>
          </Transition>

          <div
            v-if="partGroups.length > 0"
            class="other-parts-container"
          >
            <template
              v-for="group in partGroups"
              :key="group.key"
            >
              <!-- Process rail: a run of reasoning/tool parts collapses
                   behind one summary line, indented off the answer column.
                   A group that would render nothing at all (a data-steps
                   placeholder whose steps have not landed yet) draws no
                   frame — an empty dashed box is not a state worth showing. -->
              <ProcessRail
                v-if="group.kind === 'process' && processGroupHasContent(group)"
                :summary="processGroupSummary(group)"
                :duration="processGroupDuration(group)"
                :streaming="isProcessGroupLive(group)"
                :solo="isSoloProcessGroup(group)"
                :failed-count="processGroupFailedCount(group)"
                :intent-key="railIntentKey(group)"
              >
                <template
                  v-for="{ part, key } in group.entries"
                  :key="key"
                >
                  <!-- Generation waiting (工具执行后等待 AI 继续)**不在这里画**
                       (2026-08-17):Waiting / Thinking 的实时状态搬到了 composer
                       顶沿(useGenerationStatus),消息里不再为它留一行。`waiting`
                       part 仍存在于数据里(它是"模型被要求继续"的事实),只是零渲染。 -->
                  <!-- Inline reasoning parts. Controlled by the expansion
                       intent record so a remount cannot undo a user's click. -->
                  <CollapsePanel
                    v-if="part.type === 'reasoning'"
                    class="inline-reasoning"
                    :name="key"
                    default-collapsed
                    :model-value="inlineReasoningExpanded(key)"
                    :status="isProcessGroupLive(group) ? 'streaming' : 'completed'"
                    :streaming="isProcessGroupLive(group)"
                    variant="plain"
                    expand-icon-position="inline-end"
                    expand-icon-display="hover"
                    @update:model-value="(v: boolean) => setInlineReasoningExpanded(key, v)"
                  >
                    <template #title>
                      <!-- Same header component (and same body skin) as the
                           top-of-message MessageThinking: one "Thought" line
                           in the app, not two look-alikes. -->
                      <ThoughtHeader
                        class="inline-reasoning-header"
                        label="Thought"
                        :detail="getInlineReasoningSummary(part)"
                      />
                    </template>

                    <div class="inline-reasoning-body">
                      <div
                        class="inline-reasoning-content thought-body md-body"
                      >
                        <MessageMarkdown
                          :content="cleanReasoningContent(part.content)"
                          :is-user="false"
                          :live="shouldUseStreamingMarkdown(false)"
                          :is-streaming="Boolean(isStreaming)"
                        />
                      </div>
                    </div>
                  </CollapsePanel>
                  <!-- Tool activity — ONE render point. A row that starts as a
                       streaming-input synthetic step and later gains a real
                       step stays in THIS panel (same NestedCollapseGroup, same
                       `activity-<toolCallId>` key): it evolves in place instead
                       of moving house between two panels, which used to reset
                       its expansion, restart the shimmer and re-number the
                       ledger. See entryStepsFor(). -->
                  <StepsPanel
                    v-else-if="entryStepsFor(group, key).length > 0"
                    :steps="entryStepsFor(group, key)"
                    :session-id="sessionId"
                    :intent-scope="stepsIntentScope"
                    :parent-intent-ids="railParentIntentIds(group)"
                    flat
                    @open-file="(filePath) => emit('openFile', filePath)"
                  />
                </template>
              </ProcessRail>
              <template v-else>
                <template
                  v-for="{ part, key } in group.entries"
                  :key="key"
                >
                  <div
                    v-if="part.type === 'image-loading'"
                    class="image-generation-skeleton"
                    role="status"
                    :aria-label="part.label || 'Generating image'"
                  />
                  <!-- 流内状态(R6)。宿主认**一种**类型就够了 —— 新增状态不需要
                       再改这里,label、归属与计时都由投递方在描述里给。走秒的时钟
                       在子组件里,所以没有状态条时它根本不存在。 -->
                  <PluginStatusLine
                    v-else-if="part.type === 'plugin-status'"
                    :part="part"
                  />
                  <PromptReferenceCard
                    v-else-if="part.type === 'prompt-ref'"
                    :title="part.title"
                    :content="part.content"
                    :description="part.description"
                  />
                  <PromptReferenceCard
                    v-else-if="part.type === 'skill-ref'"
                    :title="part.name"
                    :content="part.content"
                    :description="part.description"
                  />
                  <!-- Additional text parts (after the first one) -->
                  <div
                    v-else-if="part.type === 'text'"
                    class="content md-code-block-scope md-inline-code-scope"
                  >
                    <MessageMarkdown
                      :content="part.content"
                      :is-user="role === 'user'"
                      :live="shouldUseStreamingMarkdown(role === 'user')"
                      :is-streaming="Boolean(isStreaming)"
                    />
                  </div>
                </template>
              </template>
            </template>
          </div>
        </template>

        <!-- Fallback for messages without contentParts (user messages and
             empty edge cases). Assistant messages always have contentParts
             populated by rebuildContentParts before reaching here, so no
             tool-call rendering is needed in this branch. -->
        <div
          v-else
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
import { ref, computed, watch } from 'vue'
import StepsPanel from '../StepsPanel.vue'
import CollapsePanel from '@/components/common/CollapsePanel.vue'
import PromptReferenceCard from '@/components/common/PromptReferenceCard.vue'
import MessageMarkdown from './MessageMarkdown.vue'
import MessageInlineEdit from './MessageInlineEdit.vue'
import ProcessRail from './ProcessRail.vue'
import PluginStatusLine from './PluginStatusLine.vue'
import ThoughtHeader from './ThoughtHeader.vue'
import type { ToolCall, Step, ContentPart } from '@/types'
import type { AnchorRect } from '@/composables/floating/compute-position'
import { stepFromToolCall } from '@/stores/helpers/tool-step-view'
import { getExpansionIntent, setExpansionIntent } from '@/stores/helpers/expansion-intent'
import { cleanReasoningContent } from '@/composables/useMarkdownRenderer'
import { useCollapsibleContent } from '@/composables/useCollapsibleContent'
import { hasVisibleReasoningContent, summarizeReasoningContent } from './reasoning-summary'

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

// ============ New overlay-based transition system ============

// Extract the first text part (rendered separately for smooth transition)
// Only treat the first part as "firstTextPart" if it's actually a text part.
// If the first part is a tool-call/data-steps, all parts go through otherParts in order.
const firstTextPart = computed(() => {
  const parts = props.contentParts
  if (!parts || parts.length === 0) return null
  return parts[0].type === 'text' ? parts[0] : null
})

// Parts rendered after the first text part, paired with render keys.
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
// If firstTextPart captured parts[0], skip it here; otherwise keep all parts
// in order.
const otherPartEntries = computed(() => {
  const parts = props.contentParts
  if (!parts) return []
  const hasFirstText = !!firstTextPart.value
  let skippedFirstText = false
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

    // Only skip the first text if firstTextPart is rendering it
    if (p.type === 'text' && hasFirstText && !skippedFirstText) {
      skippedFirstText = true
      sawVisiblePartBeforeWaiting = true
      return
    }

    if (p.type !== 'waiting') {
      sawVisiblePartBeforeWaiting = true
    }
    entries.push({ part: p, key: getOtherPartKey(p, sourceIndex) })
  })

  return entries
})

// ============ Process rail grouping ============
// Consecutive "process" parts (thinking + tool activity) collapse behind a
// single ProcessRail; content parts (answer text, references) stay at full
// volume on the main column.

type PartEntry = { part: ContentPart; key: string }
type PartGroup = { kind: 'process' | 'content'; key: string; entries: PartEntry[] }

const PROCESS_PART_TYPES = new Set<ContentPart['type']>(['reasoning', 'tool-call', 'data-steps', 'waiting'])

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

// Group key anchors on the first ANCHOR entry, not merely the first entry:
// a run that opens with a `waiting` indicator would otherwise re-key itself
// when that indicator is spliced away at stream end, remounting the whole
// rail (and with it every panel's expansion state) at the exact moment the
// stream settles. contentParts is append-only during streaming, so once an
// anchor exists it never moves.
const partGroups = computed<PartGroup[]>(() => {
  const groups: PartGroup[] = []
  for (const entry of otherPartEntries.value) {
    const isProcess = PROCESS_PART_TYPES.has(entry.part.type)
    const last = groups[groups.length - 1]
    if (isProcess && last?.kind === 'process') {
      last.entries.push(entry)
      continue
    }
    if (!isProcess && last?.kind === 'content') {
      last.entries.push(entry)
      continue
    }
    groups.push({
      kind: isProcess ? 'process' : 'content',
      key: '',
      entries: [entry],
    })
  }
  for (const group of groups) {
    const anchor = group.entries.find(entry => isAnchorPart(entry.part)) ?? group.entries[0]
    group.key = `${group.kind}-${anchor.key}`
  }
  return groups
})

interface ProcessGroupStats {
  reasoningCount: number
  toolCount: number
  failedCount: number
  toolCounts: Map<string, number>
  durationMs: number
}

interface ProcessGroupRender {
  /** entry key → the steps THAT entry renders (real ∪ synthesized). */
  stepsByEntry: Map<string, Step[]>
  stats: ProcessGroupStats
  /** Would this group paint anything at all? An empty rail draws no frame. */
  hasContent: boolean
}

const stepByToolCallId = computed(() => {
  const map = new Map<string, Step>()
  for (const step of props.steps ?? []) {
    if (step.toolCallId) map.set(step.toolCallId, step)
  }
  return map
})

/**
 * The single place that decides WHICH entry renders WHICH rows.
 *
 * A tool call is delivered twice: first as a `tool-call` part (streaming
 * input, no real step yet), then as a `data-steps` placeholder once the engine
 * emits the step. Rendering both parts independently made the row "move house"
 * mid-flight — two StepsPanels, two NestedCollapseGroups, so the row remounted
 * exactly when it became interesting. Here the `tool-call` part keeps
 * ownership of every call it introduced (rendering the real step as soon as
 * one exists, a synthesized one before that) and the `data-steps` part renders
 * only what the tool-call parts did not already claim — historical messages,
 * where no tool-call part was ever built, therefore still render normally.
 *
 * Synthesized steps inherit the turnIndex of whichever sibling already has a
 * real step (falling back to a per-part negative pseudo-turn) so that a
 * parallel batch stays ONE StepsPanel group from the first frame to the last;
 * mixing `undefined` with a real turnIndex would split and re-merge the batch
 * mid-stream and remount its rows.
 */
const processGroupRenders = computed(() => {
  const renders = new Map<string, ProcessGroupRender>()
  const realSteps = stepByToolCallId.value
  // Message-wide, first-come-wins: a tool call is rendered by exactly one
  // entry no matter how the parts happen to be split into groups.
  const claimed = new Set<string>()
  let pseudoTurn = -1

  for (const group of partGroups.value) {
    if (group.kind !== 'process') continue

    const stepsByEntry = new Map<string, Step[]>()
    const stats: ProcessGroupStats = {
      reasoningCount: 0,
      toolCount: 0,
      failedCount: 0,
      toolCounts: new Map<string, number>(),
      durationMs: 0,
    }
    let hasContent = false

    const countStep = (step: Step) => {
      const name = step.toolCall?.toolName || step.title || 'tool'
      stats.toolCount++
      stats.toolCounts.set(name, (stats.toolCounts.get(name) ?? 0) + 1)
      stats.durationMs += step.toolCall?.durationMs ?? 0
      if (step.status === 'failed') stats.failedCount++
    }

    for (const { part, key } of group.entries) {
      if (part.type === 'reasoning') {
        stats.reasoningCount++
        hasContent = true
        continue
      }
      if (part.type === 'waiting') {
        // Renders nothing since the status moved to the composer; a group
        // holding only a waiting placeholder draws no rail frame.
        continue
      }

      let rows: Step[] = []
      if (part.type === 'tool-call') {
        pseudoTurn -= 1
        const batchTurn = part.toolCalls
          .map(tc => realSteps.get(tc.id)?.turnIndex)
          .find(turnIndex => turnIndex !== undefined) ?? pseudoTurn
        rows = part.toolCalls
          .filter(toolCall => !claimed.has(toolCall.id))
          .map((toolCall) => {
            claimed.add(toolCall.id)
            const real = realSteps.get(toolCall.id)
            if (real) return real
            return { ...stepFromToolCall(toolCall), turnIndex: batchTurn }
          })
      } else if (part.type === 'data-steps') {
        rows = getStepsForTurn(part.turnIndex).filter(step => !step.toolCallId || !claimed.has(step.toolCallId))
        for (const step of rows) {
          if (step.toolCallId) claimed.add(step.toolCallId)
        }
      } else {
        continue
      }

      if (rows.length > 0) {
        stepsByEntry.set(key, rows)
        rows.forEach(countStep)
        hasContent = true
      }
    }

    renders.set(group.key, { stepsByEntry, stats, hasContent })
  }

  return renders
})

const EMPTY_STEPS: Step[] = []

function entryStepsFor(group: PartGroup, key: string): Step[] {
  return processGroupRenders.value.get(group.key)?.stepsByEntry.get(key) ?? EMPTY_STEPS
}

function processGroupHasContent(group: PartGroup): boolean {
  return processGroupRenders.value.get(group.key)?.hasContent ?? false
}

const EMPTY_STATS: ProcessGroupStats = {
  reasoningCount: 0,
  toolCount: 0,
  failedCount: 0,
  toolCounts: new Map<string, number>(),
  durationMs: 0,
}

function processGroupStats(group: PartGroup): ProcessGroupStats {
  return processGroupRenders.value.get(group.key)?.stats ?? EMPTY_STATS
}

function processGroupSummary(group: PartGroup): string {
  const stats = processGroupStats(group)

  const bits: string[] = []
  if (stats.reasoningCount > 0) bits.push(`思考 ${stats.reasoningCount} 步`)

  const toolBits = [...stats.toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
  if (toolBits.length > 4) {
    const extra = toolBits.length - 4
    toolBits.length = 4
    toolBits.push(`+${extra}`)
  }
  bits.push(...toolBits)

  return bits.length > 0 ? bits.join(' · ') : '过程'
}

// Rendered outside the uppercased summary span so the seconds unit keeps its
// lowercase "s".
function processGroupDuration(group: PartGroup): string {
  const { durationMs } = processGroupStats(group)
  if (durationMs < 1000) return ''
  return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`
}

/** A one-item process reads better as a bare timeline row than as a
 *  summary header that merely repeats it.
 *
 *  The count includes tool calls that are still streaming their input (they
 *  are ordinary rows in `stepsByEntry` now). Before that, a "thinking + tool
 *  in flight" group read as solo — no header, no frame — and then sprouted a
 *  summary header and an 18px-padded dashed box the instant the step landed,
 *  shoving everything below it down the page. The shape is now decided when
 *  the row appears, and only grows monotonically from there. */
function isSoloProcessGroup(group: PartGroup): boolean {
  const stats = processGroupStats(group)
  return stats.reasoningCount + stats.toolCount <= 1
}

function processGroupFailedCount(group: PartGroup): number {
  return processGroupStats(group).failedCount
}

const LIVE_STEP_STATUSES = new Set(['pending', 'running', 'awaiting-confirmation'])
const LIVE_TOOL_STATUSES = new Set(['pending', 'queued', 'executing', 'input-streaming'])

/**
 * A rail animates only while ITS OWN work is in flight — earlier, finished
 * process groups must settle even though the message as a whole is still
 * streaming. "Live" = an in-flight step inside the group, or being the
 * trailing process group of an actively streaming message (the turn that
 * is thinking / about to call tools).
 */
function isProcessGroupLive(group: PartGroup): boolean {
  if (!props.isStreaming) return false

  for (const { part } of group.entries) {
    if (part.type === 'data-steps') {
      for (const step of getStepsForTurn(part.turnIndex)) {
        if (LIVE_STEP_STATUSES.has(step.status)) return true
      }
    } else if (part.type === 'tool-call') {
      if (part.toolCalls.some(tc => LIVE_TOOL_STATUSES.has(tc.status))) return true
    }
  }

  const groups = partGroups.value
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].kind === 'process') return groups[i] === group
  }
  return false
}

const useLiveAssistantMarkdown = computed(() =>
  props.role === 'assistant' && hasBeenStreaming.value,
)

function shouldUseStreamingMarkdown(isUser: boolean): boolean {
  return Boolean(props.isStreaming || (!isUser && useLiveAssistantMarkdown.value))
}

// Generate render keys for other parts. `sourceIndex` is the part's index
// in the original (unfiltered) contentParts array, which is append-only
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

function getInlineReasoningSummary(part: Extract<ContentPart, { type: 'reasoning' }>): string {
  return summarizeReasoningContent(part.content)
}

// ============ Expansion intent (user record > live auto > static default) ============
// The records live outside the component tree (expansion-intent.ts) so a
// remount — the thing that used to reset every one of these — cannot undo a
// click. Without a messageId there is no stable address space, so the panels
// silently fall back to their own local state (unchanged behaviour).

const stepsIntentScope = computed(() => (props.messageId ? `steps-${props.messageId}` : ''))

function railIntentKey(group: PartGroup): string {
  return props.messageId ? `rail-${props.messageId}-${group.key}` : ''
}

/**
 * The rail this StepsPanel sits in, handed down as its parent intent address:
 * expanding a tool row records the rail as expanded too, so the rail's
 * "streaming ends → fold" auto-collapse cannot take the row away.
 * Cached per key so the prop keeps its identity across re-renders.
 */
const railParentIntentIdCache = new Map<string, string[]>()
const NO_PARENT_INTENTS: string[] = []

function railParentIntentIds(group: PartGroup): string[] {
  const key = railIntentKey(group)
  if (!key) return NO_PARENT_INTENTS
  let cached = railParentIntentIdCache.get(key)
  if (!cached) {
    cached = [key]
    railParentIntentIdCache.set(key, cached)
  }
  return cached
}

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

/* ============ Text 淡入动画 ============ */

/* Text 内容淡入 - Waiting 状态由 MessageThinking 组件处理 */
.text-fade-enter-active {
  transition: opacity var(--duration-slow) var(--ease-default);
}

.text-fade-enter-from {
  opacity: 0;
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

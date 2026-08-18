<template>
  <div class="thinking-container">
    <CollapsePanel
      v-if="shouldShowStatus"
      class="thinking-panel"
      :class="{ 'has-reasoning': !!reasoning }"
      :name="reasoning ? 'message-thinking-reasoning' : 'message-thinking-status'"
      :model-value="controlledExpanded"
      default-collapsed
      :collapsible="!!reasoning"
      :eager="!!reasoning"
      :status="isThinkingLive ? 'streaming' : 'completed'"
      :streaming="isThinkingLive"
      variant="plain"
      expand-icon-position="inline-end"
      expand-icon-display="hover"
      @update:model-value="handleExpandedChange"
    >
      <template #title>
        <div class="thinking-status-overlay">
          <div class="thinking-status-overlay-inner">
            <!-- Waiting / Thinking 的**实时**读数(计时、token)在 composer 顶沿
                 (useGenerationStatus,2026-08-17);这一行只是 reasoning 正文的
                 折叠头:活着时 "Thinking · <正在流入的最后一行>"(**不**自动展开,
                 内容在折叠行里流过),完成后 "Thought · 用时 · <同一段尾巴>"。 -->
            <div
              class="thinking-status-row clickable"
              :class="{ 'status-live': isThinkingLive }"
            >
              <Transition
                name="status-text-fade"
                mode="out-in"
              >
                <ThoughtHeader
                  v-if="isThinkingLive"
                  key="thinking"
                  label="Thinking"
                  :detail="liveTail"
                  detail-tail
                  live
                />
                <!-- Settled: the tail that streamed through stays put (2026-08-17
                     拍板 —— 思考完不能"内容不见了"),用时挪到前面当 meta。 -->
                <ThoughtHeader
                  v-else
                  key="thought"
                  label="Thought"
                  :meta="displayTime > 0 ? formatThinkingTime(displayTime) : undefined"
                  :detail="liveTail"
                  detail-tail
                />
              </Transition>
            </div>
          </div>
        </div>
      </template>

      <template #default="{ expanded }">
        <div
          v-if="reasoning"
          class="thinking-reasoning-wrapper"
          :class="{ expanded }"
        >
          <div class="thinking-reasoning-inner">
            <!-- `thought-body` is the shared skin (published by ThoughtHeader);
                 the inline reasoning parts in MessageBubble wear the same one. -->
            <div class="thinking-content thought-body md-body">
              <MessageMarkdown
                :content="cleanedReasoning"
                :is-user="false"
                :live="useLiveMarkdown"
                :is-streaming="isStreaming"
              />
            </div>
          </div>
        </div>
      </template>
    </CollapsePanel>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import CollapsePanel from '@/components/common/CollapsePanel.vue'
import MessageMarkdown from './MessageMarkdown.vue'
import ThoughtHeader from './ThoughtHeader.vue'
import { cleanReasoningContent } from '@/composables/useMarkdownRenderer'
import { getExpansionIntent, setExpansionIntent } from '@/stores/helpers/expansion-intent'

interface Props {
  isStreaming: boolean
  hasContent: boolean
  reasoning?: string
  thinkingStartTime?: number
  thinkingTime?: number
  /**
   * Stable address for the user's expansion intent. The panel's `name` flips
   * from `…-status` to `…-reasoning` the moment reasoning arrives, and that
   * flip resets CollapsePanel's `userControlledExpansion` — so a click made
   * during the waiting phase used to be forgotten. Omit the prop and the
   * panel keeps its own local state (unchanged behaviour).
   */
  intentKey?: string
}

const props = defineProps<Props>()

const isThinkingLive = computed(() => props.isStreaming && !props.hasContent && !!props.reasoning)

// User record > collapsed. No automatic state at all (2026-08-17 拍板): the
// panel never opens itself while thinking and never folds itself afterwards —
// both moves used to shove the reader's content around. Live reasoning is
// visible anyway: it streams through the collapsed header line (`liveTail`).
// `undefined` leaves CollapsePanel uncontrolled.
const controlledExpanded = computed<boolean | undefined>(() => {
  if (!props.intentKey) return undefined
  return getExpansionIntent(props.intentKey) ?? false
})

/**
 * The tail of the reasoning as one line, for the collapsed header — while it
 * streams AND after it settles (the glimpse must not vanish when thinking
 * ends): newest text at the right edge, ellipsis at the left (ThoughtHeader
 * `detail-tail`). Whitespace collapsed; markdown left as-is (it is a glimpse,
 * not a render). Bounded so the header never lays out kilobytes of text.
 */
const liveTail = computed(() => {
  const text = cleanedReasoning.value
  if (!text) return ''
  return text.slice(-240).replace(/\s+/g, ' ').trim()
})

function handleExpandedChange(expanded: boolean): void {
  setExpansionIntent(props.intentKey, expanded)
}

const emit = defineEmits<{
  updateThinkingTime: [time: number]
}>()

const thinkingElapsed = ref(0)
const finalThinkingTime = ref(0)

let thinkingStartTimeValue: number | null = null
let thinkingTimer: ReturnType<typeof setInterval> | null = null

const displayTime = computed(() => {
  if (finalThinkingTime.value > 0) return finalThinkingTime.value
  return thinkingElapsed.value
})

const cleanedReasoning = computed(() =>
  props.reasoning ? cleanReasoningContent(props.reasoning) : '',
)

// Reasoning goes through the incremental StreamingMarkdown pipeline (same as
// MessageBubble's inline reasoning) instead of a v-html blob: v-html replaces
// the whole subtree on every chunk, which destroys each <pre> and resets its
// scrollLeft, making code blocks impossible to scroll while streaming.
// Sticky: once live, stay live so the DOM isn't swapped out at stream end.
const hasBeenStreaming = ref(false)
watch(
  () => props.isStreaming,
  (streaming) => {
    if (streaming) hasBeenStreaming.value = true
  },
  { immediate: true },
)
const useLiveMarkdown = computed(() => props.isStreaming || hasBeenStreaming.value)

// Only reasoning earns a row here; the bare "Waiting" state lives in the
// composer readout now.
const shouldShowStatus = computed(() => !!props.reasoning)


function formatThinkingTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function startThinkingTimer() {
  if (thinkingTimer) return
  thinkingStartTimeValue = props.thinkingStartTime ?? Date.now()
  thinkingElapsed.value = (Date.now() - thinkingStartTimeValue) / 1000
  thinkingTimer = setInterval(() => {
    if (thinkingStartTimeValue !== null) {
      thinkingElapsed.value = (Date.now() - thinkingStartTimeValue) / 1000
    }
  }, 100)
}

function stopThinkingTimer() {
  if (!thinkingTimer) return
  clearInterval(thinkingTimer)
  thinkingTimer = null
  finalThinkingTime.value = thinkingElapsed.value
  if (finalThinkingTime.value > 0) {
    emit('updateThinkingTime', finalThinkingTime.value)
  }
}

watch(
  isThinkingLive,
  (newVal) => {
    if (newVal) {
      startThinkingTimer()
    } else {
      stopThinkingTimer()
    }
  },
  { immediate: true },
)

watch(
  () => props.thinkingTime,
  (newVal) => {
    if (newVal && newVal > 0) {
      finalThinkingTime.value = newVal
    }
  },
  { immediate: true },
)

onMounted(() => {
  if (props.thinkingTime && props.thinkingTime > 0) {
    finalThinkingTime.value = props.thinkingTime
  }
})

onUnmounted(() => {
  if (thinkingTimer) {
    clearInterval(thinkingTimer)
    thinkingTimer = null
  }
})
</script>

<style scoped>
.thinking-container:empty {
  display: none;
}

.thinking-panel {
  --thinking-fg: var(--ui-message-thinking-fg);
  color: var(--thinking-fg);
}

.thinking-status-overlay,
.thinking-status-overlay-inner {
  min-width: 0;
}

/* 恒定一行(22px = ThoughtHeader 的行盒高度)。锁高:Thinking → Thought 换行
   时行高一致,状态变化不能是块级变化(外层 Transition out-in 的空一帧也不塌)。 */
.thinking-status-overlay-inner {
  display: flex;
  align-items: center;
  min-height: 22px;
}

.thinking-status-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 22px;
  color: var(--thinking-fg);
}

.thinking-status-row.clickable {
  cursor: pointer;
}

/* The row's own paint (label, detail, live dot, hover) lives in ThoughtHeader
   — this component only places it. */

.status-text-fade-enter-active {
  transition: opacity var(--duration-normal) var(--ease-default), transform var(--duration-normal) var(--ease-default);
}

.status-text-fade-leave-active {
  transition: opacity var(--duration-fast) var(--ease-default), transform var(--duration-fast) var(--ease-default);
}

.status-text-fade-enter-from,
.status-text-fade-leave-to {
  opacity: 0;
  transform: translateY(-2px);
}

.thinking-reasoning-wrapper {
  margin-bottom: 0;
  padding-bottom: 8px;
}

.thinking-reasoning-wrapper.expanded {
  margin-bottom: 0;
}

.thinking-reasoning-inner {
  min-height: 0;
}

/* Typography and the blueprint outline come from `.thought-body`; the
   markdown child rules live there too, so nothing is written twice. */

@media (prefers-reduced-motion: reduce) {
  .status-text-fade-enter-active,
  .status-text-fade-leave-active {
    transition: none;
  }
}
</style>

<template>
  <!-- One inline reasoning part: the same "Thought" line the top-of-message
       thought wears (ThoughtHeader), body in the shared `.thought-body` skin.
       Controlled by the expansion intent record when the message has an id
       (a remount cannot undo the user's click); uncontrolled otherwise. -->
  <CollapsePanel
    class="inline-reasoning"
    :name="name"
    default-collapsed
    :model-value="expanded"
    :status="live ? 'streaming' : 'completed'"
    :streaming="live"
    variant="plain"
    expand-icon-position="inline-end"
    expand-icon-display="hover"
    @update:model-value="(v: boolean) => emit('update:expanded', v)"
  >
    <template #title>
      <ThoughtHeader
        class="inline-reasoning-header"
        label="Thought"
        :detail="summary"
      />
    </template>

    <div class="inline-reasoning-body">
      <div class="inline-reasoning-content thought-body md-body">
        <MessageMarkdown
          :content="cleanedContent"
          :is-user="false"
          :live="liveMarkdown"
          :is-streaming="isStreaming"
        />
      </div>
    </div>
  </CollapsePanel>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import CollapsePanel from '@/components/common/CollapsePanel.vue'
import MessageMarkdown from './MessageMarkdown.vue'
import ThoughtHeader from './ThoughtHeader.vue'
import { cleanReasoningContent } from '@/composables/useMarkdownRenderer'
import { summarizeReasoningContent } from './reasoning-summary'

const props = defineProps<{
  /** CollapsePanel name (the part's stable render key). */
  name: string
  content: string
  /** `undefined` = uncontrolled: CollapsePanel keeps its own state. */
  expanded?: boolean
  /** The surrounding work is still in flight (header shimmer + streaming status). */
  live: boolean
  /** Route the body through the incremental StreamingMarkdown pipeline. */
  liveMarkdown: boolean
  isStreaming: boolean
}>()

const emit = defineEmits<{
  'update:expanded': [expanded: boolean]
}>()

const cleanedContent = computed(() => cleanReasoningContent(props.content))
const summary = computed(() => summarizeReasoningContent(props.content))
</script>

<style scoped>
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
</style>

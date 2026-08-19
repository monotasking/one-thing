<template>
  <!-- One "content" part — anything that is neither a thought nor a tool row.
       Single-root on purpose: MessageBubble's scoped `.content` / skeleton
       styles reach the root element of a child component, so this stays a
       thin dispatch and the styling stays where it was. -->
  <div
    v-if="part.type === 'text'"
    class="content md-code-block-scope md-inline-code-scope"
  >
    <MessageMarkdown
      :content="part.content"
      :is-user="isUser"
      :live="live"
      :is-streaming="isStreaming"
    />
  </div>
  <div
    v-else-if="part.type === 'image-loading'"
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
</template>

<script lang="ts">
import type { ContentPart } from '@/types'

/** The part types this view knows how to draw. */
export const CONTENT_PART_TYPES: ReadonlySet<ContentPart['type']> = new Set<ContentPart['type']>([
  'text',
  'image-loading',
  'plugin-status',
  'prompt-ref',
  'skill-ref',
])
</script>

<script setup lang="ts">
import MessageMarkdown from './MessageMarkdown.vue'
import PluginStatusLine from './PluginStatusLine.vue'
import PromptReferenceCard from '@/components/common/PromptReferenceCard.vue'

defineProps<{
  part: ContentPart
  isUser: boolean
  /** Route text through the incremental StreamingMarkdown pipeline. */
  live: boolean
  isStreaming: boolean
}>()
</script>

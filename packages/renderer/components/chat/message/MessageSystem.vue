<template>
  <!-- Special rendering for context-compact message -->
  <ContextCompactPanel
    v-if="contextCompactData"
    :summary="contextCompactData.summary"
    :status="contextCompactData.status"
    :error="contextCompactData.error"
    :compacted-message-count="contextCompactData.compactedMessageCount"
    :progress="contextCompactData.progress"
  />

  <!-- Default system message rendering -->
  <div
    v-else
    class="message system"
  >
    <div class="system-icon">
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line
          x1="16"
          y1="13"
          x2="8"
          y2="13"
        />
        <line
          x1="16"
          y1="17"
          x2="8"
          y2="17"
        />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    </div>
    <div class="system-bubble">
      <div
        class="system-content md-inline-code-scope"
        v-html="renderedContent"
      />
      <div class="system-footer">
        <span class="system-time">{{ formattedTime }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '@/composables/useMarkdownRenderer'
import ContextCompactPanel from './ContextCompactPanel.vue'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { platformApi } from '@/platform'

interface Props {
  content: string
  timestamp: number
  sessionId?: string
  messageId?: string
}

const props = defineProps<Props>()
const chatStore = useChatStore()
const sessionsStore = useSessionsStore()

const formattedTime = computed(() => {
  const date = new Date(props.timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
})

// Try to parse content as context-compact message
const contextCompactData = computed<{
  type: 'context-compact'
  status?: 'compacting' | 'completed' | 'failed'
  summary: string
  error?: string
  compactedMessageCount?: number
  compactedThroughMessageId?: string
  progress?: { chunk: number; totalChunks: number }
} | null>(() => {
  try {
    const parsed = JSON.parse(props.content)
    if (parsed && parsed.type === 'context-compact') {
      return parsed as {
        type: 'context-compact'
        status?: 'compacting' | 'completed' | 'failed'
        summary: string
        error?: string
        compactedMessageCount?: number
        compactedThroughMessageId?: string
        progress?: { chunk: number; totalChunks: number }
      }
    }
  } catch {
    // Not JSON
  }
  return null
})

const renderedContent = computed(() => {
  return renderMarkdown(props.content, false)
})

// Get current session ID
function getSessionId(): string | null {
  if (props.sessionId) return props.sessionId
  return sessionsStore.currentSession?.id || null
}

// Handle close - persistently delete the message
async function handleClose() {
  const sessionId = getSessionId()
  if (!sessionId || !props.messageId) {
    console.warn('[MessageSystem] Cannot close: missing sessionId or messageId')
    return
  }

  try {
    // Remove from backend (persistent storage)
    await platformApi.removeMessage(sessionId, props.messageId)
    // Remove from Vue state for immediate UI update
    chatStore.removeMessage(sessionId, props.messageId)
  } catch (error) {
    console.error('[MessageSystem] Failed to close:', error)
  }
}
</script>

<style scoped>
.message.system {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  width: min(860px, 100%);
  animation: fadeIn 0.18s ease-out;
}

.system-icon {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--ui-accent-primary-fg) 15%, transparent);
  color: var(--ui-accent-primary-fg);
  flex-shrink: 0;
}

.system-bubble {
  flex: 1;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-primary-fg) 25%, transparent);
  background: color-mix(in srgb, var(--ui-accent-primary-fg) 8%, transparent);
}

.system-content {
  font-size: 14px;
  color: var(--ui-text-primary-fg);
  line-height: 1.6;
}

/* Markdown styles */
.system-content :deep(p) {
  margin: 0 0 0.5em 0;
}

.system-content :deep(p:last-child) {
  margin-bottom: 0;
}

.system-content :deep(ul) {
  margin: 0.5em 0;
  padding-left: 1.2em;
}

.system-content :deep(li) {
  margin: 0.25em 0;
}

.system-content {
  --md-inline-code-bg: color-mix(in srgb, var(--ui-accent-primary-fg) 15%, transparent);
  --md-inline-code-fg: currentColor;
}

html[data-theme='light'] .system-content {
  --md-inline-code-bg: color-mix(in srgb, var(--ui-accent-primary-fg) 10%, transparent);
}

.system-footer {
  margin-top: 10px;
  display: flex;
  justify-content: flex-end;
}

.system-time {
  font-size: 11px;
  color: var(--ui-text-muted-fg);
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>

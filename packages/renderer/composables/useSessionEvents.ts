import { platformApi } from '@/platform'
/**
 * useSessionEvents — Per-session event subscription composable
 *
 * Receives unified events via `session:event` and `session:stream`
 * channels, exposing reactive state for a single session.
 *
 * Phase 4a: exists alongside the old chat store. Not yet integrated
 * into components — available for testing and incremental migration.
 *
 * Phase 4b: replaces the event-handling logic in chat store.
 */

import { ref, computed, watch, onUnmounted, type Ref, toValue, type MaybeRef } from 'vue'
import type { SessionEventEnvelope, StreamChunk, SessionEvent } from '@shared/events/index.js'
import type { Step, ToolCall } from '@shared/ipc.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

export interface SessionEventState {
  /** Accumulated text content */
  content: Ref<string>
  /** Accumulated reasoning content */
  reasoning: Ref<string>
  /** Whether the session is currently streaming */
  isStreaming: Ref<boolean>
  /** Active tool calls (keyed by toolCallId) */
  activeToolCalls: Ref<Map<string, ToolCall>>
  /** Execution steps */
  steps: Ref<Step[]>
  /** Error message if stream failed */
  error: Ref<string | null>
  /** Event count (for debugging) */
  eventCount: Ref<number>
  /** Chunk count (for debugging) */
  chunkCount: Ref<number>
}

/**
 * Subscribe to unified session events for a specific session.
 *
 * Usage:
 * ```ts
 * const { content, reasoning, isStreaming, steps } = useSessionEvents(sessionId)
 * ```
 */
export function useSessionEvents(sessionIdRef: MaybeRef<string | undefined>): SessionEventState {
  const content = ref('')
  const reasoning = ref('')
  const isStreaming = ref(false)
  const activeToolCalls = ref<Map<string, ToolCall>>(new Map())
  const steps = ref<Step[]>([])
  const error = ref<string | null>(null)
  const eventCount = ref(0)
  const chunkCount = ref(0)

  const sessionId = computed(() => toValue(sessionIdRef))

  // ── Event handler ─────────────────────────────

  function handleEvent(envelope: SessionEventEnvelope) {
    // Filter by session
    if (envelope.sessionId !== sessionId.value) return

    eventCount.value++
    const event = envelope.event

    switch (event.type) {
      case SESSION_EVENT_TYPES.STREAM_START:
        isStreaming.value = true
        content.value = ''
        reasoning.value = ''
        error.value = null
        activeToolCalls.value = new Map()
        steps.value = []
        break

      case SESSION_EVENT_TYPES.STREAM_COMPLETE:
        isStreaming.value = false
        break

      case SESSION_EVENT_TYPES.STREAM_ERROR:
        isStreaming.value = false
        error.value = event.data.error
        break

      case SESSION_EVENT_TYPES.STREAM_ABORTED:
        isStreaming.value = false
        break

      case SESSION_EVENT_TYPES.TOOL_CALL:
        activeToolCalls.value.set(event.toolCall.id, { ...event.toolCall })
        activeToolCalls.value = new Map(activeToolCalls.value) // trigger reactivity
        break

      case SESSION_EVENT_TYPES.TOOL_RESULT:
        const tc = activeToolCalls.value.get(event.toolCall.id)
        if (tc) {
          Object.assign(tc, event.toolCall)
          activeToolCalls.value = new Map(activeToolCalls.value)
        }
        break

      case SESSION_EVENT_TYPES.STEP_ADDED:
        steps.value = [...steps.value, event.step]
        break

      case SESSION_EVENT_TYPES.STEP_UPDATED: {
        const idx = steps.value.findIndex(s => s.id === event.stepId)
        if (idx >= 0) {
          const updated = { ...steps.value[idx], ...event.updates }
          steps.value = [...steps.value.slice(0, idx), updated, ...steps.value.slice(idx + 1)]
        }
        break
      }

      case SESSION_EVENT_TYPES.TOOL_EXECUTION_UPDATE: {
        const idx = steps.value.findIndex(s => s.id === event.stepId || s.toolCallId === event.toolCallId)
        if (idx >= 0) {
          const updated = { ...steps.value[idx], status: 'running' as const, partialResult: event.partialResult, partialResultIsPartial: true }
          steps.value = [...steps.value.slice(0, idx), updated, ...steps.value.slice(idx + 1)]
        }
        break
      }

      case SESSION_EVENT_TYPES.TOOL_EXECUTION_END: {
        const idx = steps.value.findIndex(s => s.id === event.stepId || s.toolCallId === event.toolCallId)
        if (idx >= 0) {
          const updated = { ...steps.value[idx], partialResult: event.result, partialResultIsPartial: false, ...(event.isError ? { error: event.error } : {}) }
          steps.value = [...steps.value.slice(0, idx), updated, ...steps.value.slice(idx + 1)]
        }
        break
      }

    }
  }

  // ── Stream chunk handler ──────────────────────

  function handleChunk(data: { sessionId: string; chunk: StreamChunk }) {
    if (data.sessionId !== sessionId.value) return

    chunkCount.value++
    const chunk = data.chunk

    switch (chunk.type) {
      case 'text-delta':
        content.value += chunk.text
        break
      case 'reasoning-delta':
        reasoning.value += chunk.reasoning
        break
      // tool-input-delta: handled via step:updated events
    }
  }

  // ── Lifecycle ─────────────────────────────────

  let cleanupEvent: (() => void) | null = null
  let cleanupStream: (() => void) | null = null

  function subscribe() {
    if (typeof window !== 'undefined' && platformApi) {
      cleanupEvent = platformApi.onSessionEvent(handleEvent)
      cleanupStream = platformApi.onSessionStream(handleChunk)
    }
  }

  function unsubscribe() {
    cleanupEvent?.()
    cleanupStream?.()
    cleanupEvent = null
    cleanupStream = null
  }

  // Subscribe immediately
  subscribe()

  // Cleanup on unmount
  onUnmounted(() => {
    unsubscribe()
  })

  return {
    content,
    reasoning,
    isStreaming,
    activeToolCalls,
    steps,
    error,
    eventCount,
    chunkCount,
  }
}

/**
 * Live generation status for the composer readout (2026-08-17).
 *
 * The chat store keeps plain (non-reactive) per-session stats and derives the
 * phase on demand; this composable is the one clock that polls it — 100ms
 * while the session generates, idle otherwise — and exposes a reactive
 * snapshot plus formatted pieces for the frame label. Replaces the per-message
 * setInterval timers MessageThinking used to run for "Waiting · 1.2s".
 */
import { computed, onUnmounted, ref, watch, type Ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import type { GenerationStatus } from '@/stores/helpers/generation-status'

const POLL_MS = 100

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return `${Math.round(count)}`
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  return `${Math.round(count / 1000)}k`
}

export const GENERATION_PHASE_LABEL: Record<GenerationStatus['phase'], string> = {
  waiting: 'WAITING',
  thinking: 'THINKING',
  responding: 'RESPONDING',
  tool: 'RUNNING',
  approval: 'APPROVAL',
}

export function useGenerationStatus(sessionId: Ref<string | null | undefined>) {
  const chatStore = useChatStore()
  const status = ref<GenerationStatus | null>(null)
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | null = null

  function tick() {
    const id = sessionId.value
    status.value = id ? chatStore.getGenerationStatus(id) : null
    now.value = Date.now()
    if (!status.value) stop()
  }

  function start() {
    if (timer) return
    tick()
    timer = setInterval(tick, POLL_MS)
  }

  function stop() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  const generating = computed(() => {
    const id = sessionId.value
    return id ? chatStore.isSessionGenerating(id) : false
  })

  watch(
    [generating, sessionId],
    ([isGenerating]) => {
      if (isGenerating) start()
      else {
        stop()
        status.value = null
      }
    },
    { immediate: true },
  )

  onUnmounted(stop)

  const label = computed(() => (status.value ? GENERATION_PHASE_LABEL[status.value.phase] : ''))
  const toolName = computed(() => status.value?.toolName ?? '')
  const phaseElapsed = computed(() => (status.value ? formatElapsed(now.value - status.value.phaseSince) : ''))
  const totalElapsed = computed(() => (status.value ? formatElapsed(now.value - status.value.startedAt) : ''))
  const tokens = computed(() => {
    const s = status.value
    if (!s || s.outputTokens <= 0) return ''
    return `${s.outputTokensExact ? '' : '≈'}${formatTokenCount(s.outputTokens)} tok`
  })

  return { status, label, toolName, phaseElapsed, totalElapsed, tokens }
}

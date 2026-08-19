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
import { formatDuration } from '@/utils/format-duration'

const POLL_MS = 100

/** Whole seconds under a minute ("4s"), m:ss beyond — no decimals anywhere. */
export function formatElapsed(ms: number): string {
  return formatDuration(ms, { style: 'elapsed' })
}

/** Plain count that ticks one by one; only past 10k does it fold into "12.3k" / "120k". */
export function formatTokenCount(count: number): string {
  if (count < 10_000) return `${Math.round(count)}`
  if (count < 100_000) return `${(count / 1000).toFixed(1)}k`
  return `${Math.round(count / 1000)}k`
}

/**
 * Tool activity is deliberately NOT surfaced here (2026-08-19): the steps panel
 * already narrates every tool call, so while a tool runs / awaits approval the
 * composer just says WORKING and keeps counting from the start of the stream.
 */
export const GENERATION_PHASE_LABEL: Record<GenerationStatus['phase'], string> = {
  waiting: 'WAITING',
  thinking: 'THINKING',
  responding: 'RESPONDING',
  tool: 'WORKING',
  approval: 'WORKING',
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
  /** What the frame shows: per-phase clock, except tool phases ride the stream clock (no per-tool reset). */
  const elapsed = computed(() => {
    const phase = status.value?.phase
    return phase === 'tool' || phase === 'approval' ? totalElapsed.value : phaseElapsed.value
  })
  const tokens = computed(() => {
    const s = status.value
    if (!s || s.outputTokens <= 0) return ''
    return `${s.outputTokensExact ? '' : '≈'}${formatTokenCount(s.outputTokens)} tokens`
  })

  return { status, label, toolName, phaseElapsed, totalElapsed, elapsed, tokens }
}

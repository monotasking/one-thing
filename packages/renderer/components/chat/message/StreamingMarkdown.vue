<template>
  <div
    v-if="shouldShowDeferredPlainText"
    class="markdown-deferred"
  >
    {{ displayedContent }}
  </div>
  <template v-else>
    <template
      v-for="seg in segments"
      :key="seg.key"
    >
      <StreamingHtmlSegment
        v-if="seg.type === 'markdown'"
        :segment-key="seg.key"
        :content="seg.content"
        :is-user="isUser"
        :streaming="useStableAssistantPipeline"
        :wrap-words="shouldWrapWords(seg.complete)"
        :animate-new-words="shouldAnimateWords(seg.complete)"
      />
      <StreamingCodeBlock
        v-else-if="seg.type === 'code'"
        :key="seg.key"
        :lang="seg.lang"
        :content="seg.content"
        :complete="seg.complete"
        :is-streaming="visualStreaming"
      />
      <StreamingTableBlock
        v-else
        :key="seg.key"
        :content="seg.content"
      />
    </template>
    <span
      v-if="visualStreaming && !isUser"
      class="stream-caret"
      data-stream-caret
      aria-hidden="true"
    />
  </template>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderMarkdown } from '@/composables/useMarkdownRenderer'
import { parseStreamingMarkdown, type MarkdownSegment } from '@/composables/parseStreamingMarkdown'
import { advanceStreamingReveal, createStreamingArrivalTracker } from '@/composables/streamingReveal'
import StreamingCodeBlock from './StreamingCodeBlock.vue'
import StreamingHtmlSegment from './StreamingHtmlSegment.vue'
import StreamingTableBlock from './StreamingTableBlock.vue'
import { enqueueMarkdownHydration } from './deferredMarkdownHydration'
import {
  cacheMarkdownHtml,
  cacheSegments,
  getCachedMarkdownHtml,
  getCachedSegments,
} from './markdownRenderCache'
import { getLogger } from '@/services/log'

const perfLog = getLogger('renderer.perf')

interface Props {
  content: string
  isUser?: boolean
  isStreaming?: boolean
  preserveLiveDom?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  preserveLiveDom: true,
})

const DEFER_MARKDOWN_CHAR_THRESHOLD = 4000
const THROTTLE_MARKDOWN_CHAR_THRESHOLD = 2000
const STREAMING_MARKDOWN_PARSE_INTERVAL_MS = 50
const STREAM_SETTLE_MS = 220
const STALE_REVEAL_PAUSE_MS = 300
const STALE_REVEAL_BACKLOG_CHARS = 1200

type RenderPhase = 'live' | 'settling' | 'stable'

const displayedContent = ref(props.content)
const parsedContent = ref(props.content)
const useStableAssistantPipeline = computed(() => !props.isUser)
const markdownHydrated = ref(true)
const prefersReducedMotion = ref(false)
const settling = ref(false)
const hasBeenVisuallyLive = ref(Boolean(!props.isUser && props.isStreaming))
const preserveLiveDom = computed(() => props.preserveLiveDom !== false)
const renderPhase = computed<RenderPhase>(() => {
  if (props.isUser) return 'stable'
  if (props.isStreaming || displayedContent.value !== props.content) return 'live'
  return settling.value ? 'settling' : 'stable'
})
const visualStreaming = computed(() => renderPhase.value === 'live')
const effectiveStreaming = computed(() =>
  Boolean(!props.isUser && renderPhase.value !== 'stable'),
)
let hydrationToken = 0
let reducedMotionQuery: MediaQueryList | null = null

const raf = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number
const caf = typeof cancelAnimationFrame === 'function'
  ? cancelAnimationFrame
  : (id: number) => clearTimeout(id)

let pendingFrame: number | null = null
let pendingParseTimer: ReturnType<typeof setTimeout> | null = null
let settleTimer: ReturnType<typeof setTimeout> | null = null
let lastRevealTs = 0
let lastParseCommitTs = 0
let windowBlurred = false
// Measures how fast the upstream actually delivers, so the reveal can match
// it. Sources range from a native provider's near-per-frame SSE to a batching
// connector's ~1Hz bursts.
const arrivalTracker = createStreamingArrivalTracker()

function cancelPendingFrame() {
  if (pendingFrame === null) return
  caf(pendingFrame)
  pendingFrame = null
}

function cancelPendingParse() {
  if (pendingParseTimer === null) return
  clearTimeout(pendingParseTimer)
  pendingParseTimer = null
}

function cancelSettling() {
  if (settleTimer !== null) {
    clearTimeout(settleTimer)
    settleTimer = null
  }
  settling.value = false
}

function commitParsedContent() {
  cancelPendingParse()
  parsedContent.value = displayedContent.value
  lastParseCommitTs = performance.now()
}

function shouldThrottleStreamingParse(): boolean {
  return Boolean(
    !props.isUser &&
    effectiveStreaming.value &&
    displayedContent.value.length > THROTTLE_MARKDOWN_CHAR_THRESHOLD,
  )
}

function scheduleParsedContentUpdate() {
  if (!shouldThrottleStreamingParse()) {
    commitParsedContent()
    return
  }

  const now = performance.now()
  const elapsed = now - lastParseCommitTs
  if (elapsed >= STREAMING_MARKDOWN_PARSE_INTERVAL_MS) {
    commitParsedContent()
    return
  }

  if (pendingParseTimer !== null) return
  pendingParseTimer = setTimeout(() => {
    pendingParseTimer = null
    commitParsedContent()
  }, STREAMING_MARKDOWN_PARSE_INTERVAL_MS - elapsed)
}

function commitDisplayedContent() {
  cancelPendingFrame()
  cancelSettling()
  displayedContent.value = props.content
  commitParsedContent()
  lastRevealTs = 0
  arrivalTracker.reset()
  scheduleDeferredMarkdownHydration()
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function shouldBypassReveal(): boolean {
  return Boolean(!props.isUser && (windowBlurred || isDocumentHidden()))
}

function syncDisplayedContentIfBackgrounded() {
  if (shouldBypassReveal() && displayedContent.value !== props.content) {
    commitDisplayedContent()
  }
}

function prewarmStableMarkdownCache() {
  if (props.isUser || !props.content) return
  const content = props.content
  enqueueMarkdownHydration(() => {
    const key = `static:${contentCacheKey(content)}`
    if (getCachedMarkdownHtml(key) !== undefined) return
    cacheMarkdownHtml(key, renderMarkdown(content, false, { streaming: false }))
  })
}

function beginSettling() {
  if (!props.isUser) hasBeenVisuallyLive.value = true

  if (props.isUser || !preserveLiveDom.value) {
    settling.value = false
    prewarmStableMarkdownCache()
    return
  }

  settling.value = true
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settleTimer = null
    settling.value = false
    prewarmStableMarkdownCache()
  }, STREAM_SETTLE_MS)
}

function revealDisplayedContent(ts: number) {
  pendingFrame = null
  const elapsed = lastRevealTs > 0 ? ts - lastRevealTs : 16

  const advance = advanceStreamingReveal(displayedContent.value, props.content, elapsed, {
    catchUpAfterMs: STALE_REVEAL_PAUSE_MS,
    catchUpRemainingChars: STALE_REVEAL_BACKLOG_CHARS,
    ...(arrivalTracker.intervalMs !== undefined
      ? { arrivalIntervalMs: arrivalTracker.intervalMs }
      : {}),
    reducedMotion: prefersReducedMotion.value,
  })
  const next = advance.content

  // Paced hold: less than one unit was due this frame. Leave `lastRevealTs`
  // alone so `elapsed` keeps accumulating — resetting it here would cap the
  // reveal at one unit per frame and defeat the pacing entirely.
  if (!advance.done && next === displayedContent.value) {
    scheduleDisplayedContent()
    return
  }

  lastRevealTs = ts
  displayedContent.value = next
  scheduleParsedContentUpdate()

  if (next !== props.content) {
    scheduleDisplayedContent()
  } else {
    // Caught up — the rAF loop stops here until the next arrival. Reset the
    // clock: otherwise the first frame after an 800ms upstream silence
    // measures that silence as `elapsed`, trips `catchUpAfterMs`, and dumps
    // the whole backlog at once. Catch-up must mean "the render thread
    // stalled", never "the source went quiet".
    lastRevealTs = 0
    commitParsedContent()
    scheduleDeferredMarkdownHydration()
    beginSettling()
  }
}

function scheduleDisplayedContent() {
  if (pendingFrame !== null) return
  pendingFrame = raf(revealDisplayedContent)
}

function isContentFullyCached(): boolean {
  const streaming = useStableAssistantPipeline.value
  const segKey = `${streaming ? '1' : '0'}:${contentCacheKey(displayedContent.value)}`
  const cachedSegments = getCachedSegments(segKey)
  if (!cachedSegments) return false
  for (const seg of cachedSegments) {
    if (seg.type !== 'markdown') continue
    const mdKey = `${props.isUser ? 'user' : 'assistant'}:${streaming ? '1' : '0'}:${seg.key}:${contentCacheKey(seg.content)}`
    if (getCachedMarkdownHtml(mdKey) === undefined) return false
  }
  return true
}

function shouldDeferMarkdown(): boolean {
  if (props.isUser || props.isStreaming) return false
  if (preserveLiveDom.value && hasBeenVisuallyLive.value) return false
  if (props.content.length <= DEFER_MARKDOWN_CHAR_THRESHOLD) return false
  // Cache hit means render cost is ~free — skip the deferral so revisits don't flash raw text.
  return !isContentFullyCached()
}

function scheduleDeferredMarkdownHydration() {
  hydrationToken++
  const token = hydrationToken

  if (!shouldDeferMarkdown()) {
    markdownHydrated.value = true
    return
  }

  markdownHydrated.value = false
  enqueueMarkdownHydration(() => {
    if (token !== hydrationToken) return
    markdownHydrated.value = true
  })
}

const shouldShowDeferredPlainText = computed(() =>
  !markdownHydrated.value && displayedContent.value.length > 0,
)

function contentCacheKey(content: string): string {
  let hash = 2166136261
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${content.length}:${hash >>> 0}`
}

watch(
  () => props.content,
  () => {
    // Every content change is one upstream arrival — this is where the source
    // cadence is measured.
    arrivalTracker.record(performance.now())

    if (!props.isUser && props.isStreaming) {
      hasBeenVisuallyLive.value = true
    }

    if (shouldBypassReveal()) {
      commitDisplayedContent()
      return
    }

    if (!props.isUser && (props.isStreaming || hasBeenVisuallyLive.value)) {
      if (!props.content.startsWith(displayedContent.value)) {
        cancelSettling()
        displayedContent.value = props.content
        scheduleParsedContentUpdate()
        lastRevealTs = 0
        arrivalTracker.reset()
        return
      }
      cancelSettling()
      scheduleDisplayedContent()
    } else {
      commitDisplayedContent()
    }
  },
)

watch(
  () => props.isStreaming,
  (isStreaming) => {
    if (isStreaming && !props.isUser) {
      hasBeenVisuallyLive.value = true
      // A fresh run may be fed by a different provider — start measuring the
      // cadence over rather than inheriting the last one's.
      arrivalTracker.reset()
    }

    if (shouldBypassReveal()) {
      commitDisplayedContent()
      return
    }

    if (isStreaming && !props.isUser) {
      cancelSettling()
      scheduleDisplayedContent()
      return
    }
    if (!isStreaming) {
      if (!props.isUser && props.content.startsWith(displayedContent.value)) {
        if (props.content === displayedContent.value) {
          commitParsedContent()
          scheduleDeferredMarkdownHydration()
          beginSettling()
          return
        }
        scheduleDisplayedContent()
      } else {
        commitDisplayedContent()
      }
    }
  },
  { flush: 'sync' },
)

scheduleDeferredMarkdownHydration()

/**
 * User messages don't get markdown parsing (they render as escaped text
 * with line-break conversion). Assistant messages are split into
 * markdown + fenced-code segments; the latter go to StreamingCodeBlock
 * so they get stable DOM across streaming updates.
 */
const segments = computed<MarkdownSegment[]>(() => {
  if (props.isUser) {
    return [{ type: 'markdown', key: 'user-md', content: parsedContent.value, complete: true }]
  }
  const streaming = useStableAssistantPipeline.value
  const cacheKey = `${streaming ? '1' : '0'}:${contentCacheKey(parsedContent.value)}`
  const cached = getCachedSegments(cacheKey)
  if (cached) return cached

  const started = performance.now()
  const parsed = parseStreamingMarkdown(parsedContent.value, { streaming })
  cacheSegments(cacheKey, parsed)
  const elapsed = performance.now() - started
  if (elapsed > 16) {
    perfLog.debug('markdown segment parse slow', {
      elapsedMs: Math.round(elapsed),
      chars: parsedContent.value.length,
      segments: parsed.length,
    })
  }
  return parsed
})

function shouldWrapWords(complete: boolean): boolean {
  return Boolean(
    !props.isUser &&
    !complete &&
    !prefersReducedMotion.value &&
    (renderPhase.value === 'live' || renderPhase.value === 'settling'),
  )
}

function shouldAnimateWords(complete: boolean): boolean {
  return shouldWrapWords(complete) && renderPhase.value === 'live'
}

function updateReducedMotion() {
  prefersReducedMotion.value = reducedMotionQuery?.matches ?? false
}

function handleWindowBlur() {
  windowBlurred = true
  syncDisplayedContentIfBackgrounded()
}

function handleWindowFocus() {
  windowBlurred = false
  if (displayedContent.value !== props.content) {
    commitDisplayedContent()
  }
}

function handleVisibilityChange() {
  if (isDocumentHidden()) {
    syncDisplayedContentIfBackgrounded()
    return
  }
  if (displayedContent.value !== props.content) {
    commitDisplayedContent()
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('focus', handleWindowFocus)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  updateReducedMotion()
  reducedMotionQuery.addEventListener?.('change', updateReducedMotion)
})

onBeforeUnmount(() => {
  hydrationToken++
  if (typeof window !== 'undefined') {
    window.removeEventListener('blur', handleWindowBlur)
    window.removeEventListener('focus', handleWindowFocus)
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
  reducedMotionQuery?.removeEventListener?.('change', updateReducedMotion)
  reducedMotionQuery = null
  cancelPendingFrame()
  cancelPendingParse()
  cancelSettling()
})

</script>

<style scoped>
/* Transparent wrapper so .content :deep(...) descendant selectors still
   match the rendered markdown children, and margin collapsing around
   paragraphs / code blocks behaves like the old single-blob v-html. */
.md-segment {
  display: contents;
}

.md-segment :deep(.stream-word) {
  display: inline-block;
  opacity: 1;
  will-change: opacity;
}

.md-segment :deep(.stream-word.is-new) {
  animation: streamWordFadeIn 180ms ease-out both;
}

@keyframes streamWordFadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .md-segment :deep(.stream-word),
  .md-segment :deep(.stream-word.is-new) {
    animation: none;
    will-change: auto;
  }
}

.markdown-deferred {
  white-space: pre-wrap;
  word-break: break-word;
}

.stream-caret {
  position: absolute;
  display: block;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}
</style>

<template>
  <div
    ref="detailsRef"
    class="tool-step-details"
    @wheel="handleWheel"
  >
    <!-- Blueprint spec tag riding the frame border: tool · status. Success is
         silent (no OK badge), and the +N/−N takeoff is NOT repeated here — the
         ledger row already carries it, and a number said twice reads as two
         different numbers. -->
    <span class="fig-tag">{{ figLabel }}<span
      v-if="figStatus"
      class="fig-status"
      :class="figStatus.tone"
    >&nbsp;·&nbsp;{{ figStatus.text }}</span></span>

    <div
      v-if="bashCommand"
      class="fig-cmd"
    >
      <span class="fig-cmd-ps">$</span>{{ bashCommand }}
    </div>

    <dl
      v-if="argEntries.length"
      class="detail-args"
    >
      <template
        v-for="entry in argEntries"
        :key="entry.key"
      >
        <dt class="detail-arg-key">
          {{ entry.key }}
        </dt>
        <dd class="detail-arg-value">
          {{ entry.value }}
        </dd>
      </template>
    </dl>

    <!-- Three states, never blurred together: while arguments stream the
         draft view shows exactly what has been received (cursor on the open
         field, measured counters, no predictions); once received, the settled
         args preview takes over; and only after the tool runs does a real
         diff of the file exist. -->
    <ToolArgsDraft
      v-if="streamingDraft"
      :draft="streamingDraft"
      :start-time="props.view.toolCall.timestamp"
    />
    <DiffView
      v-else-if="settledDiff"
      :diff="settledDiff.diff"
      :hunks="settledDiff.hunks"
      diff-style="unified"
      :show-file-header="false"
      :show-toolbar="false"
      :expand-unchanged="false"
      max-height="var(--tool-pane-max)"
      class="tool-step-diff"
    />
    <ToolContentPreview
      v-else-if="showPreview"
      ref="streamingPreviewRef"
      :lines="view.streamingPreviewLines"
      :status="view.status"
      :wrap="wrap !== false"
    />

    <!-- Result output only when the figure doesn't already tell the story:
         successful edit/write results ("Successfully edited …") duplicate
         the row title + diff and are suppressed. -->
    <template v-if="!hasFigure && !isFailedEdit">
      <div
        v-if="view.step.partialResult"
        class="detail-section result-section"
      >
        <ToolResultRenderer
          :result="view.step.partialResult"
          :is-partial="view.step.partialResultIsPartial"
          :render-kind="resultRenderKind"
          :tool-name="view.toolName"
        />
      </div>

      <div
        v-else-if="view.liveOutput"
        class="detail-section result-section"
      >
        <ToolResultRenderer
          :result="liveResultForRenderer"
          :is-partial="true"
          :render-kind="resultRenderKind"
          :tool-name="view.toolName"
        />
      </div>

      <div
        v-else-if="resultForRenderer"
        class="detail-section result-section"
      >
        <ToolResultRenderer
          :result="resultForRenderer"
          :render-kind="resultRenderKind"
          :tool-name="view.toolName"
        />
      </div>
    </template>

    <div
      v-if="view.step.thinking"
      class="detail-section"
    >
      <div class="detail-label">
        Thinking
      </div>
      <pre class="thinking">{{ view.step.thinking }}</pre>
    </div>

    <div
      v-if="view.step.summary"
      class="detail-section"
    >
      <div class="detail-label">
        Analysis
      </div>
      <pre class="summary">{{ view.step.summary }}</pre>
    </div>

    <div
      v-if="showErrorSection"
      class="detail-section error-section"
      :class="view.status === 'rejected' ? 'rejection' : 'error'"
    >
      <div class="detail-label">
        {{ view.status === 'rejected' ? 'Rejected' : 'Error' }}
      </div>
      <!-- The error text is the whole story of a failed call — it is shown
           plainly, never behind a disclosure. A pane that is already open is
           the answer to "what went wrong"; making the answer cost one more
           click was the last fold in this area. -->
      <pre :class="view.status === 'rejected' ? 'rejection-text' : 'error-text'">{{ compactError }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ToolPartialResult } from '@/types'
import type { ToolStepView } from '@/stores/helpers/tool-step-view'
import { getToolUiCategory } from '@/stores/helpers/tool-ui-registry'
import { chainWheelToScrollableAncestor, findScrollableWheelSource } from '@/utils/scroll-chain'
import ToolArgsDraft from './ToolArgsDraft.vue'
import ToolContentPreview from './ToolContentPreview.vue'
import DiffView from './message/DiffView.vue'
import ToolResultRenderer from './ToolResultRenderer.vue'

const props = defineProps<{
  view: ToolStepView
  /** Soft-wrap long diff lines (controlled by the outer tool-step header) */
  wrap?: boolean
}>()

const streamingPreviewRef = ref<InstanceType<typeof ToolContentPreview> | null>(null)
const detailsRef = ref<HTMLElement | null>(null)

const figLabel = computed(() => (props.view.displayName || props.view.toolName || 'tool').toUpperCase())

const figStatus = computed(() => {
  switch (props.view.status) {
    case 'failed': return { text: 'FAILED', tone: 'bad' }
    case 'rejected': return { text: 'REJECTED', tone: 'bad' }
    case 'cancelled': return { text: 'CANCELLED', tone: 'dim' }
    case 'awaiting-confirmation': return { text: 'NEEDS APPROVAL', tone: 'warn' }
    // RECEIVING is the argument stream, RUNNING the tool itself — the two
    // phases the old single RUNNING badge used to blur together.
    case 'streaming-input': return { text: 'RECEIVING', tone: 'live' }
    case 'received':
    case 'executing': return { text: 'RUNNING', tone: 'live' }
    // Success is silent: a pane that rendered at all already succeeded, and an
    // OK badge on every finished call is noise that hides the real states.
    default: return null
  }
})

const streamingDraft = computed(() =>
  props.view.status === 'streaming-input' ? props.view.streamingDraft : null,
)

/** Bash gets a shell-style `$ command` line instead of a key/value row. */
const bashCommand = computed(() => {
  if (props.view.toolName !== 'bash') return ''
  const command = props.view.toolCall.arguments?.command
  return typeof command === 'string' ? command : ''
})

const isFailedEdit = computed(() => props.view.toolName === 'edit' && (props.view.status === 'failed' || props.view.status === 'rejected'))
/** The real patch, which only exists once the tool has run. */
const settledDiff = computed(() => (props.view.diff && !isFailedEdit.value) ? props.view.diff : null)
/** The streamed arguments, shown until the real patch lands. */
const showPreview = computed(() => !props.view.diff && !isFailedEdit.value && props.view.streamingPreviewLines.length > 0)
const hasFigure = computed(() => !!streamingDraft.value || !!settledDiff.value || showPreview.value)
const resultRenderKind = computed(() => props.view.toolName === 'bash' ? 'bash' : 'text')
const resultForRenderer = computed<ToolPartialResult | null>(() => {
  if (!props.view.resultText) return null
  return { content: [{ type: 'text', text: props.view.resultText }] }
})
const liveResultForRenderer = computed<ToolPartialResult | null>(() => {
  if (!props.view.liveOutput) return null
  return { content: [{ type: 'text', text: props.view.liveOutput }] }
})
interface ArgEntry {
  key: string
  value: string
}

const ARG_VALUE_MAX = 600

/**
 * Message-body args shown IN FULL, like the bash command: the message IS the
 * tool's entire payload, and these details are the only place to read it —
 * the value cell scroll-contains anything longer than its max-height.
 */
const FULL_VALUE_ARGS: Record<string, string> = {
  send_message: 'content',
  say: 'content',
  dm: 'message',
}

/**
 * Structured arguments for tools whose parameters carry information beyond
 * the row title (console/search/mcp/unknown). File tools skip this — their
 * path is the title and their content is the diff. The bash command is
 * always included IN FULL: the single-line row title truncates, so the
 * expanded details are the guaranteed place to read the whole command.
 */
const argEntries = computed<ArgEntry[]>(() => {
  const category = getToolUiCategory(props.view.toolName)
  if (category === 'read' || category === 'write' || category === 'edit') return []
  const args = props.view.toolCall.arguments || {}
  return Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    // The bash command renders as the `$ …` line above, not as a key/value.
    .filter(([key]) => !(props.view.toolName === 'bash' && key === 'command'))
    .map(([key, value]) => {
      const text = formatParamValue(value)
      const showFull = FULL_VALUE_ARGS[props.view.toolName] === key
      return {
        key,
        value: !showFull && text.length > ARG_VALUE_MAX
          ? `${text.slice(0, ARG_VALUE_MAX - 1)}…`
          : text,
      }
    })
})

const compactError = computed(() => compactErrorText(props.view.step.error || ''))
const compactErrorReason = computed(() => compactToolFailureReason(compactError.value))
/**
 * Whether the stored error says more than the row summary already does. A
 * single line identical to the row title is not worth a second box — this is
 * the ONLY gate now; once the section renders, the text renders in full.
 */
const errorAddsInformation = computed(() => {
  const error = compactError.value.trim()
  if (!error) return false
  const reason = compactErrorReason.value
  if (!reason) return error.includes('\n')
  if (normalizeErrorText(error) === normalizeErrorText(reason)) return false
  return error.split('\n').filter(line => line.trim()).length > 1
})
/** A failed edit has no diff and no result: the error IS its content. */
const isFailedEditError = computed(() => isFailedEdit.value && !!props.view.step.error)
const showErrorSection = computed(() => !!props.view.step.error && (isFailedEditError.value || errorAddsInformation.value))

function formatParamValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function handleWheel(event: WheelEvent) {
  chainWheelToScrollableAncestor(event, findScrollableWheelSource(event, detailsRef.value))
}

function compactOutput(value: string): string {
  return value.replace(/\n{3,}/g, '\n\n').trimEnd()
}

function compactErrorText(value: string): string {
  const seenPaths = new Set<string>()
  return compactOutput(value)
    .replace(/\/[^\s:]+(?:\/[^\s:]+)+/g, (path) => {
      if (seenPaths.has(path)) return 'the same file'
      seenPaths.add(path)
      return path
    })
}

function compactToolFailureReason(value: string): string {
  let reason = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) || ''

  for (let index = 0; index < 3; index++) {
    const stripped = reason
      .replace(/^error:\s*/i, '')
      .replace(/^failed:\s*/i, '')
      .replace(/^failed to\s+\w+\s+[^:]+:\s*/i, '')
      .replace(/^\w+\s+failed:\s*[^:]+:\s*/i, '')
    if (stripped === reason) break
    reason = stripped
  }

  return reason
}

function normalizeErrorText(value: string): string {
  return compactToolFailureReason(value).replace(/\s+/g, ' ').trim().toLowerCase()
}

watch(
  () => props.view.streamingContent?.content,
  () => {
    nextTick(() => {
      streamingPreviewRef.value?.scrollToBottom()
    })
  },
  { immediate: true },
)
</script>

<style scoped>
/* Blueprint figure frame: zero radius, full 1px outline, spec tags riding
   the border (their solid background knocks the border line out). The pane
   owns its whole surface — mount points only position it. */
.tool-step-details {
  --tool-pane-max: clamp(148px, 28vh, 240px);
  --fig-line: color-mix(in srgb, var(--ui-tool-border-border, var(--ui-tool-surface-border)) 90%, transparent);
  --fig-knockout: var(--ui-surface-chat-bg);
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding: 13px 14px 10px;
  border: 1px solid var(--fig-line);
  border-radius: 0;
  font-family: var(--tool-font-sans);
}

.fig-tag {
  position: absolute;
  top: -8px;
  left: 10px;
  z-index: 1;
  max-width: calc(100% - 24px);
  padding: 0 7px;
  background: var(--fig-knockout);
  color: var(--ui-tool-text-fg);
  font-family: var(--tool-font-mono);
  font-size: var(--tool-font-size-meta);
  font-weight: 650;
  letter-spacing: 1.8px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-transform: uppercase;
}

.fig-status { font-weight: 600; }
.fig-status.bad { color: var(--ui-tool-danger-text-fg); }
.fig-status.live { color: var(--ui-tool-accent-fg); }
.fig-status.warn { color: var(--ui-status-warning-fg, var(--ui-tool-accent-fg)); }
.fig-status.dim { color: var(--ui-tool-text-faint-fg); }

.fig-cmd {
  /* A 300-line heredoc is still one bash command: it scrolls inside the pane
     instead of stretching the whole figure. */
  max-height: var(--tool-pane-max);
  overflow: auto;
  color: var(--ui-tool-text-fg);
  font-family: var(--tool-font-mono);
  font-size: var(--tool-font-size-body);
  line-height: var(--tool-code-line-height);
  white-space: pre-wrap;
  word-break: break-word;
}

.fig-cmd-ps {
  margin-right: 8px;
  color: var(--ui-tool-accent-fg);
}

.detail-section {
  min-width: 0;
  padding: 0;
  border-top: 0;
}

.detail-section:has(.bash-output) {
  padding: 0;
}

.detail-section:first-child {
  border-top: 0;
}

.detail-section.live {
  padding: 0;
}

.detail-section.result-section {
  padding: 0;
}

.detail-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  color: var(--ui-tool-text-faint-fg);
  font-family: var(--tool-font-mono);
  font-size: var(--tool-font-size-meta);
  font-weight: 600;
  letter-spacing: 1.8px;
  text-transform: uppercase;
}

/* No `overscroll-behavior: contain` anywhere in this pane: a box that does not
   actually overflow is still treated as a scroll container by Chrome, and the
   contain then swallows the wheel instead of chaining it — a dead zone. The
   boundary is owned by the root @wheel → chainWheelToScrollableAncestor, which
   only preventDefault()s when the box really can scroll and is at its edge. */
pre {
  margin: 0;
  max-height: var(--tool-pane-max);
  overflow: auto;
  padding: 2px 0;
  color: var(--ui-tool-text-muted-fg);
  font-family: var(--tool-font-mono);
  font-size: var(--tool-font-size-body);
  font-weight: 400;
  line-height: var(--tool-code-line-height);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Blueprint semantics: outlined spec boxes, no fills, no side bars. */
.thinking {
  padding: 8px 10px;
  border: 1px solid var(--fig-line);
  background: transparent;
}

.summary {
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--ui-tool-success-text-fg) 35%, transparent);
  background: transparent;
}

.error-text {
  max-width: 72ch;
  /* Shown in full and un-folded; a stack trace scrolls in place rather than
     pushing the rest of the pane off screen. */
  max-height: calc(var(--tool-pane-max) * 0.6);
  overflow: auto;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--ui-tool-danger-text-fg) 40%, transparent);
  background: transparent;
  color: color-mix(in srgb, var(--ui-tool-danger-text-fg) 65%, var(--ui-tool-text-fg));
  font-size: var(--tool-font-size-meta);
  line-height: var(--tool-line-height);
}

.rejection-text {
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--ui-tool-accent-fg) 38%, transparent);
  background: transparent;
  color: var(--ui-tool-text-muted-fg);
  font-size: var(--tool-font-size-meta);
  line-height: var(--tool-line-height);
}

.error-section {
  padding-top: 12px;
  padding-bottom: 12px;
}

/* Structured arguments (console/search/mcp/unknown tools). */
.detail-args {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 3px 9px;
  max-width: 100%;
  margin: 0;
}

.detail-arg-key {
  color: var(--ui-tool-text-faint-fg);
  font-family: var(--tool-font-sans);
  font-size: var(--tool-font-size-meta);
  font-weight: 500;
  line-height: var(--tool-line-height);
}

.detail-arg-value {
  min-width: 0;
  max-height: calc(var(--tool-pane-max) * 0.4);
  margin: 0;
  overflow: auto;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  color: var(--ui-tool-text-muted-fg);
  font-family: var(--tool-font-mono);
  font-size: var(--tool-font-size-meta);
  line-height: var(--tool-line-height);
}
</style>

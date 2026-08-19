<template>
  <div class="code-block-container">
    <div class="code-block-header">
      <div class="code-block-lang">
        {{ displayLang }}
      </div>
      <Button
        unstyled
        class="code-block-copy"
        :class="{ copied }"
        :aria-label="complete ? 'Copy' : 'Copy (streaming)'"
        native-type="button"
        @click="handleCopy"
      >
        <svg
          class="copy-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <rect
            x="9"
            y="9"
            width="13"
            height="13"
            rx="2"
            ry="2"
          />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <svg
          class="check-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </Button>
    </div>
    <pre class="code-block-pre"><code
      ref="codeEl"
      :class="`cm-code language-${lang}`"
    /></pre>
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderTokenSpans } from '@/composables/codeTokenizer'
import { copyTextToClipboard } from '@/utils/clipboard'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.code-block')

interface Props {
  lang: string
  content: string
  complete: boolean
  isStreaming?: boolean
}

const props = defineProps<Props>()

const copied = ref(false)
const displayLang = computed(() => props.lang || 'text')
const codeEl = ref<HTMLElement | null>(null)

interface LineState {
  text: string
  frozen: boolean
  el: HTMLSpanElement
}

type AnimationFrameCallback = (time: number) => void

const raf = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : (cb: AnimationFrameCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number
const caf = typeof cancelAnimationFrame === 'function'
  ? cancelAnimationFrame
  : (id: number) => clearTimeout(id)

let lineStates: LineState[] = []
let renderFrame: number | null = null
let renderedLang = props.lang

function createLineEl(): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = 'code-line stream-code-line'
  el.dataset.codeLine = ''
  el.style.display = 'block'
  el.style.minHeight = '20px'
  return el
}

function renderLineEl(lineEl: HTMLElement, text: string) {
  lineEl.replaceChildren()
  const source = text || ' '
  const fragment = document.createDocumentFragment()
  for (const token of renderTokenSpans(props.lang, source)) {
    const span = document.createElement('span')
    if (token.className) span.className = token.className
    span.textContent = token.text
    fragment.appendChild(span)
  }
  lineEl.appendChild(fragment)
}

function clearRenderedLines() {
  codeEl.value?.replaceChildren()
  lineStates = []
  renderedLang = props.lang
}

function renderIncrementalCode() {
  const root = codeEl.value
  if (!root) return

  if (renderedLang !== props.lang) {
    // Language changes mean token classes are no longer comparable.
    clearRenderedLines()
  }

  const lines = props.content.split('\n')
  const activeLineIndex = props.complete ? -1 : lines.length - 1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const frozen = i !== activeLineIndex
    const existing = lineStates[i]

    if (existing && existing.text === line) {
      existing.frozen = existing.frozen || frozen
      continue
    }

    const lineEl = existing?.el ?? createLineEl()
    renderLineEl(lineEl, line)
    if (!existing) root.appendChild(lineEl)
    lineStates[i] = { text: line, frozen, el: lineEl }
  }

  while (lineStates.length > lines.length) {
    const removed = lineStates.pop()
    removed?.el.remove()
  }
}

function scheduleRender() {
  if (renderFrame !== null) return
  renderFrame = raf(() => {
    renderFrame = null
    renderIncrementalCode()
  })
}

watch(() => [props.content, props.lang, props.complete, props.isStreaming] as const, scheduleRender)

onMounted(() => {
  nextTick(renderIncrementalCode)
})

onBeforeUnmount(() => {
  if (renderFrame !== null) {
    caf(renderFrame)
    renderFrame = null
  }
  lineStates = []
})

async function handleCopy() {
  const success = await copyTextToClipboard(props.content)
  if (!success) {
    log.warn('code block copy failed')
    return
  }

  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 1500)
}
</script>

<style scoped>
.code-block-container .code-block-pre {
  margin: 0;
  padding: 12px 14px;
  overflow-x: auto;
  overflow-y: hidden;
  line-height: 20px;
  scrollbar-width: none;
  tab-size: 2;
}

.code-block-container .code-block-pre::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.code-block-container code {
  display: block;
  font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
  font-size: 13px;
  line-height: inherit;
  white-space: pre;
}

.code-block-container code :deep(.code-line) {
  display: block;
  min-height: 20px;
}

.code-block-container code :deep(.tok-keyword),
.code-block-container code :deep(.tok-atom) {
  color: var(--hg-syntax-keyword-fg, var(--text-code-keyword));
  background-color: var(--hg-syntax-keyword-bg, transparent);
  font-style: var(--hg-syntax-keyword-font-style, normal);
  font-weight: var(--hg-syntax-keyword-font-weight, 400);
  text-decoration: var(--hg-syntax-keyword-text-decoration, none);
}

.code-block-container code :deep(.tok-atom) {
  color: var(--hg-syntax-atom-fg, var(--text-code-keyword));
  background-color: var(--hg-syntax-atom-bg, transparent);
  font-style: var(--hg-syntax-atom-font-style, normal);
  font-weight: var(--hg-syntax-atom-font-weight, 400);
  text-decoration: var(--hg-syntax-atom-text-decoration, none);
}

.code-block-container code :deep(.tok-number) {
  color: var(--hg-syntax-number-fg, var(--text-code-number));
  background-color: var(--hg-syntax-number-bg, transparent);
  font-style: var(--hg-syntax-number-font-style, normal);
  font-weight: var(--hg-syntax-number-font-weight, 400);
  text-decoration: var(--hg-syntax-number-text-decoration, none);
}

.code-block-container code :deep(.tok-string) {
  color: var(--hg-syntax-string-fg, var(--text-code-string));
  background-color: var(--hg-syntax-string-bg, transparent);
  font-style: var(--hg-syntax-string-font-style, normal);
  font-weight: var(--hg-syntax-string-font-weight, 400);
  text-decoration: var(--hg-syntax-string-text-decoration, none);
}

.code-block-container code :deep(.tok-comment) {
  color: var(--hg-syntax-comment-fg, var(--text-code-comment));
  background-color: var(--hg-syntax-comment-bg, transparent);
  font-style: var(--hg-syntax-comment-font-style, italic);
  font-weight: var(--hg-syntax-comment-font-weight, 400);
  text-decoration: var(--hg-syntax-comment-text-decoration, none);
}

.code-block-container code :deep(.tok-definition) {
  color: var(--hg-syntax-definition-fg, var(--text-code-function));
  background-color: var(--hg-syntax-definition-bg, transparent);
  font-style: var(--hg-syntax-definition-font-style, normal);
  font-weight: var(--hg-syntax-definition-font-weight, 400);
  text-decoration: var(--hg-syntax-definition-text-decoration, none);
}

.code-block-container code :deep(.tok-function) {
  color: var(--hg-syntax-function-fg, var(--text-code-function));
  background-color: var(--hg-syntax-function-bg, transparent);
  font-style: var(--hg-syntax-function-font-style, normal);
  font-weight: var(--hg-syntax-function-font-weight, 400);
  text-decoration: var(--hg-syntax-function-text-decoration, none);
}

.code-block-container code :deep(.tok-variable) {
  color: var(--hg-syntax-variable-fg, var(--text-code-variable, inherit));
  background-color: var(--hg-syntax-variable-bg, transparent);
  font-style: var(--hg-syntax-variable-font-style, normal);
  font-weight: var(--hg-syntax-variable-font-weight, 400);
  text-decoration: var(--hg-syntax-variable-text-decoration, none);
}

.code-block-container code :deep(.tok-property) {
  color: var(--hg-syntax-property-fg, var(--text-code-property, var(--text-code-variable, inherit)));
  background-color: var(--hg-syntax-property-bg, transparent);
  font-style: var(--hg-syntax-property-font-style, normal);
  font-weight: var(--hg-syntax-property-font-weight, 400);
  text-decoration: var(--hg-syntax-property-text-decoration, none);
}

.code-block-container code :deep(.tok-type) {
  color: var(--hg-syntax-type-fg, var(--text-code-type));
  background-color: var(--hg-syntax-type-bg, transparent);
  font-style: var(--hg-syntax-type-font-style, normal);
  font-weight: var(--hg-syntax-type-font-weight, 400);
  text-decoration: var(--hg-syntax-type-text-decoration, none);
}

.code-block-container code :deep(.tok-tag) {
  color: var(--hg-syntax-tag-fg, var(--text-code-type));
  background-color: var(--hg-syntax-tag-bg, transparent);
  font-style: var(--hg-syntax-tag-font-style, normal);
  font-weight: var(--hg-syntax-tag-font-weight, 400);
  text-decoration: var(--hg-syntax-tag-text-decoration, none);
}

.code-block-container code :deep(.tok-punctuation) {
  color: var(--hg-syntax-punctuation-fg, var(--text-code-punctuation, var(--text-code-operator)));
  background-color: var(--hg-syntax-punctuation-bg, transparent);
  font-style: var(--hg-syntax-punctuation-font-style, normal);
  font-weight: var(--hg-syntax-punctuation-font-weight, 400);
  text-decoration: var(--hg-syntax-punctuation-text-decoration, none);
}

.code-block-container code :deep(.tok-invalid) {
  color: var(--hg-syntax-invalid-fg, var(--ui-status-danger-fg));
  background-color: var(--hg-syntax-invalid-bg, transparent);
  font-style: var(--hg-syntax-invalid-font-style, normal);
  font-weight: var(--hg-syntax-invalid-font-weight, 400);
  text-decoration: var(--hg-syntax-invalid-text-decoration, none);
}

.code-block-container code :deep(.tok-inserted) {
  color: var(--hg-syntax-inserted-fg, var(--ui-status-success-fg));
  background-color: var(--hg-syntax-inserted-bg, transparent);
  font-style: var(--hg-syntax-inserted-font-style, normal);
  font-weight: var(--hg-syntax-inserted-font-weight, 400);
  text-decoration: var(--hg-syntax-inserted-text-decoration, none);
}

.code-block-container code :deep(.tok-heading) {
  color: var(--hg-syntax-heading-fg, var(--text-code-function));
  background-color: var(--hg-syntax-heading-bg, transparent);
  font-style: var(--hg-syntax-heading-font-style, normal);
  font-weight: var(--hg-syntax-heading-font-weight, 700);
  text-decoration: var(--hg-syntax-heading-text-decoration, none);
}

.code-block-container code :deep(.tok-strong) {
  color: var(--hg-syntax-strong-fg, inherit);
  background-color: var(--hg-syntax-strong-bg, transparent);
  font-style: var(--hg-syntax-strong-font-style, normal);
  font-weight: var(--hg-syntax-strong-font-weight, 700);
  text-decoration: var(--hg-syntax-strong-text-decoration, none);
}

.code-block-container code :deep(.tok-emphasis) {
  color: var(--hg-syntax-emphasis-fg, inherit);
  background-color: var(--hg-syntax-emphasis-bg, transparent);
  font-style: var(--hg-syntax-emphasis-font-style, italic);
  font-weight: var(--hg-syntax-emphasis-font-weight, 400);
  text-decoration: var(--hg-syntax-emphasis-text-decoration, none);
}

.code-block-container code :deep(.tok-link) {
  color: var(--hg-syntax-link-fg, var(--ui-text-link-fg, var(--ui-accent-primary-fg)));
  background-color: var(--hg-syntax-link-bg, transparent);
  font-style: var(--hg-syntax-link-font-style, normal);
  font-weight: var(--hg-syntax-link-font-weight, 400);
  text-decoration: var(--hg-syntax-link-text-decoration, underline);
}
</style>

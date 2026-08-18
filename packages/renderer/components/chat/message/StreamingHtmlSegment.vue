<template>
  <div
    ref="rootRef"
    class="md-segment"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { renderMarkdown } from '@/composables/useMarkdownRenderer'
import { cacheMarkdownHtml, getCachedMarkdownHtml } from './markdownRenderCache'

interface Props {
  segmentKey: string
  content: string
  isUser?: boolean
  streaming?: boolean
  wrapWords?: boolean
  animateNewWords?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  isUser: false,
  streaming: false,
  wrapWords: false,
  animateNewWords: false,
})

const rootRef = ref<HTMLElement | null>(null)
const seenWordKeys = new Set<string>()

function contentCacheKey(content: string): string {
  let hash = 2166136261
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${content.length}:${hash >>> 0}`
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

const renderedHtml = computed(() => {
  const content = props.content ?? ''
  const cacheKey = `${props.isUser ? 'user' : 'assistant'}:${props.streaming ? '1' : '0'}:${props.segmentKey}:${contentCacheKey(content)}`
  const cached = getCachedMarkdownHtml(cacheKey)
  if (cached) return cached

  const started = nowMs()
  const html = renderMarkdown(content, props.isUser, { streaming: props.streaming })
  cacheMarkdownHtml(cacheKey, html)
  const elapsed = nowMs() - started
  if (elapsed > 16) {
    console.info('[Perf][Markdown][html]', {
      elapsedMs: Math.round(elapsed),
      chars: content.length,
      isUser: props.isUser,
      streaming: props.streaming,
    })
  }
  return html
})

watch(
  () => [props.segmentKey, props.content] as const,
  ([segmentKey, content], [previousSegmentKey, previousContent]) => {
    if (segmentKey !== previousSegmentKey || !content.startsWith(previousContent ?? '')) {
      seenWordKeys.clear()
    }
  },
  { flush: 'sync' },
)

watch(
  () => [renderedHtml.value, props.wrapWords, props.animateNewWords] as const,
  () => patchRenderedHtml(),
  { flush: 'post' },
)

onMounted(() => {
  patchRenderedHtml()
})

function patchRenderedHtml() {
  const root = rootRef.value
  if (!root || typeof document === 'undefined') return

  const template = document.createElement('template')
  template.innerHTML = renderedHtml.value
  if (props.wrapWords) {
    wrapStreamingWords(template.content, props.animateNewWords)
  }
  patchChildren(root, template.content)
}

function canPatchNode(current: ChildNode, next: ChildNode): boolean {
  if (current.nodeType !== next.nodeType) return false
  if (current.nodeType === 1 && next.nodeType === 1) {
    const currentElement = current as Element
    const nextElement = next as Element
    return currentElement.tagName === nextElement.tagName &&
      hasSameCriticalAttributes(currentElement, nextElement)
  }
  return true
}

function hasSameCriticalAttributes(current: Element, next: Element): boolean {
  const tag = current.tagName.toLowerCase()
  const criticalAttributes = getCriticalAttributes(tag)
  return criticalAttributes.every(attr => current.getAttribute(attr) === next.getAttribute(attr))
}

function getCriticalAttributes(tag: string): string[] {
  switch (tag) {
    case 'a':
      return ['href']
    case 'img':
      return ['src']
    case 'code':
      return ['class']
    default:
      return []
  }
}

function patchNode(current: ChildNode, next: ChildNode) {
  if (!canPatchNode(current, next)) {
    current.replaceWith(next.cloneNode(true))
    return
  }

  if (current.nodeType === 3 || current.nodeType === 8) {
    if (current.nodeValue !== next.nodeValue) {
      current.nodeValue = next.nodeValue
    }
    return
  }

  if (current.nodeType === 1 && next.nodeType === 1) {
    const currentElement = current as Element
    const nextElement = next as Element
    syncAttributes(currentElement, nextElement)
    patchChildren(currentElement, nextElement)
  }
}

function patchChildren(currentParent: ParentNode, nextParent: ParentNode) {
  const nextNodes = Array.from(nextParent.childNodes)

  for (let index = 0; index < nextNodes.length; index += 1) {
    const currentNode = currentParent.childNodes[index]
    const nextNode = nextNodes[index]

    if (!currentNode) {
      currentParent.appendChild(nextNode.cloneNode(true))
      continue
    }

    patchNode(currentNode, nextNode)
  }

  while (currentParent.childNodes.length > nextNodes.length) {
    const extraNode = currentParent.childNodes[nextNodes.length]
    if (!extraNode) break
    currentParent.removeChild(extraNode)
  }
}

function syncAttributes(current: Element, next: Element) {
  for (const attr of Array.from(current.attributes)) {
    if (!next.hasAttribute(attr.name)) {
      current.removeAttribute(attr.name)
    }
  }

  for (const attr of Array.from(next.attributes)) {
    if (current.getAttribute(attr.name) !== attr.value) {
      current.setAttribute(attr.name, attr.value)
    }
  }
}

function isSkippableTextParent(parent: ParentNode | null): boolean {
  if (!(parent instanceof Element)) return false
  return !!parent.closest('pre, code, script, style, mjx-container, [data-stream-word]')
}

function wrapStreamingWords(root: ParentNode, animateNew: boolean) {
  const walker = document.createTreeWalker(root, 4)
  const textNodes: Text[] = []
  let current = walker.nextNode()
  while (current) {
    const node = current as Text
    if (node.textContent && !isSkippableTextParent(node.parentNode)) {
      textNodes.push(node)
    }
    current = walker.nextNode()
  }

  let wordIndex = 0
  const wordPattern = /[\p{Script=Han}]|[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu

  for (const node of textNodes) {
    const text = node.textContent || ''
    wordPattern.lastIndex = 0
    let lastIndex = 0
    let match = wordPattern.exec(text)
    if (!match) continue

    const fragment = document.createDocumentFragment()
    while (match) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)))
      }

      const word = match[0]
      const wordKey = `${props.segmentKey}:${wordIndex}:${word}`
      const span = document.createElement('span')
      span.dataset.streamWord = ''
      const isNew = animateNew && !seenWordKeys.has(wordKey)
      span.className = isNew ? 'stream-word is-new' : 'stream-word is-seen'
      span.textContent = word
      fragment.appendChild(span)
      seenWordKeys.add(wordKey)

      wordIndex += 1
      lastIndex = match.index + word.length
      match = wordPattern.exec(text)
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)))
    }
    node.replaceWith(fragment)
  }
}
</script>

<style scoped>
/* Transparent wrapper so .content :deep(...) descendant selectors still
   match the rendered markdown children, and margin collapsing around
   paragraphs behaves like the old single-blob v-html. */
.md-segment {
  display: contents;
}

/* `inline`, never `inline-block`: an atomic inline adds line-break
   opportunities plain text does not have (around `Foo.vue`, `a/b`, URLs), so
   the wrapped live paragraph and the unwrapped completed one could wrap to
   different line counts — measured 10/105 mixed CJK/Latin paragraphs — and
   everything below jumped at every paragraph boundary. Opacity animates on
   inline spans just the same. */
.md-segment :deep(.stream-word) {
  display: inline;
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
</style>

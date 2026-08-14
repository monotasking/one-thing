<template>
  <div
    ref="hostRef"
    class="prose-note-editor"
    :data-surface="surface"
  />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { EditorView } from 'prosemirror-view'
import { TextSelection, Selection } from 'prosemirror-state'
import { platformApi } from '@/platform'
import { markdownApi } from '@/platform/markdown-client'
import type { MarkdownAssetResolution } from '@shared/ipc/markdown'
import type {
  MarkdownCommand,
  MarkdownDocumentEditorHandle,
  MarkdownDocumentSurface,
  MarkdownFeatureSet,
} from '../markdown-document'
import type { EditorSettings, EditorSelection as HandleSelection } from '../types'
import { createNoteEditorState, createNoteEditorView, noteEditorMarkdown, parseNoteMarkdown } from './editor'
import { applyNoteCommand } from './commands'
import { draftRangeToPmRange, pmRangeToDraftRange } from './offset-map'
import './note-editor.css'

const props = withDefaults(defineProps<{
  modelValue: string
  surface?: MarkdownDocumentSurface
  documentId?: string
  documentPath?: string
  workspaceRoot?: string
  settings?: EditorSettings
  features?: MarkdownFeatureSet
  toolbar?: boolean
  placeholder?: string
  spellcheck?: boolean
  sourceToggle?: boolean
}>(), {
  surface: 'todo-notes',
  modelValue: '',
  documentId: '',
  documentPath: '',
  workspaceRoot: '',
  settings: undefined,
  features: undefined,
  placeholder: '',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'keydown': [event: KeyboardEvent]
  'paste': [event: ClipboardEvent]
  'openLink': [payload: { href: string, asset?: MarkdownAssetResolution | null }]
  'openImage': [payload: { src: string, alt: string, asset?: MarkdownAssetResolution | null }]
  'cancel': []
}>()

const hostRef = ref<HTMLElement | null>(null)
let view: EditorView | null = null
let lastEmitted = ''
let lastSelectionReport: HandleSelection = { from: 0, to: 0 }

async function resolveAsset(rawTarget: string): Promise<MarkdownAssetResolution | null> {
  if (!props.documentPath) return null
  const response = await markdownApi.resolveAsset({
    documentPath: props.documentPath,
    workspaceRoot: props.workspaceRoot,
    rawTarget,
  })
  return response.success ? response.asset || null : null
}

function mount(): void {
  if (!hostRef.value) return
  view = createNoteEditorView({
    markdown: props.modelValue,
    parent: hostRef.value,
    resolveImageSrc: async (rawSrc) => {
      if (/^(?:https?:|data:)/i.test(rawSrc)) return rawSrc
      const asset = await resolveAsset(rawSrc)
      return asset?.dataUrl || null
    },
    onOpenImage: payload => emit('openImage', payload),
    onOpenLink: href => emit('openLink', { href }),
    onDocChanged: (currentView) => {
      const markdown = noteEditorMarkdown(currentView)
      // Correction transactions right after a document switch serialize to
      // the same markdown; re-emitting would schedule a pointless save.
      if (markdown === lastEmitted) return
      lastEmitted = markdown
      emit('update:modelValue', lastEmitted)
    },
  })
  view.dom.addEventListener('keydown', handleKeydown)
  view.dom.addEventListener('paste', handlePaste)
  view.dom.addEventListener('click', handleClick)
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !event.defaultPrevented) {
    emit('cancel')
    return
  }
  emit('keydown', event)
}

function handlePaste(event: ClipboardEvent): void {
  emit('paste', event)
}

function handleClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  const link = target?.closest?.('a.pm-note-link') as HTMLElement | null
  if (link && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    const href = link.getAttribute('href') || ''
    if (href) emit('openLink', { href })
  }
}

// Switching to a different note replaces the whole editor state: no diffing
// against unrelated content (which re-mounted every block and made the caret
// flicker), and — importantly — a fresh undo history, so undo can never walk
// back into the previous note's content.
watch(() => props.documentId, () => {
  if (!view) return
  lastEmitted = props.modelValue
  lastSelectionReport = { from: 0, to: 0 }
  view.updateState(createNoteEditorState(props.modelValue))
})

// External updates to the SAME document (AI co-writes, snapshot refreshes)
// apply as a minimal block-level diff transaction: only the changed top-level
// range is replaced, so the selection survives via ProseMirror's position
// mapping instead of text-search heuristics.
watch(() => props.modelValue, (value) => {
  if (!view || value === lastEmitted || value === noteEditorMarkdown(view)) return
  const current = view.state.doc
  const next = parseNoteMarkdown(value)
  if (current.eq(next)) {
    lastEmitted = value
    return
  }

  let start = 0
  while (
    start < current.childCount &&
    start < next.childCount &&
    current.child(start).eq(next.child(start))
  ) start += 1
  let currentEnd = current.childCount
  let nextEnd = next.childCount
  while (
    currentEnd > start &&
    nextEnd > start &&
    current.child(currentEnd - 1).eq(next.child(nextEnd - 1))
  ) {
    currentEnd -= 1
    nextEnd -= 1
  }

  const childOffset = (doc: typeof current, index: number) => {
    let pos = 0
    for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize
    return pos
  }
  const from = childOffset(current, start)
  const to = childOffset(current, currentEnd)
  const replacement = next.content.cut(childOffset(next, start), childOffset(next, nextEnd))

  lastEmitted = value
  view.dispatch(view.state.tr.replaceWith(from, to, replacement))
})

onMounted(mount)
onBeforeUnmount(() => {
  view?.dom.removeEventListener('keydown', handleKeydown)
  view?.dom.removeEventListener('paste', handlePaste)
  view?.dom.removeEventListener('click', handleClick)
  view?.destroy()
  view = null
})

// ---------------------------------------------------------------------------
// MarkdownDocumentEditorHandle

function currentDraft(): string {
  return view ? noteEditorMarkdown(view) : props.modelValue
}

function focus(): void {
  view?.focus()
}

function blur(): void {
  (view?.dom as HTMLElement | undefined)?.blur()
}

function getValue(): string {
  return currentDraft()
}

function setValue(value: string): void {
  if (!view) return
  const doc = parseNoteMarkdown(value)
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content)
  lastEmitted = value
  view.dispatch(tr)
  emit('update:modelValue', noteEditorMarkdown(view))
}

function getSelection(): HandleSelection {
  if (!view) return { from: 0, to: 0 }
  const draft = currentDraft()
  lastSelectionReport = pmRangeToDraftRange(view.state.doc, draft, view.state.selection.from, view.state.selection.to)
  return { ...lastSelectionReport }
}

function getSelectedText(): string {
  if (!view) return ''
  const { from, to } = view.state.selection
  return view.state.doc.textBetween(from, to, '\n')
}

function setSelection(from: number, to?: number): void {
  if (!view) return
  const end = to ?? from
  const draft = currentDraft()
  if (from >= draft.replace(/\s+$/, '').length) {
    view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)).scrollIntoView())
    view.focus()
    return
  }
  const mapped = draftRangeToPmRange(view.state.doc, draft, from, end)
  if (!mapped) return
  view.dispatch(view.state.tr.setSelection(
    TextSelection.create(view.state.doc, mapped.from, mapped.to),
  ).scrollIntoView())
  view.focus()
}

function replaceRange(from: number, to: number, text: string): void {
  if (!view) return
  const fragment = parseNoteMarkdown(text)
  const isCurrentSelection = from === lastSelectionReport.from && to === lastSelectionReport.to
  let range = isCurrentSelection
    ? { from: view.state.selection.from, to: view.state.selection.to }
    : draftRangeToPmRange(view.state.doc, currentDraft(), from, to)
  if (!range) range = { from: view.state.selection.from, to: view.state.selection.to }
  // Single-paragraph insert stays inline; multi-block replaces the range.
  const single = fragment.childCount === 1 && fragment.firstChild?.type.name === 'paragraph'
  const tr = single && fragment.firstChild
    ? view.state.tr.replaceWith(range.from, range.to, fragment.firstChild.content)
    : view.state.tr.replaceWith(range.from, range.to, fragment.content)
  view.dispatch(tr.scrollIntoView())
  emitChanged()
}

function emitChanged(): void {
  if (!view) return
  lastEmitted = noteEditorMarkdown(view)
  emit('update:modelValue', lastEmitted)
}

function scrollToTop(): void {
  if (hostRef.value) hostRef.value.querySelector('.pm-note-editor')?.scrollTo({ top: 0 })
}

function getScrollTop(): number {
  return (hostRef.value?.querySelector('.pm-note-editor') as HTMLElement | null)?.scrollTop ?? 0
}

function setScrollTop(scrollTop: number): void {
  const scroller = hostRef.value?.querySelector('.pm-note-editor') as HTMLElement | null
  if (scroller) scroller.scrollTop = scrollTop
}

function getCursorLineInfo() {
  if (!view) return { lineNumber: 1, totalLines: 1, from: 0, to: 0, text: '' }
  const { $from } = view.state.selection
  let index = 0
  let total = 0
  view.state.doc.forEach((_, __, i) => { total = i + 1 })
  index = $from.index(0) + 1
  const parent = $from.parent
  return {
    lineNumber: index,
    totalLines: Math.max(total, 1),
    from: $from.start(),
    to: $from.end(),
    text: parent.textContent,
  }
}

function applyCommand(command: MarkdownCommand): void {
  if (!view) return
  applyNoteCommand(view, command)
  view.focus()
}

const sourceMode = ref(false)

function setSourceMode(): void {
  // Source mode is not part of the render-first engine (the CodeMirror
  // engine remains available via settings for source-level editing).
  sourceMode.value = false
}

function toggleSourceMode(): void {
  setSourceMode()
}

function getSourceMode(): boolean {
  return sourceMode.value
}

defineExpose<MarkdownDocumentEditorHandle>({
  focus,
  blur,
  getValue,
  setValue,
  getSelectedText,
  getSelection,
  setSelection,
  replaceRange,
  scrollToTop,
  getScrollTop,
  setScrollTop,
  getCursorLineInfo,
  applyCommand,
  setSourceMode,
  toggleSourceMode,
  getSourceMode,
})
</script>

<style scoped>
.prose-note-editor {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.prose-note-editor :deep(.pm-note-editor) {
  flex: 1 1 auto;
  min-height: 0;
}
</style>

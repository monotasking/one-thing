<template>
  <div
    ref="hostRef"
    class="text-editor"
    :class="`profile-${profile}`"
    :style="editorStyle"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import {
  buildEditorExtensions,
  completionExtensions,
  createEditorCompartments,
  languageExtensions,
  markdownLivePreviewExtension,
  normalizeEditorSettings,
  placeholderExtensions,
  readOnlyExtensions,
  selectionExtensions,
  tabSizeExtensions,
  themeExtension,
  wrappingExtension,
} from './extensions'
import { promptCardExtension, type MemberRefData } from './prompt-cards'
import type {
  MarkdownLivePreviewFeatures,
  MarkdownLivePreviewOptions,
} from './markdown-live-preview'
import type {
  EditorCursorLineInfo,
  EditorHandle,
  EditorLanguage,
  EditorProfile,
  EditorSelection,
  EditorSettings,
  EditorTransaction,
  EditorSetValueOptions,
  EditorVisualLineEdges,
} from './types'
import type { SkillDefinition, UserPrompt } from '@shared/ipc'
import type { CommandDefinition } from '@/types/commands'
import { platformApi } from '@/platform'
import { markdownApi } from '@/platform/markdown-client'

interface MarkdownAssetContext {
  documentPath?: string
  workspaceRoot?: string
}

interface Props {
  modelValue: string
  profile?: EditorProfile
  language?: EditorLanguage
  path?: string
  placeholder?: string
  readOnly?: boolean
  minHeight?: number
  maxHeight?: number
  spellcheck?: boolean
  markdownLivePreview?: boolean
  markdownLivePreviewFeatures?: MarkdownLivePreviewFeatures
  settings?: EditorSettings
  selectOnFocus?: boolean
  promptRefs?: UserPrompt[]
  skillRefs?: SkillDefinition[]
  commandRefs?: CommandDefinition[]
  /** Collab room roster, so `{{member:<agentId>}}` tokens paint as @名字 (W14a). */
  memberRefs?: MemberRefData[]
  markdownAssetContext?: MarkdownAssetContext
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  profile: 'composer',
  language: 'plain',
  path: '',
  placeholder: '',
  readOnly: false,
  minHeight: 24,
  maxHeight: 200,
  spellcheck: true,
  markdownLivePreview: false,
  markdownLivePreviewFeatures: undefined,
  settings: undefined,
  selectOnFocus: false,
  promptRefs: () => [],
  skillRefs: () => [],
  commandRefs: () => [],
  memberRefs: () => [],
  markdownAssetContext: undefined,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  focus: []
  blur: []
  submit: []
  cancel: []
  heightChange: [height: number]
  selectionChange: [selection: EditorSelection]
  transaction: [payload: EditorTransaction]
  keydown: [event: KeyboardEvent]
  paste: [event: ClipboardEvent]
  compositionstart: []
  compositionend: []
}>()

const hostRef = ref<HTMLElement | null>(null)
let view: EditorView | null = null
let resizeObserver: ResizeObserver | null = null
let internalUpdate = false
let editorUpdateInProgress = false
let editorUpdateSettledScheduled = false
let heightFrame: number | null = null
const deferredEditorWork: Array<() => void> = []
const compartments = createEditorCompartments()

const effectiveSettings = computed(() => normalizeEditorSettings(props.settings))
const markdownLivePreviewOptions = computed<MarkdownLivePreviewOptions>(() => ({
  features: props.markdownLivePreviewFeatures,
  resolveAsset: async (rawTarget) => {
    const documentPath = props.markdownAssetContext?.documentPath
    if (!documentPath) return null
    const response = await markdownApi.resolveAsset({
      documentPath,
      workspaceRoot: props.markdownAssetContext?.workspaceRoot,
      rawTarget,
    })
    return response.success ? response.asset : { kind: 'missing', rawTarget, error: response.error }
  },
}))

const editorStyle = computed(() => ({
  '--editor-min-height': `${props.minHeight}px`,
  '--editor-max-height': `${props.maxHeight}px`,
  '--editor-soft-wrap-width': `${effectiveSettings.value.softWrapColumn}ch`,
}))

function createView() {
  if (!hostRef.value) return
  const state = EditorState.create({
    doc: props.modelValue,
    extensions: createExtensions(),
  })
  view = new EditorView({
    state,
    parent: hostRef.value,
  })
  view.contentDOM.setAttribute('spellcheck', props.spellcheck ? 'true' : 'false')
  scheduleHeightChange()
}

function createExtensions() {
  return buildEditorExtensions({
    profile: props.profile,
    language: props.language,
    path: props.path,
    placeholder: props.placeholder,
    readOnly: props.readOnly,
    spellcheck: props.spellcheck,
    markdownLivePreview: props.markdownLivePreview,
    markdownLivePreviewOptions: markdownLivePreviewOptions.value,
    promptCards: promptCardExtension({
      prompts: props.promptRefs,
      skills: props.skillRefs,
      commands: props.commandRefs,
      members: props.memberRefs,
    }),
    settings: effectiveSettings.value,
    compartments,
    onTransaction: handleViewUpdate,
    onHeightChange: scheduleHeightChange,
    onFocus: () => {
      emit('focus')
      if (props.selectOnFocus) {
        nextTick(() => setSelection(0, getValue().length))
      }
    },
    onBlur: () => emit('blur'),
    onKeydown: (event) => {
      emit('keydown', event)
      if (event.defaultPrevented) return
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        emit('submit')
      }
      if (event.key === 'Escape') emit('cancel')
    },
    onPaste: (event) => {
      emit('paste', event)
    },
    onCompositionStart: () => {
      emit('compositionstart')
    },
    onCompositionEnd: () => {
      emit('compositionend')
    },
  })
}

function handleViewUpdate(update: ViewUpdate) {
  editorUpdateInProgress = true
  try {
    const selection = selectionFromState(update.state)
    const value = update.state.doc.toString()

    if (update.docChanged) {
      internalUpdate = true
      emit('update:modelValue', value)
      nextTick(() => {
        internalUpdate = false
      })
    }

    if (update.selectionSet) {
      emit('selectionChange', selection)
    }

    if (update.docChanged || update.selectionSet) {
      emit('transaction', {
        value,
        selection,
        docChanged: update.docChanged,
        selectionChanged: update.selectionSet,
      })
    }
  } finally {
    scheduleEditorUpdateSettled()
  }
}

function reconfigureView() {
  runEditorWork(() => {
    if (!view) return
    const settings = effectiveSettings.value
    view.dispatch({
      effects: [
        compartments.tabSize.reconfigure(tabSizeExtensions(settings.tabSize)),
        compartments.readOnly.reconfigure(readOnlyExtensions(props.readOnly)),
        compartments.theme.reconfigure(themeExtension(props.profile, props.spellcheck)),
        compartments.selection.reconfigure(selectionExtensions(props.markdownLivePreview)),
        compartments.wrapping.reconfigure(wrappingExtension(settings.lineWrapping)),
        compartments.placeholder.reconfigure(placeholderExtensions(props.placeholder)),
        compartments.language.reconfigure(languageExtensions(settings, props.language, props.path)),
        compartments.completion.reconfigure(completionExtensions(settings.completionEnabled)),
        compartments.markdownLivePreview.reconfigure(markdownLivePreviewExtension(
          props.markdownLivePreview,
          markdownLivePreviewOptions.value,
        )),
        compartments.promptCards.reconfigure(promptCardExtension({
          prompts: props.promptRefs,
          skills: props.skillRefs,
          commands: props.commandRefs,
          members: props.memberRefs,
        })),
      ],
    })
    view.contentDOM.setAttribute('spellcheck', props.spellcheck ? 'true' : 'false')
    scheduleHeightChange()
  })
}

function getValue(): string {
  return view?.state.doc.toString() ?? props.modelValue
}

function getSelectedText(): string {
  if (!view) return ''
  const selection = view.state.selection.main
  if (selection.empty) return ''
  return view.state.sliceDoc(selection.from, selection.to)
}

function setValue(value: string, options: EditorSetValueOptions = {}) {
  runEditorWork(() => {
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    const selection = getSelection()
    const scrollTop = view.scrollDOM.scrollTop
    const nextSelection = options.preserveSelection
      ? {
          anchor: Math.min(selection.from, value.length),
          head: Math.min(selection.to, value.length),
        }
      : { anchor: value.length }
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: nextSelection,
    })
    if (options.preserveSelection) {
      view.scrollDOM.scrollTop = scrollTop
    }
  })
}

function getSelection(): EditorSelection {
  return view ? selectionFromState(view.state) : { from: 0, to: 0 }
}

function setSelection(from: number, to = from) {
  runEditorWork(() => {
    if (!view) return
    const length = view.state.doc.length
    const safeFrom = Math.max(0, Math.min(from, length))
    const safeTo = Math.max(0, Math.min(to, length))
    view.dispatch({
      selection: { anchor: safeFrom, head: safeTo },
      scrollIntoView: true,
    })
  })
}

function replaceRange(from: number, to: number, text: string) {
  runEditorWork(() => {
    if (!view) return
    const length = view.state.doc.length
    const safeFrom = Math.max(0, Math.min(from, length))
    const safeTo = Math.max(safeFrom, Math.min(to, length))
    view.dispatch({
      changes: { from: safeFrom, to: safeTo, insert: text },
      selection: { anchor: safeFrom + text.length },
      scrollIntoView: true,
    })
  })
}

function runEditorWork(work: () => void) {
  if (!editorUpdateInProgress) {
    try {
      work()
    } catch (error) {
      if (isEditorUpdateInProgressError(error)) {
        deferEditorWork(work)
        return
      }
      throw error
    }
    return
  }
  deferEditorWork(work)
}

function deferEditorWork(work: () => void) {
  deferredEditorWork.push(work)
  scheduleEditorUpdateSettled()
}

function scheduleEditorUpdateSettled() {
  if (editorUpdateSettledScheduled) return
  editorUpdateSettledScheduled = true
  queueMicrotask(() => {
    editorUpdateSettledScheduled = false
    editorUpdateInProgress = false
    flushDeferredEditorWork()
  })
}

function flushDeferredEditorWork() {
  while (deferredEditorWork.length > 0 && !editorUpdateInProgress) {
    const work = deferredEditorWork.shift()
    if (!work) continue
    try {
      work()
    } catch (error) {
      if (isEditorUpdateInProgressError(error)) {
        deferEditorWork(work)
        break
      }
      throw error
    }
  }
  if (deferredEditorWork.length > 0) {
    scheduleEditorUpdateSettled()
  }
}

function isEditorUpdateInProgressError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('Calls to EditorView.update are not allowed while an update is in progress')
}

function scrollToTop() {
  if (!view) return
  view.scrollDOM.scrollTop = 0
}

function getScrollTop(): number {
  return view?.scrollDOM.scrollTop ?? 0
}

function setScrollTop(scrollTop: number) {
  if (!view) return
  view.scrollDOM.scrollTop = Math.max(0, scrollTop)
}

function getCursorLineInfo(): EditorCursorLineInfo {
  if (!view) {
    return {
      lineNumber: 1,
      totalLines: 1,
      from: 0,
      to: 0,
      text: '',
    }
  }
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  return {
    lineNumber: line.number,
    totalLines: view.state.doc.lines,
    from: line.from,
    to: line.to,
    text: line.text,
  }
}

/**
 * 首/末视觉行判定：拿光标与文档首尾的屏幕坐标比行高。软换行时一条逻辑行会占
 * 多个视觉行，只数 `\n` 会把折行中段误判成第一行（历史记录因此会吃掉草稿）。
 * jsdom / 未挂载 / 隐藏时拿不到坐标，退回逻辑行判断。
 */
function getVisualLineEdges(): EditorVisualLineEdges {
  if (!view) return { atFirstLine: true, atLastLine: true }

  const doc = view.state.doc
  const head = view.state.selection.main.head
  const cursor = view.coordsAtPos(head)
  const docStart = view.coordsAtPos(0)
  const docEnd = view.coordsAtPos(doc.length)

  if (!cursor || !docStart || !docEnd) {
    const value = doc.toString()
    const before = value.slice(0, head)
    const after = value.slice(head)
    return { atFirstLine: !before.includes('\n'), atLastLine: !after.includes('\n') }
  }

  // 半行的容差：坐标是浮点，且行内可能混着不同字号的装饰。
  const tolerance = Math.max(1, (cursor.bottom - cursor.top) / 2)
  return {
    atFirstLine: cursor.top <= docStart.top + tolerance,
    atLastLine: cursor.bottom >= docEnd.bottom - tolerance,
  }
}

function selectionFromState(state: EditorState): EditorSelection {
  const selection = state.selection.main
  return { from: selection.from, to: selection.to }
}

function focus() {
  view?.focus()
}

function blur() {
  view?.contentDOM.blur()
}

function scheduleHeightChange() {
  if (heightFrame !== null) return
  heightFrame = requestAnimationFrame(() => {
    heightFrame = null
    const height = view?.dom.getBoundingClientRect().height ?? 0
    emit('heightChange', height)
  })
}

onMounted(() => {
  createView()
  if (hostRef.value) {
    resizeObserver = new ResizeObserver(scheduleHeightChange)
    resizeObserver.observe(hostRef.value)
  }
})

onBeforeUnmount(() => {
  if (heightFrame !== null) {
    cancelAnimationFrame(heightFrame)
    heightFrame = null
  }
  resizeObserver?.disconnect()
  resizeObserver = null
  deferredEditorWork.length = 0
  editorUpdateInProgress = false
  view?.destroy()
  view = null
})

watch(
  () => props.modelValue,
  (value) => {
    if (internalUpdate || getValue() === value) return
    setValue(value, { preserveSelection: true })
  }
)

watch(
  () => [
    props.profile,
    props.language,
    props.path,
    props.placeholder,
    props.readOnly,
    props.spellcheck,
    props.markdownLivePreview,
    props.markdownLivePreviewFeatures,
    props.promptRefs,
    props.skillRefs,
    props.commandRefs,
    props.memberRefs,
    props.markdownAssetContext?.documentPath,
    props.markdownAssetContext?.workspaceRoot,
    effectiveSettings.value.tabSize,
    effectiveSettings.value.lineWrapping,
    effectiveSettings.value.softWrapColumn,
    effectiveSettings.value.syntaxHighlighting,
    effectiveSettings.value.completionEnabled,
  ],
  () => reconfigureView()
)

defineExpose<EditorHandle>({
  focus,
  blur,
  getValue,
  getSelectedText,
  setValue,
  getSelection,
  setSelection,
  replaceRange,
  scrollToTop,
  getScrollTop,
  setScrollTop,
  getCursorLineInfo,
  getVisualLineEdges,
})
</script>

<style scoped>
.text-editor {
  width: 100%;
  min-height: var(--editor-min-height);
}

.text-editor :deep(.cm-editor) {
  width: 100%;
}

.text-editor.profile-markdown-document {
  height: 100%;
  min-height: 0;
}

.text-editor.profile-markdown-document :deep(.cm-editor),
.text-editor.profile-markdown-document :deep(.cm-scroller) {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.text-editor.profile-markdown-document :deep(.cm-scroller) {
  max-height: none;
  overflow: auto;
}

.profile-composer {
  --editor-text: var(--ui-editor-text-fg);
}

.profile-inline-message,
.profile-markdown-document,
.profile-code-file {
  --editor-text: var(--ui-text-primary-fg);
}
</style>

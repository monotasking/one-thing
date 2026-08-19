<template>
  <div
    ref="containerRef"
    class="monaco-editor-host"
  />
</template>

<script setup lang="ts">
import './monaco-setup'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as monaco from 'monaco-editor'
import type { EditorSettings } from './types'

const props = defineProps<{
  model: monaco.editor.ITextModel | null
  viewState?: monaco.editor.ICodeEditorViewState | null
  readOnly?: boolean
  settings?: EditorSettings
}>()

const emit = defineEmits<{
  change: [value: string]
  cursorChange: [line: number, column: number]
  viewStateChange: [state: monaco.editor.ICodeEditorViewState | null]
  markersChange: [markers: monaco.editor.IMarker[]]
}>()

const containerRef = ref<HTMLElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let resizeObserver: ResizeObserver | null = null
let modelChangeDisposable: monaco.IDisposable | null = null
let cursorDisposable: monaco.IDisposable | null = null
let markersDisposable: monaco.IDisposable | null = null
let disposed = false
let modelWatchVersion = 0

function isCanceledError(error: unknown): boolean {
  return error instanceof Error && error.name === 'Canceled'
}

function bindModelListeners() {
  modelChangeDisposable?.dispose()
  cursorDisposable?.dispose()
  modelChangeDisposable = editor?.onDidChangeModelContent(() => {
    emit('change', editor?.getValue() ?? '')
    emit('viewStateChange', editor?.saveViewState() ?? null)
  }) ?? null
  cursorDisposable = editor?.onDidChangeCursorPosition((event) => {
    emit('cursorChange', event.position.lineNumber, event.position.column)
    emit('viewStateChange', editor?.saveViewState() ?? null)
  }) ?? null
}

function createEditor() {
  if (!containerRef.value || editor) return
  disposed = false
  editor = monaco.editor.create(containerRef.value, {
    model: props.model,
    automaticLayout: true,
    readOnly: !!props.readOnly,
    minimap: { enabled: false },
    fontSize: 13,
    lineHeight: 20,
    wordWrap: props.settings?.lineWrapping === false ? 'off' : 'wordWrapColumn',
    wordWrapColumn: props.settings?.softWrapColumn ?? 88,
    scrollBeyondLastLine: false,
    theme: document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
  })
  restoreViewStateSafely(editor, props.viewState)
  bindModelListeners()
  markersDisposable = monaco.editor.onDidChangeMarkers((uris) => {
    const model = editor?.getModel()
    if (model && uris.some(uri => uri.toString() === model.uri.toString())) {
      emit('markersChange', monaco.editor.getModelMarkers({ resource: model.uri }))
    }
  })
  resizeObserver = new ResizeObserver(() => editor?.layout())
  resizeObserver.observe(containerRef.value)
}

function focus() {
  editor?.focus()
}

function layout() {
  editor?.layout()
}

function revealLine(lineNumber: number) {
  editor?.revealLineInCenter(lineNumber)
}

/**
 * 定位到某一行(消息引用 `path:12` / `:12-30` / `:12:5` 的落点)。
 * 与 `revealLine` 分开是因为这条**要动光标**:引用点过去人是要在那儿接着编辑的,
 * 只滚过去不落光标,下一次按键会跳回原处。
 */
function revealPosition(lineNumber: number, column = 1, endLineNumber?: number) {
  if (!editor) return
  editor.setPosition({ lineNumber, column })
  if (endLineNumber && endLineNumber > lineNumber) {
    const model = editor.getModel()
    editor.setSelection({
      startLineNumber: lineNumber,
      startColumn: column,
      endLineNumber,
      endColumn: model?.getLineMaxColumn(endLineNumber) ?? 1,
    })
  }
  editor.revealLineInCenter(lineNumber)
}

function openFind() {
  editor?.getAction('actions.find')?.run()
}

function saveViewState() {
  return editor?.saveViewState() ?? null
}

function restoreViewStateSafely(
  targetEditor: monaco.editor.IStandaloneCodeEditor,
  viewState: monaco.editor.ICodeEditorViewState | null | undefined,
) {
  if (!viewState || disposed) return
  try {
    targetEditor.restoreViewState(viewState)
  } catch (error) {
    if (!isCanceledError(error)) throw error
  }
}

onMounted(() => {
  createEditor()
})

onBeforeUnmount(() => {
  disposed = true
  modelWatchVersion++
  emit('viewStateChange', editor?.saveViewState() ?? null)
  modelChangeDisposable?.dispose()
  cursorDisposable?.dispose()
  markersDisposable?.dispose()
  resizeObserver?.disconnect()
  editor?.dispose()
  editor = null
})

watch(() => props.model, async (model) => {
  const targetEditor = editor
  if (!targetEditor || disposed) return
  const version = ++modelWatchVersion
  targetEditor.setModel(model)
  await nextTick()
  if (disposed || version !== modelWatchVersion) return
  restoreViewStateSafely(targetEditor, props.viewState)
  bindModelListeners()
  emit('markersChange', model ? monaco.editor.getModelMarkers({ resource: model.uri }) : [])
})

watch(() => props.readOnly, (readOnly) => {
  editor?.updateOptions({ readOnly: !!readOnly })
})

watch(
  () => [props.settings?.lineWrapping, props.settings?.softWrapColumn],
  () => {
    editor?.updateOptions({
      wordWrap: props.settings?.lineWrapping === false ? 'off' : 'wordWrapColumn',
      wordWrapColumn: props.settings?.softWrapColumn ?? 88,
    })
  }
)

defineExpose({
  focus,
  layout,
  revealLine,
  revealPosition,
  openFind,
  saveViewState,
})
</script>

<style scoped>
/*
 * `isolation: isolate` is load-bearing, not cosmetic.
 *
 * Monaco ships its own z-index ladder and the top of it is above ours:
 * `.monaco-editor .overlayWidgets` sits at 10000 and `.quick-input-widget` at
 * 2550, while `--z-max` is 9999 and `--z-modal` is 600. In a shared stacking
 * context the editor's find bar / peek / quick-input therefore paint OVER any
 * Dialog, Toast or image preview the app raises — a library's private ladder
 * silently outranking the app's public one.
 *
 * Raising `--z-max` would be answering an arms race with a bigger number. The
 * fix is to change what the numbers are measured against: this element becomes
 * a stacking context, so every z-index Monaco writes inside it is resolved
 * against THIS box and the whole subtree participates in the page as one layer
 * at the host's own level. 10000 stays 10000 — it just cannot leave the room.
 * (docs/design/ui-system.md §3, "第三方库自带 z 用 isolation 收监".)
 *
 * `isolation` rather than `z-index: 0` / `transform`: it creates the stacking
 * context and nothing else — no layout effect, no paint containment, so
 * overflowing widgets (suggest, hover) still spill out of the box as before.
 */
.monaco-editor-host {
  width: 100%;
  height: 100%;
  min-height: 0;
  isolation: isolate;
}
</style>

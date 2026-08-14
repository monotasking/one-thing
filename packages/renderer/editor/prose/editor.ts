import { history } from 'prosemirror-history'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { EditorState, type Plugin } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { columnResizing, tableEditing } from 'prosemirror-tables'
import { noteInputRules } from './input-rules'
import { noteKeymaps } from './keymap'
import { parseNoteMarkdown, serializeNoteMarkdown } from './markdown-io'
import { noteSchema } from './schema'
import { noteNodeViews, type NoteNodeViewOptions } from './node-views'

export interface NoteEditorOptions extends NoteNodeViewOptions {
  markdown: string
  parent: HTMLElement
  editable?: () => boolean
  onDocChanged?: (view: EditorView) => void
  /**
   * 追加插件 —— 它们排在 `noteKeymaps()` **之后**。
   *
   * 由此换来的一条经验值得留在原位:想抢在回车被 `splitListItem` / `baseKeymap`
   * 吃掉之前看到它,插件里的 `props.handleKeyDown` 是来不及的 ——
   * `EditorView.someProp` 先查 view 自己的 props、再查插件,所以那类需求只能落在
   * view 的直接 prop 上,而不是这里。
   */
  extraPlugins?: Plugin[]
}

export function createNoteEditorState(markdown: string, extraPlugins: Plugin[] = []): EditorState {
  return EditorState.create({
    doc: parseNoteMarkdown(markdown),
    plugins: [
      noteInputRules(),
      ...noteKeymaps(),
      history(),
      dropCursor(),
      gapCursor(),
      columnResizing(),
      tableEditing(),
      ...extraPlugins,
    ],
  })
}

export function createNoteEditorView(options: NoteEditorOptions): EditorView {
  const view: EditorView = new EditorView(options.parent, {
    state: createNoteEditorState(options.markdown, options.extraPlugins),
    editable: options.editable ?? (() => true),
    nodeViews: noteNodeViews(options),
    attributes: {
      class: 'pm-note-editor',
      spellcheck: 'true',
    },
    dispatchTransaction(transaction) {
      const newState = view.state.apply(transaction)
      view.updateState(newState)
      if (transaction.docChanged) options.onDocChanged?.(view)
    },
  })
  return view
}

export function noteEditorMarkdown(view: EditorView): string {
  return serializeNoteMarkdown(view.state.doc)
}

export { noteSchema, parseNoteMarkdown, serializeNoteMarkdown }

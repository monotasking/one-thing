/**
 * 「光标所在的那个顶层块」装饰。
 *
 * 为什么需要它:块级 hover 的底色条件是 `hovered && drag === null && !editing` ——
 * **正在编辑的那一块不许有 hover 底**。点进一段之后底色还挂着,是「这块被选中了」
 * 和「鼠标正指着这块」两种意思打架:光标已经是最强的位置提示,再叠一层灰底只会让
 * 人以为自己还没进去。CSS 认不出光标在哪,所以这里给那一块打个类,由 CSS 排除。
 *
 * 粒度是**顶层块** —— 和 hover 的粒度(`.tiptap-note-surface > *`)必须是同一层,
 * 否则「点进列表里的某一项」会排除掉整份列表、或者一项都排除不掉。
 *
 * 装饰整份重算而不是 `DecorationSet.map`:光标位置每一跳都变,map 出来的旧位置没有
 * 任何复用价值,重算反而更短。IME 组字期间不会闪 —— 组字全程光标都在同一个顶层块里,
 * 算出来的还是那一块,类名一次都不变。
 */
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorState } from 'prosemirror-state'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

export const CARET_BLOCK_CLASS = 'is-caret-block'

export const caretBlockKey = new PluginKey<DecorationSet>('noteCaretBlock')

export interface CaretTopLevelBlock {
  /** 顶层块在 doc 里的起始位置(节点前一位)。 */
  pos: number
  node: PMNode
}

/**
 * selection head 落在哪个顶层块里。`null` = 没有(空文档 / 位置解析不出来)。
 *
 * 取 head 而不是 anchor:拖选时人正在动的那一端是 head,那一端所在的块才是「在编辑」
 * 的那一块。`depth === 0` 是整块被选中(NodeSelection)的情形 —— 这时位置直接就是
 * 顶层块的起点,不能再往上找一层。
 */
export function resolveCaretTopLevelBlock(state: EditorState): CaretTopLevelBlock | null {
  const { $head, from } = state.selection
  if ($head.depth === 0) {
    const node = state.doc.nodeAt(from)
    return node ? { pos: from, node } : null
  }
  const pos = $head.before(1)
  const node = state.doc.nodeAt(pos)
  return node ? { pos, node } : null
}

/** 由 state 直接算出装饰集。摘出来是为了能单独测「selection → 装饰」这一步。 */
export function buildCaretBlockDecorations(state: EditorState): DecorationSet {
  const block = resolveCaretTopLevelBlock(state)
  if (!block) return DecorationSet.empty
  return DecorationSet.create(state.doc, [
    Decoration.node(block.pos, block.pos + block.node.nodeSize, { class: CARET_BLOCK_CLASS }),
  ])
}

export function caretBlockPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: caretBlockKey,
    state: {
      init: (_config, state) => buildCaretBlockDecorations(state),
      // 文档没变、选区也没变的事务(比如水位线那条空事务)不必重算。
      apply: (tr, value, _oldState, newState) => {
        if (!tr.docChanged && !tr.selectionSet) return value
        return buildCaretBlockDecorations(newState)
      },
    },
    props: {
      decorations: state => caretBlockKey.getState(state) ?? DecorationSet.empty,
    },
  })
}

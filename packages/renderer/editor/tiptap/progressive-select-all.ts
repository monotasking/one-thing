/**
 * 渐进式 ⌘A(Notion / JetBrains 的行为)。
 *
 * 第一次:选中**光标所在那一块**的内容(段落 / 代码块 / 列表项里的那一行);
 * 再按:向上扩一层(列表项 → 整个列表 → …);已经罩住全文就停在全选。
 * 一步到"整篇全选"的默认行为对一张越写越长的纸太粗——想复制的往往就是手边这一块。
 *
 * 纯函数 `progressiveSelectRange` 单独可测:给定文档与当前选区,返回下一档范围;
 * 没有更大的一档(已是全选)返回 null。
 */
import { Extension } from '@tiptap/core'
// 与 consumed-watermark 同口径:直接用 prosemirror-*(package.json 里留着的那三枚)。
import { AllSelection, TextSelection, type Selection } from 'prosemirror-state'
import type { Node as ProseMirrorNode } from 'prosemirror-model'

export interface SelectRange {
  from: number
  to: number
}

export function progressiveSelectRange(doc: ProseMirrorNode, selection: Selection): SelectRange | null {
  const { $from, from, to } = selection
  // 候选梯子:从光标处最内层的块内容,一层层到共同祖先,最后是整篇。
  // 跨块选区从两端的共同深度起算 —— 已选的范围只会被"更大的一档"取代。
  const sharedDepth = $from.sharedDepth(to)

  for (let depth = sharedDepth; depth > 0; depth--) {
    const raw: SelectRange = { from: $from.start(depth), to: $from.end(depth) }
    // 先按 TextSelection 的规则钳回文本位置再比大小:结构范围(比如只有一个
    // 段落的列表项)钳完可能和当前选区一模一样 —— 那一档是空梯级,继续向上,
    // 否则梯子会在原地卡死(实测)。
    const clamped = clampToText(doc, raw)
    const covers = clamped.from <= from && clamped.to >= to
    const strictlyLarger = clamped.from < from || clamped.to > to
    if (covers && strictlyLarger) return clamped
  }

  // 最后一档是整篇(AllSelection 语义,不钳):还没罩满就升到全选。
  if (from > 0 || to < doc.content.size) return { from: 0, to: doc.content.size }
  return null
}

function clampToText(doc: ProseMirrorNode, range: SelectRange): SelectRange {
  try {
    const clamped = TextSelection.between(doc.resolve(range.from), doc.resolve(range.to))
    return { from: clamped.from, to: clamped.to }
  } catch {
    return range
  }
}

export const ProgressiveSelectAll = Extension.create({
  name: 'progressiveSelectAll',
  // 要抢在 StarterKit 基础 keymap 的 Mod-a(一步全选)之前。
  priority: 200,

  addKeyboardShortcuts() {
    return {
      'Mod-a': () => {
        const { state } = this.editor
        const next = progressiveSelectRange(state.doc, state.selection)
        if (!next) return true // 已是全选:吃掉按键,别让浏览器把选区扩出编辑器
        const isWholeDoc = next.from === 0 && next.to === state.doc.content.size
        // 走命令链而不是手工 view.dispatch:快捷键处理器跑在命令上下文里,
        // 旁路 dispatch 的选区会被外层命令收尾时盖回去(实测)。
        return this.editor.commands.command(({ tr, dispatch }) => {
          if (dispatch) {
            tr.setSelection(
              isWholeDoc
                ? new AllSelection(tr.doc)
                : TextSelection.between(tr.doc.resolve(next.from), tr.doc.resolve(next.to)),
            ).scrollIntoView()
          }
          return true
        })
      },
    }
  },
})

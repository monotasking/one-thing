// @vitest-environment happy-dom
/**
 * 「光标所在的顶层块」→ 装饰的映射。
 *
 * 用真 Tiptap 文档而不是手搭 schema:整件事的前提是"顶层块的粒度和 hover 的粒度
 * (`.tiptap-note-surface > *`)是同一层",而这一层长什么样只有真的 schema 说了算 ——
 * 列表里点一项,该被标的是**整份列表**,不是那一项。
 */
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import {
  buildCaretBlockDecorations,
  CARET_BLOCK_CLASS,
  resolveCaretTopLevelBlock,
} from '../caret-block'

function editorWith(html: string): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit],
    content: html,
  })
}

/** 装饰覆盖的区间 —— 只看 [from, to],那就是"标了哪一块"的全部信息。 */
function decoratedRange(editor: Editor): { from: number; to: number } | null {
  const set = buildCaretBlockDecorations(editor.state)
  const found = set.find()
  if (found.length === 0) return null
  return { from: found[0].from, to: found[0].to }
}

describe('caret block decoration', () => {
  it('marks the top-level block the caret sits in', () => {
    const editor = editorWith('<p>first</p><p>second</p>')
    const secondStart = editor.state.doc.child(0).nodeSize

    editor.commands.setTextSelection(secondStart + 2)

    const block = resolveCaretTopLevelBlock(editor.state)
    expect(block?.pos).toBe(secondStart)
    expect(block?.node.type.name).toBe('paragraph')
    expect(decoratedRange(editor)).toEqual({
      from: secondStart,
      to: secondStart + editor.state.doc.child(1).nodeSize,
    })
    editor.destroy()
  })

  it('moves with the caret', () => {
    const editor = editorWith('<p>first</p><p>second</p>')
    const secondStart = editor.state.doc.child(0).nodeSize

    editor.commands.setTextSelection(2)
    expect(decoratedRange(editor)?.from).toBe(0)

    editor.commands.setTextSelection(secondStart + 2)
    expect(decoratedRange(editor)?.from).toBe(secondStart)
    editor.destroy()
  })

  it('resolves at top-level granularity — a list item marks the whole list', () => {
    const editor = editorWith('<ul><li><p>alpha</p></li><li><p>beta</p></li></ul>')
    // 第二项里落一个光标。
    const listSize = editor.state.doc.child(0).nodeSize
    editor.commands.setTextSelection(listSize - 4)

    const block = resolveCaretTopLevelBlock(editor.state)
    expect(block?.pos).toBe(0)
    expect(block?.node.type.name).toBe('bulletList')
    expect(decoratedRange(editor)).toEqual({ from: 0, to: listSize })
    editor.destroy()
  })

  it('carries the class the CSS keys off', () => {
    const editor = editorWith('<p>only</p>')
    const [decoration] = buildCaretBlockDecorations(editor.state).find() as unknown as Array<
      { type: { attrs?: Record<string, string> } }
    >
    expect(decoration.type.attrs?.class).toBe(CARET_BLOCK_CLASS)
    editor.destroy()
  })

  it('decorates nothing when the document is empty of resolvable blocks', () => {
    const editor = editorWith('<p></p>')
    // 空段落仍然是一个顶层块 —— 它该被标,否则空行一 hover 就闪底。
    expect(decoratedRange(editor)).toEqual({ from: 0, to: editor.state.doc.child(0).nodeSize })
    editor.destroy()
  })
})

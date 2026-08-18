// @vitest-environment happy-dom
/**
 * 渐进式 ⌘A:第一次选当前块,再按逐级向上,最后全选,再按不越界。
 *
 * 走真编辑器(headless Tiptap)而不是手搓 doc:梯子算的是 `$from.start/end`,
 * 深度关系必须来自真实 schema 的嵌套,不然测试只是在复述实现。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { ProgressiveSelectAll, progressiveSelectRange } from '../progressive-select-all'

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function buildEditor(content: string): Editor {
  editor = new Editor({
    extensions: [StarterKit, ProgressiveSelectAll],
    content,
  })
  return editor
}

function selectionOf(instance: Editor): { from: number, to: number } {
  const { from, to } = instance.state.selection
  return { from, to }
}

function pressSelectAll(instance: Editor): void {
  // 走 PM 的真按键通道(someProp),不用 `commands.keyboardShortcut`:后者把处理器
  // 套进外层命令链,处理器内的选区变更会被外层收尾覆盖(实测)。headless 环境的
  // platform 探测判非 mac,Mod = Ctrl。
  const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true })
  instance.view.someProp('handleKeyDown', handler => handler(instance.view, event))
}

describe('progressive ⌘A', () => {
  it('第一次选当前段落,第二次才是全文', () => {
    const pad = buildEditor('<p>第一段</p><p>第二段</p>')
    pad.commands.setTextSelection(2)

    pressSelectAll(pad)
    const first = selectionOf(pad)
    // 只罩住第一段的内容,没碰第二段。
    expect(pad.state.doc.textBetween(first.from, first.to)).toBe('第一段')

    pressSelectAll(pad)
    const second = selectionOf(pad)
    expect(pad.state.doc.textBetween(second.from, second.to, ' ')).toContain('第二段')
  })

  it('嵌套列表逐级向上,单调变大直到全文', () => {
    const pad = buildEditor('<ul><li><p>甲</p></li><li><p>乙</p></li></ul><p>尾段</p>')
    pad.commands.setTextSelection(3)

    // 一直按到选区不再变化(空梯级会被纯函数跳过,所以档数不固定)。
    const seen: Array<{ from: number, to: number }> = []
    for (let i = 0; i < 8; i++) {
      pressSelectAll(pad)
      const current = selectionOf(pad)
      if (seen.length && current.from === seen[seen.length - 1].from && current.to === seen[seen.length - 1].to) break
      seen.push(current)
    }

    // 每一档都严格大于上一档(单调向上,不跳级回头)。
    expect(seen.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].from).toBeLessThanOrEqual(seen[i - 1].from)
      expect(seen[i].to).toBeGreaterThanOrEqual(seen[i - 1].to)
      const grew = seen[i].from < seen[i - 1].from || seen[i].to > seen[i - 1].to
      expect(grew).toBe(true)
    }
    // 第一档只有「甲」;中间某一档罩住整个列表但不含尾段;最后一档是全文。
    expect(pad.state.doc.textBetween(seen[0].from, seen[0].to)).toBe('甲')
    const middle = seen.slice(1, -1).map(range => pad.state.doc.textBetween(range.from, range.to, ' '))
    expect(middle.some(text => text.includes('乙') && !text.includes('尾段'))).toBe(true)
    const last = seen[seen.length - 1]
    expect(pad.state.doc.textBetween(last.from, last.to, ' ')).toContain('尾段')
  })

  it('代码块里第一次只选代码', () => {
    const pad = buildEditor('<p>正文</p><pre><code>const a = 1</code></pre>')
    // 光标挪进代码块。
    const codePos = (() => {
      let pos = 0
      pad.state.doc.descendants((node, nodePos) => {
        if (node.type.name === 'codeBlock') pos = nodePos + 1
        return true
      })
      return pos
    })()
    pad.commands.setTextSelection(codePos + 2)

    pressSelectAll(pad)
    const first = selectionOf(pad)
    expect(pad.state.doc.textBetween(first.from, first.to)).toBe('const a = 1')

    pressSelectAll(pad)
    expect(pad.state.doc.textBetween(selectionOf(pad).from, selectionOf(pad).to, ' ')).toContain('正文')
  })

  it('已是全选时返回 null(按键被吃掉,不再变化)', () => {
    const pad = buildEditor('<p>唯一</p>')
    pad.commands.selectAll()
    expect(progressiveSelectRange(pad.state.doc, pad.state.selection)).toBeNull()

    const before = selectionOf(pad)
    pressSelectAll(pad)
    expect(selectionOf(pad)).toEqual(before)
  })
})

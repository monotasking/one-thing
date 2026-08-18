// @vitest-environment happy-dom
/**
 * 已读水位线的**换算**。
 *
 * 分两层钉:
 *   · `watermarkBlockIndex` —— 纯算术,块尾偏移表 + 已读偏移 → 画在第几块之后;
 *   · `watermarkBlocks` —— 拿真的 Tiptap 文档量一遍,确认块尾偏移确实是整篇
 *     markdown 的前缀长度(不是估的)。
 *
 * 第二层要真编辑器是有理由的:整件事的前提就是"块尾偏移 == 该块之前的 markdown
 * 长度",这条只有 tiptap-markdown 自己能作证。
 */
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Markdown } from 'tiptap-markdown'
import type { Node as PMNode } from 'prosemirror-model'
import {
  CONSUMED_WATERMARK_LABEL,
  consumedWatermarkKey,
  consumedWatermarkPlugin,
  watermarkBlockIndex,
  watermarkBlocks,
  type ConsumedWatermarkResolution,
} from '../consumed-watermark'

describe('水位线 · 偏移 → 第几块', () => {
  // 三块,块尾分别落在 10 / 25 / 40。
  const ENDS = [10, 25, 40]

  it('落在块边界上:线画在那一块之后', () => {
    expect(watermarkBlockIndex(ENDS, 10)).toBe(0)
    expect(watermarkBlockIndex(ENDS, 25)).toBe(1)
  })

  it('落在块中间:向后取整到该块之后,而不是切进块里', () => {
    expect(watermarkBlockIndex(ENDS, 3)).toBe(0)
    expect(watermarkBlockIndex(ENDS, 18)).toBe(1)
    expect(watermarkBlockIndex(ENDS, 31)).toBe(null) // 最后一块之后没有"之后"
  })

  it('读完全文不画 —— 那句话由头部栏说', () => {
    expect(watermarkBlockIndex(ENDS, 40)).toBe(null)
    expect(watermarkBlockIndex(ENDS, 999)).toBe(null)
  })

  it('没有偏移 / 偏移为 0 / 空文档:一律不画,而不是画在开头', () => {
    expect(watermarkBlockIndex(ENDS, null)).toBe(null)
    expect(watermarkBlockIndex(ENDS, undefined)).toBe(null)
    expect(watermarkBlockIndex(ENDS, 0)).toBe(null)
    expect(watermarkBlockIndex(ENDS, Number.NaN)).toBe(null)
    expect(watermarkBlockIndex([], 5)).toBe(null)
  })

  it('只有一块时永远不画:唯一的块之后就是文末', () => {
    expect(watermarkBlockIndex([40], 5)).toBe(null)
    expect(watermarkBlockIndex([40], 39)).toBe(null)
  })
})

const SAMPLE = ['# 标题', '', '第一段。', '', '- [ ] 一条待办', '', '收尾一段。'].join('\n')

function withEditor<T>(markdown: string, run: (doc: PMNode, serialize: (doc: PMNode) => string, full: string) => T): T {
  const editor = new Editor({
    content: markdown,
    extensions: [
      StarterKit,
      Markdown.configure({ html: false, tightLists: true, bulletListMarker: '-', breaks: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
  })
  const storage = editor.storage as unknown as {
    markdown: { getMarkdown: () => string, serializer: { serialize: (doc: PMNode) => string } }
  }
  const serialize = (doc: PMNode) => storage.markdown.serializer.serialize(doc)
  try {
    return run(editor.state.doc, serialize, storage.markdown.getMarkdown())
  } finally {
    editor.destroy()
  }
}

describe('水位线 · 逐块量偏移', () => {
  it('块尾偏移就是整篇 markdown 的前缀长度,最后一块正好等于全长', () => {
    withEditor(SAMPLE, (doc, serialize, full) => {
      const blocks = watermarkBlocks(doc, serialize)

      expect(blocks.length).toBe(doc.childCount)
      expect(blocks[blocks.length - 1].end).toBe(full.length)
      // 逐块递增,且每一个都真的是前缀。
      for (const block of blocks) {
        expect(serialize(doc.cut(0, block.pos))).toBe(full.slice(0, block.end))
      }
    })
  })

  it('块尾的 pos 落在顶层块之间 —— 装饰挂上去不会切进块里', () => {
    withEditor(SAMPLE, (doc, serialize) => {
      const blocks = watermarkBlocks(doc, serialize)
      let pos = 0
      doc.forEach((child, _offset, index) => {
        pos += child.nodeSize
        expect(blocks[index].pos).toBe(pos)
      })
      expect(blocks[blocks.length - 1].pos).toBe(doc.content.size)
    })
  })

  it('序列化器抛了就没有水位线,而不是把编辑器一起带走', () => {
    withEditor(SAMPLE, (doc) => {
      expect(watermarkBlocks(doc, () => { throw new Error('boom') })).toEqual([])
    })
  })
})

/** 建一个真编辑器,把插件挂上去,返回它与一个改偏移的手柄。 */
function mountWithWatermark(markdown: string, initialOffset: number | null) {
  const editor = new Editor({
    content: markdown,
    extensions: [
      StarterKit,
      Markdown.configure({ html: false, tightLists: true, bulletListMarker: '-', breaks: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
  })
  const storage = editor.storage as unknown as {
    markdown: { serializer: { serialize: (doc: PMNode) => string } }
  }
  let offset = initialOffset
  const resolutions: ConsumedWatermarkResolution[] = []
  editor.registerPlugin(consumedWatermarkPlugin({
    getOffset: () => offset,
    serialize: doc => storage.markdown.serializer.serialize(doc),
    onResolve: resolution => resolutions.push(resolution),
  }))
  return {
    editor,
    resolutions,
    lines: () => editor.view.dom.querySelectorAll('.tiptap-consumed-line'),
    setOffset(next: number | null) {
      offset = next
      editor.view.dispatch(editor.state.tr.setMeta(consumedWatermarkKey, true))
    },
  }
}

describe('水位线 · 真编辑器里的那条线', () => {
  it('挂上就画:一条,带「AI 已读到这里」,落在已读那一块之后', () => {
    // 第二块(段落)的块尾 —— 线该紧跟在那个 <p> 后面。
    const pad = mountWithWatermark(SAMPLE, null)
    const blocks = withEditor(SAMPLE, (doc, serialize) => watermarkBlocks(doc, serialize))
    pad.setOffset(blocks[1].end)

    const lines = pad.lines()
    expect(lines.length).toBe(1)
    expect(lines[0].textContent).toBe(CONSUMED_WATERMARK_LABEL)
    expect(lines[0].previousElementSibling?.tagName).toBe('P')

    pad.editor.destroy()
  })

  it('没偏移 / 读完全文都不画', () => {
    const blocks = withEditor(SAMPLE, (doc, serialize) => watermarkBlocks(doc, serialize))
    const full = blocks[blocks.length - 1].end

    const pad = mountWithWatermark(SAMPLE, null)
    expect(pad.lines().length).toBe(0)

    pad.setOffset(full)
    expect(pad.lines().length).toBe(0)

    pad.setOffset(blocks[0].end)
    expect(pad.lines().length).toBe(1)

    pad.editor.destroy()
  })

  /**
   * 宿主的「AI 读到第 N 段」只能从这里拿:字符偏移 → 块序这条换算要序列化器,
   * 而序列化器只有编辑器内部有。宿主自己数 `\n\n` 会得到另一套数字。
   */
  it('每次重算都把块序回给宿主 —— 不画线的那几种情况也回', () => {
    const blocks = withEditor(SAMPLE, (doc, serialize) => watermarkBlocks(doc, serialize))
    const pad = mountWithWatermark(SAMPLE, null)

    // 没读过:回 null,但块总数是真的。
    expect(pad.resolutions.at(-1)).toEqual({ blockIndex: null, blockCount: blocks.length })

    pad.setOffset(blocks[0].end)
    expect(pad.resolutions.at(-1)?.blockIndex).toBe(0)

    pad.setOffset(blocks[1].end)
    expect(pad.resolutions.at(-1)?.blockIndex).toBe(1)

    // 落在块中间照样归到那一块 —— 与画线用的是同一个换算,不许两处各算各的。
    pad.setOffset(blocks[0].end + 1)
    expect(pad.resolutions.at(-1)?.blockIndex).toBe(1)

    // 读完全文:不画线,也就没有"第 N 段"。
    pad.setOffset(blocks[blocks.length - 1].end)
    expect(pad.resolutions.at(-1)?.blockIndex).toBeNull()

    pad.editor.destroy()
  })

  it('用户继续往后写:线仍停在原来那一块之后,不跟着跑到文末', () => {
    const blocks = withEditor(SAMPLE, (doc, serialize) => watermarkBlocks(doc, serialize))
    const pad = mountWithWatermark(SAMPLE, blocks[0].end)
    expect(pad.lines()[0]?.previousElementSibling?.tagName).toBe('H1')

    pad.editor.commands.setTextSelection(pad.editor.state.doc.content.size)
    pad.editor.commands.insertContent('\n\n又想到一句')

    const lines = pad.lines()
    expect(lines.length).toBe(1)
    expect(lines[0].previousElementSibling?.tagName).toBe('H1')

    pad.editor.destroy()
  })
})

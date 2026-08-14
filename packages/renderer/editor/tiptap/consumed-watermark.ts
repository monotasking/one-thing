/**
 * 编辑器内的「AI 已读到这里」水位线。
 *
 * ## 它换算的是什么
 * 已读位置是一个 **markdown 字符偏移**(`stores/scratchpad.ts` 的
 * `consumedOffset()`:引擎 `scratchpad:consumed` 回推的版本 → 那一版落盘时的
 * 文档长度)。而画线要的是 **ProseMirror 文档位置**。两个坐标系之间没有现成的
 * 换算表(prose 档有 `offset-map.ts`,Tiptap 没有),所以这里自己算 —— 用
 * tiptap-markdown 的序列化器把「前 k 个顶层块」逐个序列化一遍,得到每个块尾在
 * markdown 里的偏移,再拿偏移去查块。
 *
 * ## 精度:块边界,不是字符
 * 落在块中间的偏移**向后取整到该块之后**。理由是诚实而不是省事:
 * `![](…)` / `**粗** / `- [ ]` 这些语法符号在 markdown 里占位、在文档里不占位,
 * 想精确到字符就得逐 mark 反解,任何一处对不上都会把线画到离谱的地方。块边界是
 * 这套存储格式下唯一**恒真**的对齐点。偏移本身也已经是个下界
 * (`min(那一版的长度, 当前长度)`),再多算半块不改变它表达的事:线以上,AI 看过。
 *
 * 全文都读过(`offset >= 全长`)时不画 —— 那句话由头部栏的「AI 已读全部」说,
 * 纸的最后再横一条线只是噪音。查不到块(序列化抛了 / 空文档)一律不画:
 * 宁可不画,也不画在错的地方。
 */
import type { Node as PMNode } from 'prosemirror-model'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

export const CONSUMED_WATERMARK_LABEL = 'AI 已读到这里'

export const consumedWatermarkKey = new PluginKey<DecorationSet>('scratchpadConsumedWatermark')

/**
 * 顶层块太多时直接放弃换算。前缀序列化是 O(块数²) 的,草稿纸不该有几百个块;
 * 真有,那也是"别在打字时卡住"比"画出这条线"更要紧。
 */
const MAX_BLOCKS = 400

/**
 * 块尾偏移表 + 已读偏移 → 线画在第几个块**之后**;`null` = 不画。
 *
 * 纯函数,不碰 DOM 也不碰 ProseMirror —— 这条换算是整件事里唯一会算错的地方,
 * 所以把它单独摘出来钉测试。
 */
export function watermarkBlockIndex(
  blockEnds: readonly number[],
  offset: number | null | undefined,
): number | null {
  if (offset === null || offset === undefined || !Number.isFinite(offset) || offset <= 0) return null
  if (!blockEnds.length) return null
  const total = blockEnds[blockEnds.length - 1]
  // 读完了 = 不画(头部栏已经说过了);最后一块之后也没有"之后"可画。
  if (offset >= total) return null
  for (let index = 0; index < blockEnds.length - 1; index += 1) {
    if (blockEnds[index] >= offset) return index
  }
  return null
}

export interface WatermarkBlock {
  /** 该块之后的 ProseMirror 文档位置(= 画线的地方)。 */
  pos: number
  /** 该块尾在整篇 markdown 里的字符偏移。 */
  end: number
}

/**
 * 逐块量一遍:前 k 个顶层块序列化出来有多长。
 *
 * `doc.cut(0, pos)` 切出来仍是一个 doc 节点(不是 Fragment)—— 序列化器会拿
 * `parent` 判紧凑列表之类的事,喂 Fragment 会踩到 `.attrs`。
 */
export function watermarkBlocks(doc: PMNode, serialize: (doc: PMNode) => string): WatermarkBlock[] {
  if (doc.childCount === 0 || doc.childCount > MAX_BLOCKS) return []
  const blocks: WatermarkBlock[] = []
  let pos = 0
  try {
    doc.forEach((child) => {
      pos += child.nodeSize
      blocks.push({ pos, end: serialize(doc.cut(0, pos)).length })
    })
  } catch {
    // 序列化器对半截文档不满意 —— 那就没有水位线,不是错误。
    return []
  }
  return blocks
}

export interface ConsumedWatermarkConfig {
  /** 已读末尾的 markdown 字符偏移;`null` = 还没有任何一版被消费过。 */
  getOffset: () => number | null
  /** 与纸上存的 markdown 同一套语法的序列化器(即 tiptap-markdown 那一份)。 */
  serialize: (doc: PMNode) => string
}

function renderLine(): HTMLElement {
  const line = document.createElement('div')
  line.className = 'tiptap-consumed-line'
  line.contentEditable = 'false'
  const label = document.createElement('span')
  label.className = 'tiptap-consumed-label'
  label.textContent = CONSUMED_WATERMARK_LABEL
  line.append(label)
  return line
}

function buildDecorations(doc: PMNode, config: ConsumedWatermarkConfig): DecorationSet {
  const offset = config.getOffset()
  if (offset === null || offset <= 0) return DecorationSet.empty
  const blocks = watermarkBlocks(doc, config.serialize)
  const index = watermarkBlockIndex(blocks.map(block => block.end), offset)
  if (index === null) return DecorationSet.empty
  const pos = blocks[index].pos
  return DecorationSet.create(doc, [
    Decoration.widget(pos, renderLine, { side: -1, key: `consumed:${pos}` }),
  ])
}

/**
 * 一个**裸 ProseMirror 插件**,不是 Tiptap 扩展 —— 宿主用 `editor.registerPlugin()`
 * 挂它。这样换来两件事:这个文件一行 Tiptap 都不 import(只依赖 prosemirror-*),
 * 而且挂上去的时候编辑器已经建好了,序列化器当场就能用。
 *
 * 装饰整份重算,而不是靠 `DecorationSet.map` 跟着事务漂:位置本来就是从
 * 「当前文档 + 当前偏移」推出来的,重算既便宜又不会漂。只在**文档变了**或
 * 外部推了新偏移(`tr.setMeta(consumedWatermarkKey, true)`)时算 —— 光标移动
 * 一下就重序列化全文是没必要的。
 */
export function consumedWatermarkPlugin(config: ConsumedWatermarkConfig): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: consumedWatermarkKey,
    state: {
      init: (_config, state) => buildDecorations(state.doc, config),
      apply: (transaction, value, _oldState, newState) => {
        if (!transaction.docChanged && !transaction.getMeta(consumedWatermarkKey)) return value
        return buildDecorations(newState.doc, config)
      },
    },
    props: {
      decorations: state => consumedWatermarkKey.getState(state) ?? DecorationSet.empty,
    },
  })
}

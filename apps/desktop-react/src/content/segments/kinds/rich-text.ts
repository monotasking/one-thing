import { createElement, Fragment } from 'react'
import { blockKey } from '../../assemble/key'
import { markdownToFrame } from '../../assemble/markdown'
import { BlockView } from '../../blocks/BlockView'
import {
  registerSegment,
  type NodeOf,
  type ProduceCtx,
  type SegmentOf,
  type SegmentViewProps,
} from '../registry'

/**
 * 正文段 —— 消费 `text` 节点,markdown 解析的产物(一串块)。
 *
 * `blockKey` 从 `assemble/key.ts` 直接拿,**不走 `assemble/index.ts`**:那个文件 import
 * 本目录的 barrel,反过来 import 它就是一个环。
 */
function produce(node: NodeOf<'text'>, ctx: ProduceCtx): SegmentOf<'rich-text'> | null {
  // 活跃与否要传下去:流式那条路(稳定前缀 / 未闭合原子块 / 节拍)全靠它。
  // 缓存的身份带上段序号 —— 一条消息会有不止一段正文(锚点归位之后这是常态)。
  const { blocks, offsets, ids } = markdownToFrame(ctx.id, node.text, ctx.live)
  /*
   * **一个块都没解出来 = 这一节点不成段**(回 null,装配循环不推)。判据留在产地而不是
   * 挪给循环:「空正文算不算一段」是正文这一型自己的事实,循环里写一个 `blocks.length`
   * 就是骨架又认识了一型。它也是 `prose` 那一问的另一半 —— 两处读的是同一格。
   */
  if (blocks.length === 0) return null
  return { kind: 'rich-text', blocks, offsets, ids }
}

/**
 * 适配:一串 `BlockView`,**不加包裹层**(Fragment 不产 DOM)—— 段是消息那个 flex 列的
 * 直接子项,中间插一层 div 会当场改掉 gap 的归属。
 */
function RichTextView({ model, segmentKey, ctx }: SegmentViewProps<SegmentOf<'rich-text'>>) {
  return createElement(
    Fragment,
    null,
    model.blocks.map((block, index) =>
      createElement(BlockView, {
        // key 由**源偏移**派生(§6):流式重解析时同一块的起点不变,React 打补丁
        // 而不是重挂 —— 中段插进来一个新块不会让它后面每一块都重建。
        key: blockKey(segmentKey, index, block, model.offsets[index], model.ids?.[index]),
        block,
        ctx,
      })),
  )
}

/*
 * 几何:`grow` —— 流式期间随字长高;`never` —— 正文没有收起态,落定后不许变矮。
 * `prose`:解出了块就是正文(产地已保证非空段才会出厂,这里仍照表写全,不靠产地的隐含前提)。
 */
registerSegment({
  kind: 'rich-text',
  node: 'text',
  produce,
  View: RichTextView,
  geometry: { liveForm: 'grow', settle: 'same-height', shrink: 'never' },
  prose: (model) => model.blocks.length > 0,
}, import.meta.hot)

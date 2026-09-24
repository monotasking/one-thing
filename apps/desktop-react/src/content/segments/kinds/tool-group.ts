import { createElement } from 'react'
import { presentToolCard } from '../../assemble/present'
import { ToolCard } from '../../tools/ToolCard'
import { registerSegment, type NodeOf, type SegmentOf, type SegmentViewProps } from '../registry'

/**
 * 工具卡段 —— 消费 `tool-group` 节点。**一次调用也是一张卡**(09-01 P2):单发与连发是
 * 同一个组件、同一张壳,「画成一行还是头行 + 一列」是 `ToolCard` 的事,不决定段种。
 */
function produce(node: NodeOf<'tool-group'>): SegmentOf<'tool-group'> {
  return { kind: 'tool-group', card: presentToolCard(node.calls) }
}

/** 适配:不产 DOM,只把 `model.card` 递给卡。 */
function ToolGroupView({ model, ctx }: SegmentViewProps<SegmentOf<'tool-group'>>) {
  return createElement(ToolCard, { card: model.card, ctx })
}

/*
 * 几何:`grow` —— 流式期间步数在长;`user-only` —— 卡只有人亲手收起才变矮
 * (工具跑完自动收起那一档 G3 就不许有)。不算正文:一条只有工具活儿的消息确实一个字
 * 都没回。
 */
registerSegment({
  kind: 'tool-group',
  node: 'tool-group',
  produce,
  View: ToolGroupView,
  geometry: { liveForm: 'grow', settle: 'same-height', shrink: 'user-only' },
}, import.meta.hot)

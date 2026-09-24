import { createElement } from 'react'
import { textLatest, textPreview, textToFrame } from '../../assemble/text'
import { ThinkingSegment } from '../../ThinkingSegment'
import {
  registerSegment,
  type NodeOf,
  type ProduceCtx,
  type SegmentOf,
  type SegmentViewProps,
} from '../registry'

/**
 * 思考段 —— 消费 `reasoning` 节点。
 *
 * 顶部推理与行内推理都是思考段:它们的差别是**落点**(placement),而落点已经由锚点步
 * 兑现成了序列上的位置,到这一层就没有第二个问题了。
 *
 * **与 `rich-text` 那一型逐字同形**(正本 `docs/thinking-stream-2026-09.md` §3):同样的
 * 身份(消息 id + 段序号)、同样把 `live` 传下去、同样由产地决定「哪一截已经定了」。
 * 差别只有一个:正文的切点问 markdown 语法,思考的切点只问换行。
 */
function produce(node: NodeOf<'reasoning'>, ctx: ProduceCtx): SegmentOf<'thinking'> {
  const { blocks, tail } = textToFrame(ctx.id, node.text, ctx.live)
  /*
   * 字段顺序与 P3 之前 `assemble/index.ts` 那一支逐字相同 —— 段模型「逐字节相同」
   * 连键序都算在内(快照、JSON 化的读数都看得见键序)。
   */
  return {
    kind: 'thinking',
    blocks,
    tail,
    /*
     * `live` = **这条消息**还在流。它是 R 线「块冻结」的判据(`textToFrame` 拿它决定
     * 哪一截已经定了、可以停止重画),所以这一格**一个字都不许改**。
     */
    live: ctx.live,
    /*
     * `thinking` = **这一块思考**此刻还在进行(P1b 裁定 D)= 消息在流 ∧ 它是序列上的
     * 最后一件。判据为什么是「最后一件」而不是账本上的 `part.ended`,写在
     * `assemble/index.ts` 那段循环上面。
     */
    thinking: ctx.live && ctx.isLast,
    preview: textPreview(blocks, tail),
    /*
     * 收起且这块思考还在进行时那一行显示的**最新一截**(G 线 P1)。与 `preview` 并排
     * 而不是二选一:两格说的是两个时刻的事实,而渲染层不许拿 6 万字的串现切。
     */
    latest: textLatest(blocks, tail),
  }
}

/**
 * 适配:把统一的 `{ model }` 翻成 `ThinkingSegment` 自己的 props。**不产 DOM** ——
 * 它是接线不是组件,「每种段只渲染一个元素、不加包裹层」因此原样保住。
 *
 * **传的是 `thinking` 不是 `live`**(P1b 裁定 D):这一件问的是「这一块思考还在不在
 * 进行」,而 `live` 说的是「这条消息还在流」。
 */
function ThinkingView({ model }: SegmentViewProps<SegmentOf<'thinking'>>) {
  return createElement(ThinkingSegment, {
    blocks: model.blocks,
    tail: model.tail,
    thinking: model.thinking,
    preview: model.preview,
    latest: model.latest,
  })
}

/*
 * 几何:`fixed` —— P1 起收起态那一行的高度在流式期间钉死(换的只是那一行里的字);
 * `user-only` —— 只有人亲手收起才变矮。不算正文:「想完了但没回话」正是收场通知
 * 要区分的那一种,所以 `prose` 缺席。
 */
registerSegment({
  kind: 'thinking',
  node: 'reasoning',
  produce,
  View: ThinkingView,
  geometry: { liveForm: 'fixed', settle: 'same-height', shrink: 'user-only' },
}, import.meta.hot)

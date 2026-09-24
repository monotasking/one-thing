import { createElement } from 'react'
import type { ProjectedMessage } from '../../../data/chat-fold'
import { CompactSeam } from '../../CompactSeam'
import { parseCompactMarker } from '../../compact/marker'
import { registerSegment, type SegmentOf, type SegmentViewProps } from '../registry'

/**
 * 压缩折痕(U2,设计正本 `docs/compact-seam-2026-09.md`)—— 今天唯一的**整条消息认领型**。
 *
 * 一次上下文压缩在账本上只是一条 system 消息,正文是后端写的一段 JSON。它不是「一段要读
 * 的字」—— 把它交给 markdown 那一步,屏幕上就是 09-08 事故里那坨原始 JSON。所以它在装配
 * 第 ⓪ 步、跑节点循环**之前**被问一句「这条消息自己说它是什么」。
 *
 * 判据整件住在 `compact/marker.ts`(角色 + 正文里的 `type`),这里一个字段名都不出现。
 * 认不出来(不是压缩标记、或者正文半途被截断解析不了)就回 null,消息照常往下走节点循环
 * —— **降级是「照实把正文摆出来」**,不是吞掉这条消息。
 */
function claim(message: ProjectedMessage): SegmentOf<'compact'> | null {
  const marker = parseCompactMarker(message)
  return marker ? { kind: 'compact', marker } : null
}

/**
 * 适配:不产 DOM。折痕是**流里的一道线**,不是一件物件 —— 和别的段一样只渲染一个元素、
 * 不加包裹层,横贯整行由它自己的 grid 说了算。
 */
function CompactView({ model, ctx }: SegmentViewProps<SegmentOf<'compact'>>) {
  return createElement(CompactSeam, { marker: model.marker, ctx })
}

/*
 * 几何:`fixed` —— 进行中那一行高度不随进度变;`user-only` —— 摘要只有人亲手收起才
 * 变矮。不算正文:折痕说的是「上下文被压过了」,不是模型的回话。
 */
registerSegment({
  kind: 'compact',
  claim,
  View: CompactView,
  geometry: { liveForm: 'fixed', settle: 'same-height', shrink: 'user-only' },
}, import.meta.hot)

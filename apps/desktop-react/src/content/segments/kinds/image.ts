import { registerSegment, type NodeOf, type SegmentOf, type SegmentViewProps } from '../registry'

/**
 * 图片段 —— 消费 `image` 节点(账本上一个带 blob 的 part)。
 *
 * 模型今天就产得出来(锚点步认得 `image` part),**画它的那一天还没到**:通电归
 * `docs/markdown-image-2026-09.md` 正本 P2 / G 线 P5。所以 `View` 回 null —— 与 P3 之前
 * `SegmentView` 那一格逐字同义,屏幕零变化。
 */
function produce(node: NodeOf<'image'>): SegmentOf<'image'> {
  return { kind: 'image', blob: node.blob }
}

/**
 * 回 null 而不是连 `View` 都不写:`View` 是必答格,缺席的型在 `SegmentView` 里是一个
 * 查得到 def 却画不出东西的静默洞。显式回 null 把「今天不画」写成一句话。
 */
function ImageView(_props: SegmentViewProps<SegmentOf<'image'>>) {
  return null
}

/*
 * 几何:`reserve` —— 图片要先按尺寸立骨架再填像素(否则加载完那一刻整列下推);
 * `never` —— 落定之后不许变矮。算正文:它是这一轮真的产出的东西。
 */
registerSegment({
  kind: 'image',
  node: 'image',
  produce,
  View: ImageView,
  geometry: { liveForm: 'reserve', settle: 'same-height', shrink: 'never' },
  prose: () => true,
}, import.meta.hot)

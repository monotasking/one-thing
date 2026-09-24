import { memo } from 'react'
import type { BlockCtx } from './blocks/registry'
import type { SegmentModel } from './model/segments'
// 段表装好(副作用 import):谁要按 kind 查表,谁就负责表已经装上 —— 与
// `markdown/incremental.ts` 自己 `import '../blocks'` 同一条纪律,不靠「别人碰巧先 import 了」。
import './segments'
import { resolveSegment } from './segments/registry'

/**
 * 段渲染 —— **段 → React** 的那一层。它自己不认识任何一种段:按 kind 查段表,
 * 交给那一型自述的 `View`(G 线 P3,正本 `docs/stream-geometry-2026-09.md` §20)。
 *
 * ── 为什么段也有了注册表,又为什么它与块表不一样 ─────────────────────────
 * 从前这里是一个穷尽 `switch`,理由是「段由装配管线独家产出,一个没见过的段就是代码
 * 写错了」。那条理由有一半今天仍然成立,另一半被仓根「加功能不许改骨架」法推翻:
 * 加一种段要同时改这里和 `assemble/index.ts` 两个 switch,骨架按能力枚举。于是段也
 * 进表,但与块表**故意**有三处不同:
 *  1. **未知 kind 不兜底,`resolveSegment` 抛。** 产地正是表里那几条 def 自己,所以
 *     「查不到」只可能是装配错误(段 barrel 没被 import),与块表 `source-fallback`
 *     缺席那一支是同一条路。词汇在**类型层仍然封闭**(`SegmentModel` / `SegmentKind`
 *     不变),表改变的只是「加一种段要改哪几个文件」。
 *  2. **契约不是块的五问,是几何三问 + `prose` 一问。** 段这一层没有块流那台机制:
 *     段 key 由序号 + kind 派生,失败由错误边界兜,中间态由每一型自己的模型说。
 *  3. **生产也进表。** def 自述它消费哪一种归组节点(`node`)或认领整条消息(`claim`);
 *     装配循环只按节点种查 def、调它的 `produce`。
 *
 * ── 为什么它不是 ChatStream 的一段 JSX ──────────────────────────────
 * ChatStream 管「消息怎么排」,这里管「一条消息里的一段怎么画」。分开之后,
 * ChatStream 那份「消息列表 + overlay + 空态」的排布代码永远不动 —— 而加一种段
 * 今天连这个文件也不动了:它是 `segments/kinds/` 下一个文件 + barrel 一行。
 *
 * 每种段**只渲染一个元素、不加包裹层**:段是消息那个 flex 列的直接子项,中间插一层
 * div 会当场改掉 gap 的归属。这条纪律今天由各型的 `View` 守着 —— 它们都是不产 DOM
 * 的适配函数,把统一的 `{ model, segmentKey, ctx }` 翻成既有组件自己的 props。
 */
export const SegmentView = memo(function SegmentView({
  segment,
  segmentKey: key,
  ctx,
}: {
  segment: SegmentModel
  /** 这个段的稳定 key —— 块 key 挂在它下面派生。 */
  segmentKey: string
  ctx: BlockCtx
}) {
  const def = resolveSegment(segment.kind)
  return <def.View model={segment} segmentKey={key} ctx={ctx} />
})

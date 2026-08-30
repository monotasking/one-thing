import type { AnchoredNode } from './anchor'
import type { ProjectedToolCall } from '../tools/presenter'

/**
 * 管线第 ② 步:**归组**(§2)。
 *
 * 把「相邻、同族、中间没有别的 part 打断」的工具调用折成一组(B2 的执行清单),
 * 把 web_search / web_open 族折成检索段(P4 的四件套)。
 *
 * 归组的判据是**数据性质,与后端形状无关**:专用 research 引擎的一次调用天然
 * 是一组,模型自己裸连发五次搜索也归得出同一段 —— 所以这一步只看节点序列,
 * 不问「这台 core 有没有 research 引擎」。
 *
 * ── P0 是直通 ────────────────────────────────────────────────────────
 * 一次调用一张卡,与今天逐字相同。归组会把 N 张卡变成一句计数文案,那是
 * 可感知变化,属 P2/P4。类型先立着(`GroupedNode` 的两个新变体),函数体后补 ——
 * 这样接的时候上下游的类型不用动。
 */

export type GroupedNode =
  | AnchoredNode
  | { node: 'tool-group'; calls: ProjectedToolCall[] }
  | { node: 'research'; calls: ProjectedToolCall[] }

export function groupNodes(nodes: readonly AnchoredNode[]): GroupedNode[] {
  return [...nodes]
}

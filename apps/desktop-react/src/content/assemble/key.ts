import type { BlockModel } from '../model/blocks'
import type { SegmentModel } from '../model/segments'

/**
 * 管线第 ⑤ 步:**稳定 key**(§2 / §6)。
 *
 * ── 为什么这是一步、而不是渲染时随手 `index` ────────────────────────────
 * key 稳定性是**硬约束**,不是整洁癖。流式期间同一段文本每帧重解析一次,key 一变
 * React 就丢弃旧子树重建 —— 代码块逐帧重挂、滚动位置归零、shiki 逐帧重染。
 * tab 卡顿那一批的教训原样重演一遍(整棵卸载重建 = 长帧),所以它单独成一步、
 * 单独有单测。
 *
 * ── 为什么 key 不进模型 ──────────────────────────────────────────────
 * 模型是数据,key 是**渲染的事**:同一份段模型在别处(比如导出、复制)不需要 key,
 * 而且往模型里塞一个只有 React 读的字段,深比、序列化、快照测试都会被它污染。
 * 所以 key 是**纯函数派生**——给同一份输入永远算出同一个字符串。
 *
 * ── P0 按序号,P1 换源偏移 ────────────────────────────────────────────
 * P0 的段序列是「推理 → 正文 → 工具卡」,顺序只在末尾增长(工具卡一张张追加),
 * 序号因此天然稳定。P1 真解析器进来之后,正文中段插入一个块会让后面所有序号平移,
 * 那时改成源偏移派生 —— **只改这一个文件**,上下游一行不动。
 */

/**
 * 段 key。带上 `kind`:同一个位置从一种段变成另一种段时,那本来就该是两个组件,
 * 让 React 重挂是对的(复用会把上一种段的状态带进新组件)。
 */
export function segmentKey(messageId: string, index: number, segment: SegmentModel): string {
  return `${messageId}:${index}:${segment.kind}`
}

/** 块 key。挂在所属段的 key 下 —— 段换了,块自然全换,不必再判一次。 */
export function blockKey(segmentKeyValue: string, index: number, block: BlockModel): string {
  return `${segmentKeyValue}/${index}:${block.kind}`
}

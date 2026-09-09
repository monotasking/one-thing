import { memo } from 'react'
import { blockKey } from './assemble'
import { BlockView } from './blocks/BlockView'
import type { BlockCtx } from './blocks/registry'
import { CompactSeam } from './CompactSeam'
import type { SegmentModel } from './model/segments'
import { ResearchSegment } from './research/ResearchSegment'
import { ThinkingSegment } from './ThinkingSegment'
import { ToolCard } from './tools/ToolCard'

/**
 * 段渲染 —— **段 → React** 的那一层,一个穷尽 switch。
 *
 * ── 为什么段没有注册表,块有 ──────────────────────────────────────────
 * 块的产地有两个(markdown 解析、工具 presenter),而且将来要接插件,所以块必须
 * 有注册表、有未知兜底:一个没见过的 kind 是**正常情况**。段不同 —— 段由装配管线
 * 独家产出,词汇表和产地在同一个人手里,一个没见过的段就是**代码写错了**。
 * 给它加一张注册表只会把编译期能抓的错推到运行时。
 *
 * ── 为什么它不是 ChatStream 的一段 JSX ──────────────────────────────
 * ChatStream 管「消息怎么排」,这里管「一条消息里的一段怎么画」。分开之后,
 * 加一种段(检索段、图片段)碰的是这个文件,而 ChatStream 那份「消息列表 +
 * overlay + 空态」的排布代码永远不动。
 *
 * 每种段**只渲染一个元素、不加包裹层**:段是消息那个 flex 列的直接子项,
 * 中间插一层 div 会当场改掉 gap 的归属。
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
  switch (segment.kind) {
    case 'thinking':
      return <ThinkingSegment text={segment.text} live={segment.live} />

    case 'rich-text':
      return (
        <>
          {segment.blocks.map((block, index) => (
            <BlockView
              // key 由**源偏移**派生(§6):流式重解析时同一块的起点不变,React 打补丁
              // 而不是重挂 —— 中段插进来一个新块不会让它后面每一块都重建。
              key={blockKey(key, index, block, segment.offsets[index], segment.ids?.[index])}
              block={block}
              ctx={ctx}
            />
          ))}
        </>
      )

    case 'compact':
      // 折痕(U2)。它是**流里的一道线**,不是一件物件 —— 所以和别的段一样
      // 只渲染一个元素、不加包裹层,横贯整行由它自己的 grid 说了算。
      return <CompactSeam marker={segment.marker} ctx={ctx} />

    case 'tool-group':
      return <ToolCard card={segment.card} ctx={ctx} />

    case 'research':
      // 段 key 兼作检索段的身份:消息尾来源条按同一个字符串点名(research/reveal.ts),
      // 两处都走 `segmentKey`,不各拼一遍。
      return <ResearchSegment episode={segment.episode} id={key} ctx={ctx} />

    case 'image':
      // 图片段的渲染器是 P3 的事。装配管线今天不产它,所以这里不画等于「零变化」。
      return null

    case 'stream-cursor':
      // 光标的产地**不在装配管线里**:活跃与否是数据源的事实(activeMessageId),
      // 不是这条消息自己的事实,而管线只拿得到消息。所以今天它由 ChatStream 直接画,
      // 段词汇里这一格留着 —— 等装配也拿得到活跃态时再把它收进来。
      return null
  }
})

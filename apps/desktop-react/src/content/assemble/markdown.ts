import { BLOCK_STREAM } from '../blocks/stream/flag'
import { MarkdownBlockStream, parseBlockFrame } from '../markdown/block-stream'
import { markdownStream, parseFrame, type MarkdownFrame } from '../markdown/incremental'

/**
 * 管线第 ④ 步:**markdown 产地**(§2)。
 *
 * 一段文本进来,块序列出去。**只解析,不渲染** —— 这一步产出的是纯数据,谁来画
 * 由块注册表说了算。
 *
 * 这个文件本身不认识 markdown:真解析器住 `src/content/markdown/`(mdast 翻译表、
 * 围栏路由、增量与节流),这里只做**一件事的选择** —— 这段文本是活的还是死的。
 * 两条路的分岔在这里,是因为它是**装配的事实**(哪条消息在流),不是解析器的事实。
 *
 * ── 活的走块流,死的走全量 ────────────────────────────────────────────
 * 活跃消息每帧换一次引用,重解析走块流生产者(稳定前缀沿用 + 16ms 节拍 + 行级提交)。
 * 一旦它不流了,当场把那条车道丢掉 —— 历史消息由装配管线按消息引用 memo,再留一份
 * 就是两套失效逻辑,而两套失效逻辑迟早会分叉。
 *
 * 两条路给出的**身份号逐字相同**(产地派生),所以收尾那一刻不重挂。
 *
 * ── 旧路 ──────────────────────────────────────────────────────────────
 * `onething.blockStream=off` 走 R4a 之前那条:每帧一份新的块列表,身份由渲染侧按
 * 源偏移现算(`blockKey` 的 `offset` 那一支)。留到真机浸泡结束。
 */

/** 生产侧那一台。测试各起各的(节拍要能拨,车道不许互相污染)。 */
const blockStream = new MarkdownBlockStream()

export function markdownToFrame(messageId: string, text: string, live: boolean): MarkdownFrame {
  if (!BLOCK_STREAM) {
    if (!live) {
      markdownStream.forget(messageId)
      return parseFrame(text)
    }
    return markdownStream.parse(messageId, text, true)
  }

  if (!live) {
    blockStream.forget(messageId)
    return parseBlockFrame(text)
  }
  return blockStream.frame(messageId, text, true)
}

export type { MarkdownFrame }

/*
 * **模块级可变状态配 HMR 退役**(本目录 CLAUDE.md 的那条法)。
 *
 * 这两台机器的寿命是「这个模块实例」:热更之后旧模块那份车道账还留着,而新模块
 * 会为同一条消息另起一份 —— 两台折叠器同时活着,正是性能调查里抓到过的那一形。
 * 退役复用它们**已有的那一口拆卸**(`reset()`),不写第二套:两套拆卸迟早漏一格。
 * 生产构建里 `import.meta.hot` 恒为 undefined,整段被摇掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    blockStream.reset()
    markdownStream.reset()
  })
}

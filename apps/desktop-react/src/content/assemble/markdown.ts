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
 * ── 活的走流式缓存,死的走全量 ────────────────────────────────────────
 * 活跃消息每帧换一次引用,重解析走 `MarkdownStream`(稳定前缀沿用 + 16ms 节拍)。
 * 一旦它不流了,当场把那份帧缓存丢掉 —— 历史消息由装配管线按消息引用 memo,
 * 再留一份就是两套失效逻辑,而两套失效逻辑迟早会分叉。
 */
export function markdownToFrame(messageId: string, text: string, live: boolean): MarkdownFrame {
  if (!live) {
    markdownStream.forget(messageId)
    return parseFrame(text)
  }
  return markdownStream.parse(messageId, text, true)
}

export type { MarkdownFrame }

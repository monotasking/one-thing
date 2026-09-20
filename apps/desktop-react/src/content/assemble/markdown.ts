import { splitIncompleteRefTail } from '@onething/core/references'
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

/**
 * **还在流的那一段:半截 `<ref` 扣住不画**(B2,正本
 * `docs/design/reference-tag-2026-09.md` §2.6)。
 *
 * 病:标签逐 token 到达,`<ref type="file" pa` 这半截会被 markdown 当文字画出来,
 * 闭合那一拍再整段换成 chip —— 一次肉眼可见的闪,而且一行只有标签时它还会先落成
 * 一块 `source-fallback`(带「复制源码」檐的源码块)再翻成段落。
 *
 * 修法落在**这一处**,而不是解析器里面:`live` 是**装配的事实**(哪条消息在流),
 * 解析器不知道也不该知道 —— 那正是这只文件文件头那句「两条路的分岔在这里」。
 * 于是新旧两条路(块流 / 旧路)与两条全量路自动共用同一个判据,四处不必各写一遍。
 *
 * 扣的是 `splitIncompleteRefTail` 说的那一截:一个还没闭合、其间没有换行、不超过
 * 512 字符的 `<ref…` 尾巴。流结束(`live === false`)那一拍**不扣** —— 没闭合的
 * 就是字面量,照实画出来。
 *
 * 预算:一次从尾部往回最多 512 字符的扫描,每帧一次。切点(`stableCut`)永远落在
 * **行首**,而一条标签不跨行,所以它不可能切进一条未闭合的标签里(论证写在交卷)。
 */
export function markdownToFrame(messageId: string, text: string, live: boolean): MarkdownFrame {
  const body = live ? splitIncompleteRefTail(text).head : text

  if (!BLOCK_STREAM) {
    if (!live) {
      markdownStream.forget(messageId)
      return parseFrame(body)
    }
    return markdownStream.parse(messageId, body, true)
  }

  if (!live) {
    blockStream.forget(messageId)
    return parseBlockFrame(body)
  }
  return blockStream.frame(messageId, body, true)
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

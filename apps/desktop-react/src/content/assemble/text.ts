import { TextStream, type TextBlock, type TextFrame } from '../text/text-stream'

/**
 * 管线的**纯文本产地** —— 与 `assemble/markdown.ts` 逐条同形(正本
 * `docs/thinking-stream-2026-09.md` §3)。
 *
 * 一段文本进来,块与活动尾出去。这个文件自己不认识切点规则(那在
 * `content/text/text-stream.ts`),只做**一件事的选择**:这段文本是活的还是死的 ——
 * 那是**装配的事实**(哪条消息在流),不是切点的事实。
 *
 * ── `forget` 为什么排在 `frame` 之后,而 markdown 那边排在之前 ────────────
 * `markdownToFrame` 的死路是 `parseFrame(text)`,一个与缓存无关的纯函数,所以先丢账
 * 再解析。这里的死路要的恰恰是那本账:**收尾那一帧必须接着流式那些块冻**,不然
 * 「已经画好的那些块」会集体换 id,React 当场重挂一屏字。所以顺序是
 * 「冻(用上账)→ 丢账」,与正本 §4 表 1 的两行逐行对应(`frame(…, false)` 全冻 /
 * 消息实例换掉时 `forget`)。
 *
 * 推论,写在这里免得以后当 bug 查:一条**从未在本次进程里流过**的历史思考
 * (冷载、或者装配缓存被淘汰之后重算)冻出来是**一块**,不是流式时那一串。
 * 这是对的 —— 块边界是「帧怎么到的」这件事的影子,不是文本自己的性质,给死文本
 * 另立一套切法就是给「块从哪儿断」立第二个真相。它也不伤手感:收尾那一刻思考段
 * 自动折回一行(`ThinkingSegment` 跟着 `live` 走),正文根本不在 DOM 里。
 */

/** 生产侧那一台。测试各起各的(车道不许互相污染)。 */
const textStream = new TextStream()

/**
 * 收起时唯一挂载的那点字(正本 §4)。240 是「一行怎么钳都够用」与
 * 「停靠池里几百段加起来仍然是几万字量级」两头算出来的:175 段 × 240 ≈ 4.2 万字,
 * 对着正本 §0 那 104 万字。
 */
export const PREVIEW_CHARS = 240

export function textToFrame(id: string, text: string, live: boolean): TextFrame {
  if (!live) {
    const frame = textStream.frame(id, text, false)
    textStream.forget(id)
    return frame
  }
  return textStream.frame(id, text, true)
}

/**
 * 预览取**第一块**的前 240 字;一块都还没冻出来(第一帧还没见过换行)时取活动尾 ——
 * 两者都是「这段文本最开头那 240 字」,只是它此刻存在哪儿。
 *
 * 不取「最新一行」:那是正本 §6 记着的那个拍点(流式中手动收起时显示开头还是最新),
 * 本单按缺省走开头。
 */
export function textPreview(blocks: readonly TextBlock[], tail: string): string {
  return (blocks[0]?.text ?? tail).slice(0, PREVIEW_CHARS)
}

/*
 * **模块级可变状态配 HMR 退役**(本目录 CLAUDE.md 的那条法)。这台机器的寿命是
 * 「这个模块实例」:热更之后旧模块那份账还留着,而新模块会为同一段文本另起一份。
 * 退役复用它**已有的那一口拆卸**(`reset()`),不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    textStream.reset()
  })
}

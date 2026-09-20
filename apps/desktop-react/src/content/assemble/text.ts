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
 * **折成一行**(G 线 P1 审查打回第 1 条,2026-09-20)。
 *
 * 收起态那一行是**一行**,而思考正文满是 `\n`。第一版把切片原样交出去、让 CSS 的
 * `white-space: pre` 去排 —— 那一句**只管不自动折行,换行符照样断行**:240 字在
 * span 里排成好几行,而外面那一格 `block-size` 钉死一行高 + `overflow: hidden`,
 * 于是屏幕上露出来的是这 240 字里的**第一行**(流式那一档因此显示的根本不是
 * 「最新一截」),横向右对齐对齐的也是最宽那一行。
 *
 * 所以「一行」这件事在**装配层**就要兑现:连续空白(含换行)折成一个空格,两端修掉。
 * **只在 ≤240 的切片上做**,代价与历史长度无关(与 `textLatest` 同一条纪律)。
 *
 * 它顺带把另一件东西还了回来:落定那一档从前靠 `line-clamp: 1` 钳,有第二行时
 * 自带省略号;换成单行之后 `text-overflow: ellipsis` 要求「这一行真的太长」才给,
 * 折成一行正好让它重新说得出「后面还有」。
 *
 * **拼接不变量不受影响**:`blocks + tail` 逐字等于原文那一条只约束**展开态**
 * (那一头一个字都没动),这里折的是收起态那一行**索引用**的字。
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 预览取**第一块**的前 240 字;一块都还没冻出来(第一帧还没见过换行)时取活动尾 ——
 * 两者都是「这段文本最开头那 240 字」,只是它此刻存在哪儿。
 *
 * 它是**落定之后**那一行的字(2026-09-20 G 线 P1 起):流式期间收起态改显示
 * `textLatest` 那一截,判词在它自己身上。**折成一行**的理由见 `oneLine`。
 */
export function textPreview(blocks: readonly TextBlock[], tail: string): string {
  return oneLine((blocks[0]?.text ?? tail).slice(0, PREVIEW_CHARS))
}

/**
 * **最新一截** —— 这段文本**末尾**那 ≤240 字(G 线 P1,正本
 * `docs/stream-geometry-2026-09.md` §5.1)。
 *
 * 流式期间收起态那一行显示的就是它:人不展开也看得出「它此刻在说什么」,
 * 而 DOM 里仍然只有 240 字(§5.1 表 ② 的「超量」那一格:6 万字思考,收起态
 * DOM 仍只挂 ≤240 字)。
 *
 * ── 每帧代价与历史长度无关 ──────────────────────────────────────────────
 * 这一句流式期间每帧都跑一遍,所以它**不许**把 `blocks` 拼起来再切尾 ——
 * 那就是每帧按整段思考计价(正本 §0 量到的 71–136ms 同款账)。
 * 活动尾自己封顶 `TAIL_LIMIT`(4,000 字),够 240 就在它里面切完;不够时
 * 只往回看**最后一块**(`blocks[blocks.length - 1]`,一次下标),再不够就到此为止 ——
 * 少几个字的代价是这一行左端少一截,而那一截本来就被裁掉了(见
 * `SegmentView.module.css` 的 `.thoughtPreview[data-live]`:右端对齐、裁左边)。
 *
 * **折成一行**(判词在 `oneLine` 上):思考正文满是 `\n`,不折的话这一行在屏幕上
 * 露出来的是这 240 字里的**第一行**,而不是末尾 —— 那正是审查打回的那个 bug。
 * 折在切片之后做,所以代价仍然是 O(240)。
 */
export function textLatest(blocks: readonly TextBlock[], tail: string): string {
  if (tail.length >= PREVIEW_CHARS) return oneLine(tail.slice(-PREVIEW_CHARS))
  const last = blocks[blocks.length - 1]?.text ?? ''
  return oneLine(`${last.slice(-(PREVIEW_CHARS - tail.length))}${tail}`)
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

/**
 * **稳定前缀的切点**(§6:「稳定前缀 + 活动尾」)。
 *
 * 回答一个精确的问题:**源文本的前 N 个字符,解析结果会不会被后面追加的字符改掉?**
 * 答案是「不会」的最大 N,就是这里返回的偏移。切在它上面,前面那些块可以整块沿用,
 * 只有活动尾要重解析。
 *
 * ── 为什么不能随便挑一个空行 ──────────────────────────────────────────
 * markdown 里**空行不等于块边界**。会跨空行长回来的东西至少有六种:
 *
 *   - 松散列表:`- a\n\n` 后面来一个 `- b`,两截合成**一张**列表(不是两张);
 *   - 引用块:`> a\n\n` 后面来 `> b` 同理;
 *   - 表格:`|a|\n|-|\n\n` 后面来 `|b|` 同理;
 *   - HTML 块(1–5 型):`<pre>\n\n</pre>` 中间的空行不结束它;
 *   - 链接引用 / 脚注定义:`[^1]: 正文\n\n    还是它的正文`(缩进续行);
 *   - 缩进代码块:空行之后的四空格行仍属同一块。
 *
 * 所以判据不是「有个空行」,而是「空行之后**开的是一个新块,且旧块不可能被续上**」:
 * 下一行顶格(排掉缩进续行)、不是列表/引用/表格/HTML 的起手式(排掉前四种),
 * 而且整个前缀里从没出现过 HTML 与脚注/引用定义的起手式(它们能隔很远续上)。
 *
 * 判据保守到位的代价只是「有时不切、退回全量解析」—— 全量解析永远是对的,
 * 切错才会让屏幕上出现一份和最终结果不一样的东西。这条不对称决定了所有取舍。
 */

/** 会跨空行续上的起手式:列表 / 引用 / 表格 / HTML / 定义(链接引用、脚注)。 */
const CONTINUABLE_OPENER = /^(?:[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>|\||<|\[)/

/** 围栏行:0–3 空格缩进 + 三个以上的 ` 或 ~。 */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/
/** 收尾围栏:同上,而且后面只许空白(带 info string 的那行只能开,不能关)。 */
const CLOSING_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

export function stableCut(text: string): number {
  let cut = 0
  let sawContinuableAnywhere = false
  let inFence = false
  let fenceMarker = ''
  let pendingBlank = false
  let pos = 0

  // 手动切行(不 split):流式期间这个函数每帧跑一次,不该每帧造一个行数组。
  while (pos <= text.length) {
    let lineEnd = text.indexOf('\n', pos)
    const atEof = lineEnd === -1
    if (atEof) lineEnd = text.length
    const line = text.slice(pos, lineEnd)

    const fence = FENCE_LINE.exec(line)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1]
      } else if (CLOSING_FENCE_LINE.test(line) && line.trimStart()[0] === fenceMarker[0]) {
        inFence = false
      }
      pendingBlank = false
    } else if (inFence) {
      // 围栏里的一切都不是块边界,连空行都不是。
      pendingBlank = false
    } else if (line.trim() === '') {
      pendingBlank = true
    } else {
      if (CONTINUABLE_OPENER.test(line) || /^[ \t]/.test(line)) {
        // 顶格判据的两半:缩进行(可能是某个块的续行)、跨空行能续上的起手式。
        // 一旦出现过后者,整篇往后都不再切 —— 它可能在任意远处被续上。
        if (CONTINUABLE_OPENER.test(line)) sawContinuableAnywhere = true
      } else if (pendingBlank && !sawContinuableAnywhere) {
        // 空行之后、顶格、开的是一个不可续的新块 —— 这一行的行首就是安全切点。
        cut = pos
      }
      pendingBlank = false
    }

    if (atEof) break
    pos = lineEnd + 1
  }

  return cut
}

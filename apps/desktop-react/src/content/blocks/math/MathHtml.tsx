/**
 * KaTeX 的产物上屏 —— **唯一**的一处。
 *
 * ── 为什么这里是 `dangerouslySetInnerHTML`,而 SvgCanvas 不是 ──────────────
 * 本仓对「外来标记上屏」有一条判例:代码块拒绝 innerHTML(`code/CodeLines.tsx` 自己
 * 拼 React 元素)、图块拒绝 innerHTML(`shell/SvgCanvas.tsx` 走 DOMParser)。这一处
 * 是那条判例的**第三种答案**,三条理由:
 *
 *  ① **安全边界是显式的,不是「上游净化得够干净」**。KaTeX 在 `trust: false` 下
 *     对 `\href` / `\url` / `\includegraphics` / `\html*` 一律拒绝执行(画成红色错误
 *     文字),文本内容一律转义;产出里结构上不可能有 `<script>`、`<a href>` 或任何
 *     属性值来自 TeX 源码的东西。那几格选项逐条写在 `katex.ts` 里,与 mermaid 的
 *     `securityLevel: 'strict'` 是同一种「把判据写出来」的纪律。
 *  ② **DOMParser 那条路在这里会换来一次布局位移**。它要在 effect 里把节点塞进去,
 *     而 effect 排在绘制之后 —— 一张图晚一帧出现没人看得出来,一行公式晚一帧出现
 *     就是段落高度跳一下,而且一条消息里有几十条。同一次提交里画完是这一格的要求。
 *  ③ KaTeX 交出来的是 **HTML**(带 MathML),不是 XML;SvgCanvas 那条路借的正是
 *     XML 解析「`<script>` 天生不可执行」的性质,换到 HTML 上借不到。
 *
 * 所以这一处是**收口**而不是开口:全仓只有这一个文件写得出这一句,新的公式落点
 * (放大浮层、导出)都从这里过。
 */
export function MathHtml({
  html,
  display,
  className,
}: {
  html: string
  /** 居中的一行(块)还是夹在字里的一个词(行内)—— 决定用什么元素装。 */
  display: boolean
  className?: string
}) {
  /*
   * 行内那一档必须是 `<span>`:段落是 `white-space: pre-wrap` 的一段字,塞一个块级
   * 元素进去会把那一行断开(同 InlineRun 里「不多包一层 DOM」的那条判词)。
   */
  if (!display) return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
}

import type { BlockModel } from '../model/blocks'
import { parseUnifiedDiff } from '../blocks/kinds/diff/parse'

/**
 * **围栏语言即路由**(§3.2)。
 *
 * ── 为什么路由表和块注册表是两张表 ────────────────────────────────────
 * 注册表回答「这个 kind 谁来画」,路由表回答「```mermaid 该变成哪个 kind」。后者是
 * **markdown 产地的私事** —— 工具产地(read 的结果是 code、edit 的结果是 diff)
 * 根本不经过它。合成一张表会让「加一种工具展示」和「加一种图种」互相牵动。
 *
 * ── 认不出的图种不是错误 ──────────────────────────────────────────────
 * 这里只负责把 ```mermaid 变成 `figure(figKind:'mermaid')`。P1 的块注册表里**没有**
 * figure 渲染器,于是 `resolveBlock` 兜到 source-fallback,屏幕上是那段图源码 ——
 * 这正是「渐进」的样子:产地先说清事实,渲染器后到,中间的日子里源码可见。
 */

/**
 * 图种围栏 —— 这些语言的内容不是「代码」,是**图的源码**:它们该被画成图,
 * 画不出来才退回源码。名字用小写原样比对(围栏语言由作者手写,不做别名归一:
 * 归一表是一份要维护的猜测,而认不出的后果只是「按代码显示」,并不严重)。
 */
const FIGURE_LANGS = new Set(['mermaid', 'plantuml', 'puml', 'graphviz', 'dot', 'd2', 'vega', 'vega-lite'])

export function isFigureLang(lang: string | null): boolean {
  return lang !== null && FIGURE_LANGS.has(lang)
}

/**
 * 一个围栏 → 一个块。
 *
 * `closed` 是流式契约的输入(§6):图种围栏与 ```diff **只有闭合了才换装**。半截的
 * 图源码画不出图、半段 diff 的 hunk 头还没到(行号无从起算),两者都按 code 逐行
 * 长出来,闭合那一刻原位换装(atomic)—— 这就是设计里那句「未闭合按 code 显示」。
 *
 * ── ```diff:P2 留账在这一批结清 ────────────────────────────────────────
 * P2 时这里仍产 `code(lang:'diff')`,留账写着「必须与工具产地同批接同一个块」。
 * P3 两边同时换了:这里、以及 `tools/presenters/edit.ts` 的 detail。于是同一段 diff
 * 在正文里和在工具抽屉里是**同一个组件**,不是两种长相。
 *
 * 解析不动(那段文字根本不像 diff)时退回 `code(lang:'diff')` —— 作者标了 diff 但
 * 写的是别的东西,这不是错误,只是这台看不出结构。同一条失败语义:降级,不报错。
 */
export function routeFence(lang: string | null, source: string, closed: boolean): BlockModel {
  if (closed && isFigureLang(lang) && lang !== null) {
    return { kind: 'figure', figKind: lang, source }
  }
  if (closed && lang === 'diff') {
    const parsed = parseUnifiedDiff(source)
    if (parsed) return { kind: 'diff', ...parsed }
  }
  return { kind: 'code', lang, source, closed }
}

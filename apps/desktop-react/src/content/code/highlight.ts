import type { HighlighterCore, ThemedToken } from 'shiki/types'

/**
 * 语法高亮 —— **shiki,懒加载,素文本先行**。
 *
 * ── 主题:vitesse-light ───────────────────────────────────────────────
 * 内置主题里挑的一个,选它的理由是它的底色与前景都偏暖、对比压得住 —— 贴壳的暖纸,
 * 不像 github-light 那样冷白刺眼。**这是临时落点**:主题 → 壳 token 的映射是后续
 * 拍板件(那之后代码块的颜色会跟着主题桥走,而不是自带一份配色)。在那之前,
 * shiki 吐出来的行内色是**数据**(每个 token 一个颜色),不是样式表里的字面值 ——
 * 「颜色零字面值」那条铁律管的是容器,不管这份数据。
 *
 * ── 为什么不走 BlockShell 的 `def.loader` ──────────────────────────────
 * 壳的 loader 会挂起(Suspense)到库拉回来为止,期间画骨架。那对 mermaid 是对的
 * (没有库就没有图,只能等);对代码块是**错的** —— 没有 shiki,代码块照样有一个
 * 完全正确的样子:素文本。用骨架把一份已经正确的渲染盖住,是拿一段空白换一点颜色。
 * 所以这里自己管懒加载:第一帧素文本,库到了就地重画(块的 key 不变,不重挂)。
 * 拉不到就永远是素文本 —— 失败路径与「还没拉到」是同一条,没有第二套。
 *
 * ── 语言表是固定的一小撮 ──────────────────────────────────────────────
 * 用 `shiki/core` + 逐个 import 语法,而不是 `shiki` 那个全量 bundle:后者会把两百
 * 多种语法都变成潜在的动态 chunk。表里没有的语言(以及认不出的别名)一律退回素文本 ——
 * 不是错误,是这台不认识它。
 */

import { LANGUAGES } from '../../data/languages'

type Highlighter = HighlighterCore

let highlighter: Highlighter | undefined
let loading: Promise<Highlighter | undefined> | undefined

/**
 * 拉起 shiki。重复调用共用同一个 promise;失败**不抛**,而是记住「没有高亮器」——
 * 调用方的正确反应是继续画素文本,不是炸掉这一块。
 */
export function loadHighlighter(): Promise<Highlighter | undefined> {
  if (highlighter) return Promise.resolve(highlighter)
  loading ??= createHighlighter().then(
    (made) => {
      highlighter = made
      return made
    },
    () => undefined,
  )
  return loading
}

async function createHighlighter(): Promise<Highlighter> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
  ])
  return createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: [import('shiki/themes/vitesse-light.mjs')],
    /*
     * 语言表**不在这里** —— 它是 `data/languages.ts` 那一张(09-01 合表:
     * 「扩展名 → 语言 id」与「语言 id → grammar」从前分在两个文件里,漏加一处
     * 不报错、只表现为「怎么没上色」)。这里只把那张表的 grammar 那一列取出来。
     * 加一门语言 = 那张表加一行,这个文件一个字都不用改。
     *
     * 留账(如实说):shiki 的 `createHighlighterCore({ langs })` 收的是一组
     * promise,所以这十六份 grammar 是在**建高亮器那一刻一次性全拉**的,
     * 不是「用到哪门拉哪门」。改按需要走 `loadLanguage()`,那会让第一次遇到
     * 一门新语言时多一次异步往返(先素文本、随后上色)—— 可感知的行为变化,
     * 属拍板件。表已经按那条路铺好(`grammar` 是 thunk,不是求值过的 promise)。
     */
    langs: LANGUAGES.map((lang) => lang.grammar()),
  })
}

export const HIGHLIGHT_THEME = 'vitesse-light'

/** 一行 = 一串带色 token。素文本时返回 undefined(调用方照原样画字符串)。 */
export type HighlightedLines = readonly (readonly ThemedToken[])[]

/**
 * 同源不二染:同一段源码 + 同一种语言,只算一次。
 *
 * 流式期间一个代码块每帧长几个字符,源码每帧都不同,所以缓存**不是**为流式服务的;
 * 它挡的是「同一条历史消息反复上下滚」时的重复染色。上限一并写死:缓存不能变成
 * 一条永远不还的内存借条。
 */
const CACHE = new Map<string, HighlightedLines>()
const CACHE_MAX = 64

export function highlight(source: string, lang: string | null): HighlightedLines | undefined {
  if (!highlighter || !lang) return undefined
  const resolved = highlighter.getLoadedLanguages().includes(lang) ? lang : undefined
  if (!resolved) return undefined

  const key = `${resolved}\u0000${source}`
  const hit = CACHE.get(key)
  if (hit) return hit

  try {
    const { tokens } = highlighter.codeToTokens(source, { lang: resolved, theme: HIGHLIGHT_THEME })
    if (CACHE.size >= CACHE_MAX) CACHE.clear()
    CACHE.set(key, tokens)
    return tokens
  } catch {
    // 语法本身出问题(极少见)也只是没有颜色 —— 素文本永远是那个可用的答案。
    return undefined
  }
}

/** 只给测试用:模块级状态要能在用例之间归零。 */
export function resetHighlighterForTest(): void {
  highlighter = undefined
  loading = undefined
  CACHE.clear()
}

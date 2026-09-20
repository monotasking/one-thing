import { fnv1a } from '../hash'

/**
 * KaTeX —— **全仓唯一提到它的文件**。
 *
 * 库本体与它那张样式表都只在这里、而且都只出现在 `import()` 里,于是打包器把它们
 * 切成独立 chunk:主包一个字节都不沾,只有真的有人写了一条公式才拉(与 mermaid
 * 那一处逐字同一条纪律,理由在 `kinds/figure/mermaid.ts` 的头注)。别处要画公式,
 * 走 `useRenderedMath` / `renderTex`,不许再 import 一次 —— 多一个产地就多一份
 * 「选项是什么」的真相,而那些选项是安全判据。
 *
 * ── 拉库:记住成功,**不记住失败** ────────────────────────────────────────
 * `ready` 缓存那个 promise,一台上只拉一次;拉失败就把它忘掉,下一条公式再试一次。
 * 一次网络 / 磁盘抖动不该让这台从此没有公式(同 mermaid)。
 *
 * ── `isKatexReady()` 是给「首帧同步命中」用的 ─────────────────────────────
 * 消息行有 `content-visibility`、会话有停靠池,一条公式的组件会被反复挂载。若每次
 * 挂载都先画一帧源码再异步换成公式,人看见的就是滚动时满屏的抖动。所以库到了之后
 * `renderTex` 是**同步**的,组件在 render 里当场问它要结果。
 *
 * ── 选项是安全判据,所以逐条显式写出来 ────────────────────────────────────
 * TeX 源码是模型吐出来的任意文本,交给它排版的那一刻这几格就是边界:
 *
 *  · `trust: false`   —— `\href` / `\url` / `\includegraphics` / `\html*` 一律不执行,
 *                        KaTeX 把它们画成红色错误文字。**这是 `MathHtml` 敢把产物当
 *                        HTML 上屏的全部依据**(见那个文件的头注)。
 *  · `throwOnError: true` —— 语法错误抛出来由我们自己接,降级成「源码 + 一行原话」。
 *                        缺省(false)是在页面上画一段红字,那等于把失败态交给库去画,
 *                        而本仓的失败语义只有一个样子(源码永远可见)。
 *  · `strict: 'ignore'`   —— 「不够标准但画得出来」的写法(中文字符、`\over` 之类)
 *                        照画不报警。它不是安全项,是**不要把警告变成失败**。
 *  · `maxExpand: 1000`    —— 宏展开上限,挡住 `\def` 递归炸弹(KaTeX 自己的缺省是
 *                        1000,这里写出来是因为它是一条拒绝服务的闸,不该靠上游默认值)。
 *  · `maxSize: 50`        —— 单位尺寸上限(em),挡住 `\rule{99999em}{99999em}` 这种
 *                        把整条消息顶开的写法。
 *  · `output: 'htmlAndMathml'` —— 同时产出可视的 HTML 与给读屏用的 MathML;KaTeX 会
 *                        把前者标 `aria-hidden`,于是读屏念的是公式而不是一堆散字符。
 */

interface KatexApi {
  renderToString(tex: string, options: Readonly<Record<string, unknown>>): string
}

const KATEX_OPTIONS = {
  displayMode: false,
  throwOnError: true,
  trust: false,
  strict: 'ignore',
  maxExpand: 1000,
  maxSize: 50,
  output: 'htmlAndMathml',
} as const

let ready: Promise<KatexApi> | undefined
/** 拉到了的那一份。它同时是「此刻能不能同步渲」的那一格事实。 */
let api: KatexApi | undefined

export async function loadKatex(): Promise<KatexApi> {
  ready ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([module]) => {
      const katex = (module.default ?? module) as unknown as KatexApi
      api = katex
      return katex
    })
    .catch((thrown: unknown) => {
      // 记住失败会让这台永远没有公式;忘掉它,下一条公式重试一次。
      ready = undefined
      throw thrown
    })
  return ready
}

/** 库到了吗 —— 到了就意味着 `renderTex` 这一刻是同步的。 */
export function isKatexReady(): boolean {
  return api !== undefined
}

/** 一次渲染的结果。`message` 是 KaTeX 说的那句原话,不改写(与图种缓存同一条纪律)。 */
export type MathRendered =
  | { status: 'done'; html: string }
  | { status: 'error'; message: string }

const CACHE = new Map<string, MathRendered>()
/**
 * 上限。比图种那张表(32)大一档:一条消息里的公式常常是几十条,而每一条的产物
 * 只有几百字节 —— 而一张 mermaid 的 SVG 动辄几十 KB。满了整份清掉(不做 LRU:
 * 这张表是渲染的加速垫,不是内存账本,清空最坏也只是重渲一次)。
 */
const CACHE_MAX = 256

/**
 * 缓存键 = 档位 + TeX 长度 + TeX 哈希。
 *
 * 档位进键是硬的:同一段 `\sum` 在行内与居中两档下 KaTeX 产出的 HTML 不一样
 * (求和号的大小、上下标的落位),少了这一格两档会互相偷对方的结果。
 */
function cacheKey(tex: string, display: boolean): string {
  return `${display ? 'd' : 'i'}:${tex.length}:${fnv1a(tex)}`
}

/**
 * 渲一次(同源不二渲)。**库已经到了**才许调 —— 没到就抛,这不是降级路,
 * 调用方(`useRenderedMath`)负责先问 `isKatexReady()`。
 *
 * **失败也缓存**:同一段画不出来的 TeX 在屏幕上反复出现时,不该每次都再排一次版、
 * 再失败一次(同图种表那一条)。
 */
export function renderTex(tex: string, display: boolean): MathRendered {
  const key = cacheKey(tex, display)
  const hit = CACHE.get(key)
  if (hit) return hit

  const katex = api
  if (!katex) throw new Error('KaTeX 还没拉到 —— renderTex 只在 isKatexReady() 为真时可调')

  if (CACHE.size >= CACHE_MAX) CACHE.clear()
  let result: MathRendered
  try {
    result = { status: 'done', html: katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display }) }
  } catch (thrown) {
    result = { status: 'error', message: messageOf(thrown) }
  }
  CACHE.set(key, result)
  return result
}

function messageOf(thrown: unknown): string {
  if (thrown instanceof Error && thrown.message) return thrown.message
  return String(thrown)
}

/** 只给测试用:模块级的 promise 与缓存要能在用例之间归零(同 mermaid 的那一口)。 */
/** 只给测试用:守「未闭合的半截 TeX 不进缓存」那一条(useRenderedMath 的 `enabled`)。 */
export function mathCacheSizeForTest(): number {
  return CACHE.size
}

export function resetKatexForTest(): void {
  ready = undefined
  api = undefined
  CACHE.clear()
}

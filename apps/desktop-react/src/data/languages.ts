/**
 * **语法高亮的语言表 —— 加一门语言只动这一行**(09-01 用户定的交卷判据)。
 *
 * ── 修前是两处,而且会**静默**分叉 ────────────────────────────────────────
 * 从前「扩展名 → 语言 id」在 `data/files-source.ts` 的 `LANG_BY_EXT` 里,
 * 「语言 id → grammar」在 `content/code/highlight.ts` 的 `langs`
 * 数组里。两处都要加,而漏掉任何一处的后果都**不报错**:
 *  · 只加扩展名表 → 高亮器不认得这个 id,`getLoadedLanguages()` 里没有它,
 *    `highlight()` 回 undefined,屏幕上是一片没上色的素文本;
 *  · 只加 grammar → 没有扩展名指向它,那份 grammar 白打进包里。
 * 两种都不会红,只会「怎么没上色」——那正是最贵的一类 bug。
 *
 * ── 修后:一行说三件事 ──────────────────────────────────────────────────
 * 每一行 = **认哪些扩展名** + **叫什么(shiki 的语言 id)** + **grammar 从哪儿拉**。
 * 于是「加一门语言」是一次编辑:在下面这张表里加一行。两个消费方各取所需:
 *   · `files-source.langOfPath` 取「扩展名 → id」(查看器与代码块共用它);
 *   · `content/code/highlight.ts` 的 `createHighlighter` 取那一串 `grammar()`。
 * 对不上由 `__tests__/languages.test.ts` 钉着(表里每一行都得两头都有)。
 *
 * ── grammar 是**按需拉的**,不是全量内置 ──────────────────────────────────
 * `grammar` 是一个 thunk(`() => import('shiki/langs/x.mjs')`),这个模块自己
 * **不 import shiki 一个字节** —— 它是纯数据,node 里加载它零副作用。真正的
 * 动态 import 发生在高亮器被拉起来的时候(`loadHighlighter`,懒加载且失败不抛)。
 * 打包器把每一份 grammar 切成各自的 chunk,首屏一份都不下载。
 *
 * 留账(如实说):今天这十六份 grammar 是在**建高亮器那一刻一次性全拉**的
 * (shiki 的 `createHighlighterCore({ langs })` 收的就是一组 promise)。要做到
 * 「用到哪门才拉哪门」得改成 `loadLanguage()` 的按需路径 —— 那会让第一次遇到
 * 一门新语言时多一次异步往返(屏幕上先素文本、随后上色),属可感知的行为变化,
 * 拍板件。表已经按那条路铺好:`grammar` 是 thunk,不是求值过的 promise。
 */

export interface LanguageSpec {
  /** shiki 的语言 id(也是 `ChatStream` 代码块围栏里写的那个名字)。 */
  id: string
  /** 认哪些扩展名(小写,不带点)。 */
  exts: readonly string[]
  /**
   * grammar 从哪儿拉。**thunk**,所以这个模块本身零副作用。
   *
   * 类型故意宽松(`Promise<any>`):这个文件是**数据**,不该 import shiki 的
   * 类型 —— 那会把一条 `import type` 边从 data/ 拉到高亮器身上,而 data/ 里
   * 别的模块(node 侧的门与纯函数测试)是不该认识 shiki 的。
   * 形状对不对由消费方那一侧的类型来判(`createHighlighterCore({ langs })`)。
   */
   
  grammar: () => Promise<any>
}

export const LANGUAGES: readonly LanguageSpec[] = [
  { id: 'typescript', exts: ['ts', 'mts', 'cts'], grammar: () => import('shiki/langs/typescript.mjs') },
  { id: 'tsx', exts: ['tsx'], grammar: () => import('shiki/langs/tsx.mjs') },
  { id: 'javascript', exts: ['js', 'mjs', 'cjs'], grammar: () => import('shiki/langs/javascript.mjs') },
  { id: 'jsx', exts: ['jsx'], grammar: () => import('shiki/langs/jsx.mjs') },
  { id: 'json', exts: ['json'], grammar: () => import('shiki/langs/json.mjs') },
  { id: 'python', exts: ['py'], grammar: () => import('shiki/langs/python.mjs') },
  { id: 'bash', exts: ['sh', 'bash', 'zsh'], grammar: () => import('shiki/langs/bash.mjs') },
  { id: 'css', exts: ['css'], grammar: () => import('shiki/langs/css.mjs') },
  { id: 'html', exts: ['html', 'htm'], grammar: () => import('shiki/langs/html.mjs') },
  { id: 'markdown', exts: ['md', 'markdown'], grammar: () => import('shiki/langs/markdown.mjs') },
  { id: 'sql', exts: ['sql'], grammar: () => import('shiki/langs/sql.mjs') },
  { id: 'yaml', exts: ['yml', 'yaml'], grammar: () => import('shiki/langs/yaml.mjs') },
  { id: 'go', exts: ['go'], grammar: () => import('shiki/langs/go.mjs') },
  { id: 'rust', exts: ['rs'], grammar: () => import('shiki/langs/rust.mjs') },
  { id: 'java', exts: ['java'], grammar: () => import('shiki/langs/java.mjs') },
  { id: 'diff', exts: ['diff', 'patch'], grammar: () => import('shiki/langs/diff.mjs') },
]

/**
 * 扩展名 → 语言 id 的展开表。**由上面那张表算出来**,不是第二份手写清单 ——
 * 手写的第二份就是从前那个 `LANG_BY_EXT`,而它正是分叉的来源。
 */
const ID_BY_EXT: Record<string, string> = Object.fromEntries(
  LANGUAGES.flatMap((lang) => lang.exts.map((ext) => [ext, lang.id])),
)

/**
 * 这个扩展名用哪门语言高亮。表里没有的一律 null = **素文本**,那不是错误,
 * 是这台不认识它(高亮器的语言表本来就是固定的一小撮)。
 */
export function languageIdOfExtension(ext: string): string | null {
  return ID_BY_EXT[ext.toLowerCase()] ?? null
}

/**
 * 一条路径用哪门语言高亮 —— 上面那张表的**唯一一条**「按路径问」的委托。
 *
 * 2026-09-13 批 ② 从 `files-source.ts` 搬来:那时它只服务查看器与文件面,住在
 * 数据层的那只大模块(zustand store、端口、通知、i18n)里不碍事;聊天里的 diff 块
 * 接高亮之后它多了一个消费者,而一块 markdown 代码不该为了问一句「这是什么语言」
 * 把整条文件数据层拖进消息列表的渲染路上。`files-source` 那边只剩一行再导出,
 * 所有旧 import 与两处用例一个字不用改。
 *
 * 没有扩展名(`Makefile`)、以点开头(`.gitignore`)、表里没有的一律 null = 素文本。
 */
export function langOfPath(path: string): string | null {
  const trimmed = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path
  const at = trimmed.lastIndexOf('/')
  const name = at < 0 ? trimmed : trimmed.slice(at + 1) || trimmed
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return languageIdOfExtension(name.slice(dot + 1))
}

/**
 * **「这个符号在第几行」** —— 一只策略对象,今天只有一个实现(正本
 * `docs/design/reference-tag-2026-09.md` §2.7)。
 *
 * ── 为什么是策略,而不是一个函数 ───────────────────────────────────────────
 * 这台上迟早会有别的答法:语言服务器、检索索引里那张符号表、甚至后端现解一遍
 * AST。到那一天换的是**实现**,调用方(`openFileAt` 那一句)一个字不动。
 * 写成一个自由函数也能换,但那时「换」的形状是改 import —— 而这一格的语义正是
 * 「同一个问题有好几个答法,哪个在岗是装配的事」。
 *
 * ── 它答的是**行号,不是保证** ─────────────────────────────────────────────
 * 模型给的 symbol 可能已经被改名了,文件也可能已经变了。找不到就答 `null`,
 * 调用方退到 `line`、再退到只打开 —— **不报错、不 toast**:那不是用户的错,
 * 而一条「找不到 parseToken」的提示对他毫无用处(他要的是那份文件)。
 *
 * ── 纯函数,零 import ─────────────────────────────────────────────────────
 * 收一段文本、一个名字、一个行号,答一个行号。它不认识查看器、不认识 store,
 * 所以它的单测就是一张表(定义形 / 方法形 / 赋值形 / 兜底 / 正则元字符)。
 */

export interface SymbolLocator {
  /**
   * @param text     整份文件的正文。
   * @param symbol   要找的名字。
   * @param nearLine 一个提示行(1 基)。给了就在所有命中里取**离它最近的那一处**
   *                 —— 标签同时给了 `line` 与 `symbol` 时,行号说的是「我指的是
   *                 这一带的那一个」,而不是另一个答案。
   * @returns 1 基行号;找不到 = `null`。
   */
  locate(text: string, symbol: string, nearLine?: number): number | null
}

/**
 * 定义那几个关键词。**跨语言的一张表,不按后缀分档**:一份 `.ts` 里写得出
 * `struct`(注释、字符串、内嵌的别的语言),而按后缀分档要先有一张「后缀 → 语言」
 * 的表,那是第二份真相。多认几个关键词的代价是零 —— 它们都要求后面紧跟这个名字。
 */
const DEFINITION_KEYWORDS = [
  'function',
  'class',
  'const',
  'let',
  'var',
  'def',
  'fn',
  'func',
  'type',
  'interface',
  'struct',
  'enum',
  'trait',
  'impl',
  'module',
  'namespace',
  'package',
]

/** 正则元字符转义 —— 符号名里真的会有 `$store`、`operator+`、`a.b`。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 一个名字的**词边界**不能用 `\b`:`\b` 的字集是 `[A-Za-z0-9_]`,而 `$store`
 * 的第一个字符不在里面(于是 `\b\$store\b` 在 `let $store =` 上压根不命中),
 * `operator+` 的最后一个字符也不在里面。所以两边各自手写一条**负向**断言:
 * 前面不是标识符字符,后面也不是。
 */
function wordPattern(symbol: string, flags = 'g'): RegExp {
  const escaped = escapeRegExp(symbol)
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, flags)
}

/**
 * 这一行**有多像这个名字的定义**。三档,数字越小越像:
 *
 *  1. **关键词形** `function 名` / `class 名` / `const 名` / `def 名` …
 *     —— 这一档是真的说了「这里定义它」,没有第二种读法;
 *  2. **形状形** `名(` / `名 =` / `名 :=` / `名:`
 *     —— 方法声明、箭头函数、对象字面量的一格。**它与「一处调用」在纯文本上
 *     分不开**(`parseToken(a)` 与 `parseToken(s) {}` 只差后面那几个字),所以
 *     它排在关键词形之后:一处调用永远不比它的定义更像「我指的是这个符号」;
 *  3. **只是提到** —— 整词出现过。
 *
 * 分档而不是一个布尔,正是为了上面那一句:同一个名字在一份文件里既被调用又被
 * 定义是常态,而 `parseToken(a)` 这一行会命中第 2 档 —— 要是与关键词形同档,
 * 「先遇到的赢」就会把答案交给那处调用。
 *
 * 三档都要求**整词**命中,所以 `parseToken` 不会被 `parseTokenList` 钓走。
 */
type DefinitionRank = 1 | 2 | 3

function rankOfLine(line: string, symbol: string): DefinitionRank | null {
  const word = wordPattern(symbol, '')
  const at = word.exec(line)
  if (!at) return null

  const before = line.slice(0, at.index)
  const after = line.slice(at.index + symbol.length)

  // ① 关键词 + 名字。关键词与名字之间只许空白(`export const 名` 里 `export`
  //    在更前面,不影响 —— 判的是**紧挨着名字的那一个词**)。
  const lead = /([A-Za-z_][A-Za-z0-9_]*)\s+$/.exec(before)
  if (lead && DEFINITION_KEYWORDS.includes(lead[1])) return 1

  // ② 名字后面紧跟一个左括号 —— 方法 / 函数。允许中间有空白与泛型参数。
  if (/^\s*(<[^<>]*>)?\s*\(/.test(after)) return 2

  // ③ 赋值形。`==` / `=>` / `>=` 都不是赋值,所以后面那个字符不许是 `=` 或 `>`。
  if (/^\s*:?=(?![=>])/.test(after)) return 2

  // ④ `名:` —— 但不是三元 / 标签之外的冒号:要求它后面还有东西(类型 / 值)。
  if (/^\s*:\s*\S/.test(after)) return 2

  return 3
}

/** `|nearLine - line|`,没给提示行时一律同分(于是「第一处」赢)。 */
function distance(line: number, nearLine: number | undefined): number {
  return nearLine === undefined ? 0 : Math.abs(line - nearLine)
}

/**
 * 在一组命中里挑一个:**离提示行最近的那一处**,同距取**靠前**的那一处
 * (`<` 而不是 `<=`,所以先遇到的赢 —— 结果与遍历序无关地稳定)。
 */
function pick(lines: readonly number[], nearLine: number | undefined): number | null {
  let best: number | null = null
  let bestGap = Number.POSITIVE_INFINITY
  for (const line of lines) {
    const gap = distance(line, nearLine)
    if (gap < bestGap) {
      best = line
      bestGap = gap
    }
  }
  return best
}

/**
 * **今天唯一那只实现**:按文本找。
 *
 * 三档各收一份命中,**从最像的那一档里挑**(同档才比 `nearLine`)。分档挑而不是
 * 把三档拌在一起比距离,是因为它们答的是三个程度不同的问题 —— 第一档有命中就
 * 绝不看后面的,哪怕后面那一处离提示行更近。判词整段在 `rankOfLine` 上。
 */
export const textSymbolLocator: SymbolLocator = {
  locate(text, symbol, nearLine) {
    const wanted = symbol.trim()
    if (!text || !wanted) return null

    const lines = text.split('\n')
    const buckets: Record<DefinitionRank, number[]> = { 1: [], 2: [], 3: [] }
    const word = wordPattern(wanted)

    for (let i = 0; i < lines.length; i += 1) {
      // 整词都不在这一行里就一档都不必判(绝大多数行走的是这一支)。
      word.lastIndex = 0
      if (!word.test(lines[i])) continue
      const rank = rankOfLine(lines[i], wanted)
      if (rank !== null) buckets[rank].push(i + 1)
    }

    return pick(buckets[1], nearLine) ?? pick(buckets[2], nearLine) ?? pick(buckets[3], nearLine)
  },
}

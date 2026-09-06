/**
 * **markdown → 屏上那串字**,带偏移映射(检索面终稿 R8 / §4)。
 *
 * 起因是 09-05 用户在真机检索面上看到的那一屏:摘要与预览标题里 `**` 、反引号、
 * `###` 、围栏原样露着 —— 行上的字**是给人读的一句话**,不是源码。剥记号这件事
 * 从前一处都没有,于是每个产地各自 `replace` 一遍就会长出好几个「什么算记号」。
 * 这个文件是那件事的**唯一产地**。
 *
 * ## 为什么要偏移映射,而不是 「把两个星号 replace 掉」
 *
 * 高亮区间必须相对**屏上那串字**(R7)。剥掉记号之后每一个字的下标都变了,没有
 * 映射就只能在剥过的串上重新跑一遍匹配 —— 那是第二个「什么算命中」的产地,也正是
 * 壳里禁止再 `indexOf` 一遍的同一条判例。所以这里与 `analyzer/normalize.ts` 的
 * `perCodePoint` **同形**:产 `{ source, text, map }`,`map[i]` = 输出第 i 个字符在
 * 输入里的下标,长度 = `text.length + 1`。`mapOffsetToSource` / `mapRangeToSource`
 * 直接吃它。
 *
 * ## 幂等
 *
 * `toDisplayText(toDisplayText(x).text).text === toDisplayText(x).text` ——
 * 剥过的串里没有记号可剥。这是它能**同时**站在两处的前提:索引写路上的
 * `plainTextFilter`(`index/filters.ts`,正文进倒排之前就洗)与查询路上的
 * `snippetOf`(老索引里还留着记号的那些文档)。两处都跑,不会互相打架。
 *
 * ## 认哪些记号(认不出的一律**原样留着**)
 *
 * 行首:`#` 标题、`>` 引用、`- ` / `* ` / `1. ` 列表项、`---` 分隔线(整行丢)、
 * ``` / ~~~ 围栏(丢掉围栏行本身,**围栏里的内容原样保留**,里面不再剥行内记号 ——
 * 代码里的 `*` 是代码)。
 * 行内:`**` / `__` / `*` / `_` / `~~` 强调、反引号、`[文字](链接)` 取文字、
 * `![说明](图)` 取说明、`\*` 转义取被转义的那个字。
 *
 * **`_` 与 `*` 只在词边界上才算记号**:`get_user_profile` 里的下划线两侧都是字母,
 * 剥掉它就成了 `getuserprofile` —— 那正是 `normalize.ts` 里「小写不能发生在切词
 * 之前」栽过的同一个跟头。判据写在 `isEmphasisRun` 里。
 */

import type { NormalizedText, TextRange } from '@onething/core/search'

/** 行首那几种记号:标题 / 引用 / 列表项 / 有序列表项。 */
const LINE_PREFIX = /^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/
/** 分隔线:`---` / `***` / `___`,整行丢。 */
const THEMATIC_BREAK = /^[ \t]{0,3}(?:-[ \t]*){3,}$|^[ \t]{0,3}(?:\*[ \t]*){3,}$|^[ \t]{0,3}(?:_[ \t]*){3,}$/
/** 围栏行:``` 或 ~~~ 起头(后面可以跟语言名)。 */
const FENCE = /^[ \t]{0,3}(?:```|~~~)/

/**
 * 词边界判据里的「词内字符」——**只算 ASCII 字母数字**,不是 `\p{L}`。
 *
 * 用 `\p{L}` 是错的:`**身份牌**` 的闭号两侧都是汉字,于是它被当成正文留在屏上
 * (2026-09-06 实测)。CJK 没有词间空格,**每一个字都是词**,所以记号贴着汉字时
 * 就是记号 —— 这与分析器那一侧「CJK 逐字切」是同一句话。代价是重音拉丁
 * (`café*x*`)会被当边界,那一侧宁可多剥一个记号,也不能让 `**` 上屏。
 */
function isAlphanumeric(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char)
}

/**
 * 逐字符搬运 + 记映射的小工具。`keep` 搬一个字符并记下它的来处,`skip` 只推进
 * 输入下标 —— 「剥掉」在这里就是「不 keep」,没有第二种写法。
 */
class MappedBuilder {
  private readonly out: string[] = []
  private readonly map: number[] = []

  keep(char: string, at: number): void {
    this.out.push(char)
    this.map.push(at)
  }

  finish(source: string): NormalizedText {
    this.map.push(source.length)
    return { source, text: this.out.join(''), map: this.map }
  }
}

/**
 * 这一串 `*` / `_` / `~` 是强调记号还是正文里的字符?
 *
 * 判据是**词边界**:强调的开号左边不是字母数字、闭号右边不是字母数字。两边都夹在
 * 字母数字中间(`get_user`、`2*3`)的一律当正文。
 */
function isEmphasisRun(source: string, start: number, end: number): boolean {
  return !isAlphanumeric(source[start - 1]) || !isAlphanumeric(source[end])
}

/** 一段**非围栏**正文的行内记号剥除。`offset` 是这一段在原文里的起点。 */
function stripInline(source: string, from: number, to: number, out: MappedBuilder): void {
  let i = from
  while (i < to) {
    const char = source[i]!

    // 转义:`\*` → `*`(记号本身不出,被转义的那个字照出)。
    if (char === '\\' && i + 1 < to && /[\\`*_~[\]()#+\-.!>]/.test(source[i + 1]!)) {
      out.keep(source[i + 1]!, i + 1)
      i += 2
      continue
    }

    // 反引号:一律是记号(行内代码的边界),内容照出。
    if (char === '`') {
      while (i < to && source[i] === '`') i += 1
      continue
    }

    // 强调:同一个字符的连排一起判。
    if (char === '*' || char === '_' || char === '~') {
      let run = i
      while (run < to && source[run] === char) run += 1
      if (isEmphasisRun(source, i, run)) {
        i = run
        continue
      }
      // 不是记号 —— 原样搬,一个都不吞。
      for (; i < run; i += 1) out.keep(source[i]!, i)
      continue
    }

    // 图片 `![说明](图)`:`!` 与 `[` 一起丢,说明照出。
    if (char === '!' && source[i + 1] === '[') {
      i += 2
      continue
    }

    if (char === '[') {
      i += 1
      continue
    }

    // `](链接)` / `][引用]`:整段目标丢掉,前面那段文字已经搬过了。
    if (char === ']' && (source[i + 1] === '(' || source[i + 1] === '[')) {
      const close = source[i + 1] === '(' ? ')' : ']'
      let at = i + 2
      while (at < to && source[at] !== close) at += 1
      i = at < to ? at + 1 : to
      continue
    }
    if (char === ']') {
      i += 1
      continue
    }

    out.keep(char, i)
    i += 1
  }
}

/**
 * markdown → 屏上那串字 + 回原文的路。
 *
 * 输入不是 markdown(命令名、文件名、一句白话)时**恒等** —— 没有记号可剥,
 * 于是 `text === source` 且 `map` 是恒等映射。
 */
export function toDisplayText(source: string): NormalizedText {
  const out = new MappedBuilder()
  let at = 0
  let inFence = false

  while (at <= source.length) {
    const lineEnd = source.indexOf('\n', at)
    const end = lineEnd < 0 ? source.length : lineEnd
    const line = source.slice(at, end)

    if (FENCE.test(line)) {
      // 围栏行本身连同它的换行一起丢 —— 留一个空行等于在正文里凭空多一行。
      inFence = !inFence
      at = end + 1
      if (lineEnd < 0) break
      continue
    }

    if (inFence) {
      // 围栏里是代码:一个字符都不动(里面的 `*` 是代码,不是强调)。
      for (let i = at; i < end; i += 1) out.keep(source[i]!, i)
    } else if (THEMATIC_BREAK.test(line)) {
      at = end + 1
      if (lineEnd < 0) break
      continue
    } else {
      const prefix = LINE_PREFIX.exec(line)
      const bodyFrom = at + (prefix === null ? 0 : prefix[0].length)
      stripInline(source, bodyFrom, end, out)
    }

    if (lineEnd < 0) break
    out.keep('\n', end)
    at = end + 1
  }

  return out.finish(source)
}

/**
 * 剥过记号的坐标 → 原文坐标,**右端不吃掉紧跟着的记号**。
 *
 * 不能直接用 `mapRangeToSource`:那只把 `end` 映到「输出第 end 个字符的来处」,
 * 而剥掉的记号恰好排在中间 —— `前面 **命中词** 后面` 里 `命中词` 的右端会映到那两个
 * 星号之后的空格上,高亮于是多标一截 `**`(2026-09-06 实测)。
 *
 * 这里改成「最后一个**在区间内**的字符的来处 + 1」:`toDisplayText` 逐**码元**搬运,
 * 一个输出字符恰好来自一个输入字符,所以那个 +1 是准的。
 */
export function mapDisplayRangeToSource(plain: NormalizedText, range: TextRange): TextRange {
  if (range.end <= range.start) {
    const at = plain.map[range.start] ?? plain.source.length
    return { start: at, end: at }
  }
  const start = plain.map[range.start] ?? plain.source.length
  const last = plain.map[range.end - 1] ?? plain.source.length
  return { start, end: Math.min(plain.source.length, last + 1) }
}

/** 只要那串字的便捷口(索引写路上的 `plainTextFilter` 用它)。 */
export function plainTextOf(source: string): string {
  return toDisplayText(source).text
}

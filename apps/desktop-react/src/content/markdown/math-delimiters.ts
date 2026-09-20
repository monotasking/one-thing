import { closeFence, openFence, TEX_BLOCK_CLOSE, TEX_BLOCK_OPEN, type OpenFence } from './fences'

/**
 * **TeX 风格定界符 → `$$`,等长归一**。
 *
 * 解析器那一侧只认 `$…$` / `$$…$$`(micromark-extension-math 的两形),而模型实际
 * 吐出来的一大半是 TeX 那四个:`\(…\)`(行内)与 `\[…\]`(块)。这个函数把后者
 * 原地换成前者,**换完之后每一个字符的下标与换之前逐字相同**。
 *
 * ── 等长是硬约束,不是巧合 ────────────────────────────────────────────────
 * 源偏移是这套系统的地基:块的身份号由它派生(`${offset}:${kind}`)、增量解析的
 * 切点按它验证、降级与「查看源码」按它回读**作者写的原文**。所以归一只做「两个
 * 字符换两个字符」这一件事 —— `\(`→`$$`、`\)`→`$$`、`\[`→`$$`、`\]`→`$$`,一个
 * 都不增不删。解析吃归一文本,翻译表吃**原文**(见 parse.ts),于是屏幕上落回
 * 源码的地方仍然是作者的那几个字节。这条有一条性质测试守着。
 *
 * ── 四处不换 ──────────────────────────────────────────────────────────────
 * ① 围栏代码里(``` / ~~~)—— 判据与稳定切点共用一张表(fences.ts),不抄第二份;
 * ② 数学围栏里 —— 里面是 TeX 正文,`\(` 是它自己的字;
 * ③ 同一行的行内码里(反引号成对的那一段)—— `` `\(x\)` `` 是一段代码,不是公式;
 * ④ `\\(` —— 前面那个反斜杠已经把自己转义掉了,后面的 `(` 是个普通括号。扫描时
 *    遇到 `\\` 跳两格,这一条就自动成立。
 *
 * ── 成对才换(行内),独占一行无条件换(块) ──────────────────────────────
 * 行内 `\(…\)` 与 `\[…\]` 必须**同一行成对**才换:半截的定界符是作者写的普通转义,
 * 换掉它等于凭空造一个公式。块那一档相反 —— trim 之后恰好是 `\[` 的一行**无条件**
 * 换成 `$$`,不等它的 `\]` 到。理由是流式:前缀的归一结果不许被后面到的字符改掉,
 * 而「等配对」意味着同一行在收到下文之后换一种译法,屏幕上就会出现一次回跳。
 * `\]` 那一行只在「`\[` 开的围栏正开着」时换 —— 判据整条在 fences.ts。
 *
 * ── 已知并接受的一处误伤 ──────────────────────────────────────────────────
 * markdown 里 `\[` 也是「一个字面左方括号」的写法。所以 `\[不是链接\]` 这种**成对**
 * 的转义会被当成行内公式换掉,屏幕上从 `[不是链接]` 变成一段公式。这是这套归一的
 * 代价,记在这里:要治它得先知道「这一处 TeX 还是转义」,而那正是没有上下文就
 * 答不出的问题;而真实语料里 `\[…\]` 十次有九次半是公式。
 *
 * ── 行内码判据是**按行**的浅判断 ──────────────────────────────────────────
 * CommonMark 的代码跨度可以跨行,这里只在一行之内配对反引号;转义反引号(`` \` ``)
 * 也不参与判断。认错的代价是「某一处该换的没换 / 不该换的换了」,不是解析崩掉 ——
 * 与图种类型词那条浅判断同一种取舍。
 */
export function normalizeMathDelimiters(text: string): string {
  // 快路:一个反斜杠都没有 = 四种定界符一个都不可能出现。流式期间这个函数每次真
  // 解析跑一次,绝大多数文本走的是这一条。
  if (!text.includes('\\')) return text

  let out = ''
  let fence: OpenFence | undefined
  let pos = 0

  // 手动切行(不 split 造数组)—— 理由同 stable-cut:每帧一次,不该每帧造一个行数组。
  while (pos <= text.length) {
    let lineEnd = text.indexOf('\n', pos)
    const atEof = lineEnd === -1
    if (atEof) lineEnd = text.length
    const line = text.slice(pos, lineEnd)

    const stepped = step(line, fence)
    out += stepped.out
    fence = stepped.fence

    if (atEof) break
    out += '\n'
    pos = lineEnd + 1
  }

  return out
}

/** 一行 → 归一后的那一行 + 走完这一行之后围栏的状态。 */
function step(line: string, fence: OpenFence | undefined): { out: string; fence: OpenFence | undefined } {
  if (fence) {
    if (!closeFence(line, fence)) return { out: line, fence }
    // `\]` 收尾的那一行本身也要换成 `$$`,否则解析器看不见收尾。
    const at = fence.id === 'math' && line.trim() === TEX_BLOCK_CLOSE ? line.indexOf(TEX_BLOCK_CLOSE) : -1
    return { out: at < 0 ? line : swap(line, at), fence: undefined }
  }

  const opened = openFence(line)
  if (opened) {
    const at = opened.marker === TEX_BLOCK_OPEN ? line.indexOf(TEX_BLOCK_OPEN) : -1
    return { out: at < 0 ? line : swap(line, at), fence: opened }
  }

  return { out: normalizeInline(line), fence: undefined }
}

/** 把 `line` 里从 `at` 起的那两个字符换成 `$$`。等长 —— 这个函数是那条不变量的落点。 */
function swap(line: string, at: number): string {
  return `${line.slice(0, at)}$$${line.slice(at + 2)}`
}

/** 一行之内的 `\(…\)` / `\[…\]`:成对才换。 */
function normalizeInline(line: string): string {
  if (!line.includes('\\')) return line

  const spans = codeSpans(line)
  /** 每一个要换成 `$$` 的两字符起点。 */
  const hits: number[] = []
  let i = 0

  while (i < line.length) {
    const skip = spanEndAt(spans, i)
    if (skip !== undefined) {
      i = skip
      continue
    }
    if (line[i] !== '\\') {
      i += 1
      continue
    }
    const next = line[i + 1]
    if (next === '\\') {
      // 被转义的反斜杠 —— 它后面那个字符是普通字符,整对跳过(不换的第 ④ 条)。
      i += 2
      continue
    }
    if (next === '(' || next === '[') {
      const close = findClose(line, i + 2, next === '(' ? ')' : ']', spans)
      if (close !== undefined) {
        hits.push(i, close)
        i = close + 2
        continue
      }
    }
    // 别的转义(`\*` `\_` `\|` …)整对跳过:`\*` 里的 `*` 不该被当成下一轮的起手。
    i += 2
  }

  if (hits.length === 0) return line
  let out = ''
  let cursor = 0
  for (const at of hits) {
    out += line.slice(cursor, at)
    out += '$$'
    cursor = at + 2
  }
  return out + line.slice(cursor)
}

/** 从 `from` 起找同一行里的 `\)` / `\]`;找不到就是没配上对。 */
function findClose(line: string, from: number, want: string, spans: readonly CodeSpan[]): number | undefined {
  let k = from
  while (k < line.length) {
    const skip = spanEndAt(spans, k)
    if (skip !== undefined) {
      k = skip
      continue
    }
    if (line[k] !== '\\') {
      k += 1
      continue
    }
    const next = line[k + 1]
    if (next === '\\') {
      k += 2
      continue
    }
    if (next === want) return k
    k += 2
  }
  return undefined
}

/** 一段行内码在这一行里占的区间 `[start, end)`(含两侧的反引号)。 */
interface CodeSpan {
  readonly start: number
  readonly end: number
}

/**
 * 一行里的行内码跨度。判据是 CommonMark 那条:一串 n 个反引号,由**恰好** n 个
 * 反引号收尾;收不了尾的那一串就是普通字符。
 */
function codeSpans(line: string): CodeSpan[] {
  if (!line.includes('`')) return []
  const spans: CodeSpan[] = []
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') {
      i += 1
      continue
    }
    let run = 0
    while (line[i + run] === '`') run += 1

    let k = i + run
    let close = -1
    while (k < line.length) {
      if (line[k] !== '`') {
        k += 1
        continue
      }
      let other = 0
      while (line[k + other] === '`') other += 1
      if (other === run) {
        close = k
        break
      }
      k += other
    }

    if (close < 0) {
      i += run
      continue
    }
    spans.push({ start: i, end: close + run })
    i = close + run
  }
  return spans
}

/** 下标 `i` 落在某段行内码里吗?落在里面就交出该跳到哪儿(那一段的结尾)。 */
function spanEndAt(spans: readonly CodeSpan[], i: number): number | undefined {
  for (const span of spans) {
    if (i < span.start) return undefined
    if (i < span.end) return span.end
  }
  return undefined
}

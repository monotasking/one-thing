/**
 * 裸路径的 autolink 候选式(docs/design/message-references-2026-08.md §4.3 / §8)。
 *
 * P0 只在**行内代码**里跑 —— 那是模型写路径最常见的地方,且内容短、边界清楚。
 * 正文裸路径留给 P3,因为误链接化的代价(一句话里半个词变成链接)比漏链接大。
 *
 * 判据保守到"宁可漏":候选必须是一段不含空白的 token,且
 *   - 绝对路径 / `~/` / Windows 盘符路径,或
 *   - 相对路径且**带扩展名或带行号**(`src/foo.ts`、`src/foo:12`)。
 */
import { parseReference, type FileReference } from './parse'

export interface PathSpan {
  start: number
  end: number
  ref: FileReference
}

const TOKEN_RE = /\S+/g
/** 末尾的句读不属于路径:`见 /a/b.ts。` 里那个句号不能被吃进去。 */
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}"'、,。;:!?)】」》]+$/
const EXTENSION_RE = /\.[A-Za-z0-9]{1,8}$/

function stripTrailingPunctuation(token: string): string {
  let value = token
  for (;;) {
    // `a.ts:12` 结尾的冒号+数字是行号,别被当成句读剥掉。
    if (/:\d+$/.test(value) || /#L\d+(-L?\d+)?$/i.test(value)) return value
    const stripped = value.replace(TRAILING_PUNCTUATION_RE, '')
    if (stripped === value) return value
    if (!stripped) return ''
    value = stripped
  }
}

/**
 * 裸绝对路径的"已知根":`/api/files/read` 这种 HTTP 路由在行内代码里和文件路径长得
 * 一模一样,只靠前导 `/` 分不开。绝对路径要么落在这些根下,要么带扩展名/行号。
 * (设计文档 §8 的判据,正文与行内代码同一把尺。)
 */
const KNOWN_ABSOLUTE_ROOTS_RE =
  /^\/(Users|home|root|tmp|private|var|etc|opt|usr|bin|sbin|dev|mnt|srv|Volumes|Applications|Library|System)(\/|$)/

function looksLikeCandidate(token: string): boolean {
  if (!token || token.includes('://')) return false
  if (token.startsWith('//')) return false
  if (token.startsWith('~/')) return true
  if (/^[A-Za-z]:[\\/]/.test(token)) return true
  // 裸文件名不链接(与域名同形,见 parse.ts 的裁定);至少要有一层目录。
  if (!token.includes('/')) return false
  if (token.startsWith('./') || token.startsWith('../')) return true
  const withoutPosition = token.replace(/(:\d+(:\d+|-\d+)?|#L\d+(-L?\d+)?)$/i, '')
  if (token.startsWith('/')) {
    // 绝对路径:已知根 / 扩展名 / 行号 三者取一,否则当作路由或占位符放过。
    if (KNOWN_ABSOLUTE_ROOTS_RE.test(token)) return true
    if (withoutPosition !== token) return true
    return EXTENSION_RE.test(withoutPosition)
  }
  // 相对路径要么带扩展名,要么带行号 —— 否则 `and/or` 这种词组也会中招。
  if (withoutPosition !== token) return true
  return EXTENSION_RE.test(withoutPosition)
}

/**
 * 找出 `text` 里所有像文件路径的片段。返回的区间是**原文**上的下标(含起、不含终)。
 */
export function findPathSpans(text: string): PathSpan[] {
  if (!text) return []
  const spans: PathSpan[] = []
  TOKEN_RE.lastIndex = 0
  for (let match = TOKEN_RE.exec(text); match; match = TOKEN_RE.exec(text)) {
    const token = match[0]
    const trimmed = stripTrailingPunctuation(token)
    if (!trimmed || !looksLikeCandidate(trimmed)) continue
    const ref = parseReference(trimmed, { allowRelative: true })
    if (ref?.kind !== 'file') continue
    spans.push({ start: match.index, end: match.index + trimmed.length, ref })
  }
  return spans
}

/**
 * 行内代码整段就是一条路径时返回它的引用,否则 `null`。
 *
 * 只认"整段"是刻意的:`code_inline` 的渲染要么整块外包一层锚点,要么原样不动。
 * 拆开 code 内的文本会把高亮、复制、以及 say 折叠的行数统计全部搅乱。
 */
export function wholePathReference(text: string): FileReference | null {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  const spans = findPathSpans(trimmed)
  if (spans.length !== 1) return null
  const [span] = spans
  if (span.start !== 0 || span.end !== trimmed.length) return null
  return span.ref
}

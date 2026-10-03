/**
 * snippet:从字段开一扇 120 字的窗,区间指原文。
 *
 * 设计:docs/design/search-index-2026-09.md §6.5 / §5.1 末段
 *
 * 摘要不回读账本 —— 正文就存在文档表的 `fields` 里(真库正文总共 7MB)。这里做的
 * 只有两件事:挑一扇装得下最多命中的窗,把命中区间**经偏移映射转回原文**再切。
 * 高亮永远指用户看得见的那串字,不指归一化后的串。
 */

import type { TextRange } from '../candidate.js'
import type { NormalizedText } from '../analyzer/normalize.js'
import { mapRangeToSource } from '../analyzer/normalize.js'
import type { Token } from '../analyzer/types.js'

export const DEFAULT_SNIPPET_WIDTH = 120

export interface Snippet {
  text: string
  /** 相对 `text` 的高亮区间 */
  ranges: TextRange[]
  /** 窗口在原文里的起点(壳要「跳到原文」时用) */
  offset: number
  truncatedStart: boolean
  truncatedEnd: boolean
}

/** 命中的 token(归一化坐标)→ 原文区间。合并挨着的,免得高亮碎成一片。 */
export function hitRangesFromTokens(
  normalized: NormalizedText,
  tokens: readonly Token[],
): TextRange[] {
  const ranges = tokens
    .map(token => mapRangeToSource(normalized, { start: token.start, end: token.end }))
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const merged: TextRange[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
      continue
    }
    merged.push({ ...range })
  }
  return merged
}

/**
 * 开窗。窗口选在「装得下最多命中区间」的地方,平手时取靠前的 —— 确定性,
 * 同一份输入永远同一扇窗。没有命中就取开头那一段。
 */
export function buildSnippet(
  source: string,
  hits: readonly TextRange[],
  width = DEFAULT_SNIPPET_WIDTH,
): Snippet {
  const size = Math.max(1, width)
  if (source.length <= size) {
    return {
      text: source,
      ranges: hits.map(range => clampRange(range, 0, source.length)),
      offset: 0,
      truncatedStart: false,
      truncatedEnd: false,
    }
  }

  const start = chooseWindowStart(source, hits, size)
  const end = alignWindowEnd(source, Math.min(source.length, start + size), start, hits)
  // **窗口边缘的半个命中不标**(检索面终稿 R7:高亮的区间永远相对屏上那串字,
  // 而半截高亮画出来就是在说「这里命中了一个 `ji`」)。所以只留**整段都在窗里**
  // 的那些;被切掉的那一半由 `truncatedStart/End` 的省略号如实交代。
  const ranges = hits
    .filter(range => range.start >= start && range.end <= end)
    .map(range => clampRange({ start: range.start - start, end: range.end - start }, 0, end - start))

  return {
    text: source.slice(start, end),
    ranges,
    offset: start,
    truncatedStart: start > 0,
    truncatedEnd: end < source.length,
  }
}

/**
 * 命中**前置**多少:窗宽的 1/6(检索面终稿 §4)。
 *
 * 从前是 1/3 —— 居中好看,但摘要是一行字、屏上先读到的是左边那一段,一个命中被
 * 推到行中央就意味着前面 40 个字全是与查询无关的上文。1/6 把命中拉到靠前的位置,
 * 又留够「这句话是从哪儿说起的」那一小段。
 */
const HIT_LEAD_IN_DIVISOR = 6

/**
 * CJK 与它的标点:这些字**每一个都是词**,所以任何两字之间都是可断处。
 * 拉丁字母不是 —— 从 `constraints` 中间断开会画出一截没意义的 `raints`。
 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 这个下标断得开吗:开头 / 空白之后 / CJK 的两侧。 */
function isWordBoundary(source: string, at: number): boolean {
  if (at <= 0 || at >= source.length) return true
  const before = source[at - 1]!
  const here = source[at]!
  return /\s/.test(before) || CJK.test(before) || CJK.test(here)
}

/**
 * 把窗口起点**往后**挪到最近的可断处,但绝不越过 `limit`(那是第一个命中的起点,
 * 挪过头会把命中本身切掉)。找不到可断处就留在原地 —— 一整段没有空白的串
 * (URL、base64)本来就没有更好的断法。
 */
function alignWindowStart(source: string, start: number, limit: number): number {
  if (start <= 0) return 0
  for (let at = start; at <= limit; at += 1) {
    if (isWordBoundary(source, at)) return at
  }
  return start
}

/** 同理,窗口终点**往前**收到最近的可断处,但不收进最后一个命中里去。 */
function alignWindowEnd(source: string, end: number, start: number, hits: readonly TextRange[]): number {
  if (end >= source.length) return source.length
  const floor = hits.reduce(
    (low, hit) => (hit.start >= start && hit.end <= end ? Math.max(low, hit.end) : low),
    start,
  )
  for (let at = end; at >= floor; at -= 1) {
    if (isWordBoundary(source, at)) return at
  }
  return end
}

function chooseWindowStart(source: string, hits: readonly TextRange[], size: number): number {
  if (hits.length === 0) return 0

  let bestStart = 0
  let bestCount = -1
  for (const hit of hits) {
    // 命中前置 1/6 窗宽,再钳进原文范围内,最后挪到最近的可断处。
    const raw = clamp(
      hit.start - Math.floor(size / HIT_LEAD_IN_DIVISOR),
      0,
      Math.max(0, source.length - size),
    )
    const candidate = alignWindowStart(source, raw, hit.start)
    const covered = hits.filter(other =>
      other.start >= candidate && other.end <= candidate + size).length
    if (covered > bestCount) {
      bestCount = covered
      bestStart = candidate
    }
  }
  return bestStart
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function clampRange(range: TextRange, low: number, high: number): TextRange {
  return { start: clamp(range.start, low, high), end: clamp(range.end, low, high) }
}

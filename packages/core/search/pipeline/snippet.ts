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
  const end = Math.min(source.length, start + size)
  const ranges = hits
    .filter(range => range.end > start && range.start < end)
    .map(range => clampRange({ start: range.start - start, end: range.end - start }, 0, end - start))

  return {
    text: source.slice(start, end),
    ranges,
    offset: start,
    truncatedStart: start > 0,
    truncatedEnd: end < source.length,
  }
}

function chooseWindowStart(source: string, hits: readonly TextRange[], size: number): number {
  if (hits.length === 0) return 0

  let bestStart = 0
  let bestCount = -1
  for (const hit of hits) {
    // 让命中大致居中,再钳进原文范围内。
    const candidate = clamp(hit.start - Math.floor(size / 3), 0, Math.max(0, source.length - size))
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

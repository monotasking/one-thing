/**
 * extract:从查询里抽时间与实体(parse 之后、plan 之前的一段纯函数)。
 *
 * 设计:docs/design/search-index-2026-09.md §6.1b
 *
 * 抽取器是一张**列表**:中文 / 英文时间各一个,实体按正则再加。**抽不到就什么都不做**
 * —— 这一段永远不许把一次搜索变坏。抽到的时间进 `filters.since / until`,
 * 被吃掉的词从 ast 里摘掉(壳把抽到的时间画成一条可拖的轴,拖动即改这两格)。
 */

import type { FacetFilter, QueryNode, SearchQuery } from '../candidate.js'
import { collectQueryTerms, withQueryChanges } from './parse.js'

export interface ExtractionContext {
  now: number
}

export interface Extraction {
  filters?: Record<string, FacetFilter>
  /** 从 ast 里摘掉的词(按归一化后的词形逐字比) */
  consumed?: string[]
}

export interface QueryExtractor {
  readonly id: string
  extract(query: SearchQuery, ctx: ExtractionContext): Extraction | null
}

const DAY_MS = 24 * 60 * 60 * 1000

const RELATIVE_UNITS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: DAY_MS,
  w: 7 * DAY_MS,
  mo: 30 * DAY_MS,
  y: 365 * DAY_MS,
}

// 大小写不敏感:小写不再在归一化里做(见 normalize.ts 的 DEFAULT_NORMALIZERS 注释)。
const RELATIVE = /^(\d+)(mo|[hdwy])$/i

/** `7d` / `2w` / `3h` —— 也认 `since:7d` 那一格里写的同一种串。 */
export function parseRelativeDuration(text: string): number | undefined {
  const match = RELATIVE.exec(text)
  if (match === null) return undefined
  const amount = Number(match[1])
  const unit = RELATIVE_UNITS[match[2]!.toLowerCase()]
  return unit === undefined ? undefined : amount * unit
}

export const englishRelativeTimeExtractor: QueryExtractor = {
  id: 'time-relative-en',
  extract(query, ctx) {
    const { terms } = collectQueryTerms(query.ast)
    for (const term of terms) {
      const duration = parseRelativeDuration(term.text)
      if (duration === undefined) continue
      return { filters: { since: ctx.now - duration }, consumed: [term.text] }
    }
    // 壳或工具以结构传进来的 `since: '7d'` 也在这里落成时间戳。
    const since = query.filters.since
    if (typeof since === 'string') {
      const duration = parseRelativeDuration(since)
      if (duration !== undefined) return { filters: { since: ctx.now - duration } }
    }
    return null
  },
}

const CHINESE_DAY_OFFSETS: Record<string, number> = {
  今天: 0,
  昨天: 1,
  前天: 2,
}

const CHINESE_WEEK_OFFSETS: Record<string, number> = {
  本周: 0,
  这周: 0,
  上周: 1,
  上上周: 2,
}

const CHINESE_MONTHS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

export const chineseTimeExtractor: QueryExtractor = {
  id: 'time-zh',
  extract(query, ctx) {
    const { terms } = collectQueryTerms(query.ast)
    for (const term of terms) {
      const window = readChineseTimeWindow(term.text, ctx.now)
      if (window === undefined) continue
      return { filters: window, consumed: [term.text] }
    }
    return null
  },
}

function readChineseTimeWindow(
  text: string,
  now: number,
): Record<string, FacetFilter> | undefined {
  for (const [word, offset] of Object.entries(CHINESE_DAY_OFFSETS)) {
    if (!text.includes(word)) continue
    const start = startOfDay(now) - offset * DAY_MS
    return { since: start, until: start + DAY_MS }
  }
  for (const [word, offset] of Object.entries(CHINESE_WEEK_OFFSETS)) {
    if (!text.includes(word)) continue
    const start = startOfWeek(now) - offset * 7 * DAY_MS
    return { since: start, until: start + 7 * DAY_MS }
  }
  const month = readChineseMonth(text)
  if (month !== undefined) {
    const current = new Date(now)
    // 「八月」指最近的那个八月:还没到就退回去年。
    const year = month <= current.getMonth() + 1 ? current.getFullYear() : current.getFullYear() - 1
    const start = new Date(year, month - 1, 1).getTime()
    const end = new Date(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1).getTime()
    return { since: start, until: end }
  }
  return undefined
}

function readChineseMonth(text: string): number | undefined {
  const digits = /^(\d{1,2})月$/.exec(text)
  if (digits !== null) {
    const month = Number(digits[1])
    return month >= 1 && month <= 12 ? month : undefined
  }
  for (let i = 0; i < CHINESE_MONTHS.length; i += 1) {
    if (text === `${CHINESE_MONTHS[i]}月`) return i + 1
  }
  return undefined
}

function startOfDay(now: number): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function startOfWeek(now: number): number {
  const date = new Date(startOfDay(now))
  // 周一起算。
  const weekday = (date.getDay() + 6) % 7
  return date.getTime() - weekday * DAY_MS
}

export const DEFAULT_EXTRACTORS: readonly QueryExtractor[] = Object.freeze([
  englishRelativeTimeExtractor,
  chineseTimeExtractor,
])

export function extract(
  query: SearchQuery,
  extractors: readonly QueryExtractor[],
  ctx: ExtractionContext,
): SearchQuery {
  let current = query
  const consumed = new Set<string>()

  for (const extractor of extractors) {
    const result = extractor.extract(current, ctx)
    if (result === null) continue
    for (const text of result.consumed ?? []) consumed.add(text)
    current = withQueryChanges(current, { filters: result.filters })
  }

  if (consumed.size === 0) return current
  return withQueryChanges(current, { ast: dropTerms(current.ast, consumed) })
}

function dropTerms(node: QueryNode, consumed: ReadonlySet<string>): QueryNode {
  if (node.type === 'and' || node.type === 'or') {
    return {
      ...node,
      children: node.children
        .map(child => dropTerms(child, consumed))
        .filter(child => !isEmptyNode(child)),
    }
  }
  if (node.type === 'not') {
    const child = dropTerms(node.child, consumed)
    return isEmptyNode(child) ? { type: 'and', children: [] } : { type: 'not', child }
  }
  // 短语不摘 —— 用户特意加了引号,那就是他要的字面。
  if (node.type === 'term' && consumed.has(node.text)) return { type: 'and', children: [] }
  return node
}

function isEmptyNode(node: QueryNode): boolean {
  return (node.type === 'and' || node.type === 'or') && node.children.length === 0
}

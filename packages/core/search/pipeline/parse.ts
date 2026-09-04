/**
 * parse:字符串 → SearchQuery。
 *
 * 设计:docs/design/search-index-2026-09.md §6.1
 *
 * 三件事:归一化(两侧同一条 Normalizer 列表,**并保留偏移映射**,所以每个词的
 * `range` 指的是用户原样打的那串,不是归一化后的串)、语法(空格 AND、`"…"` 短语、
 * `-x` NOT、`k:v` 过滤片)、意图(遍历注册表里各 manifest 的 `intentPrefixes`)。
 *
 * 法条落点:**core 里没有任何前缀字面量**。`/` `>` `#` `@` 是某个能力自报的,
 * 谁都没在这里写死;而且**前缀符号不被吃** —— 它是意图的证据,留在词里,
 * 分析器自然会把它当非词字符略过。
 */

import type { FacetFilter, QueryNode, SearchQuery, TextRange } from '../candidate.js'
import { ALL_CAPABILITIES, DEFAULT_INTENT } from '../candidate.js'
import type { CapabilityManifest } from '../capability.js'
import type { Normalizer } from '../analyzer/normalize.js'
import { DEFAULT_NORMALIZERS, composeNormalizers, mapRangeToSource } from '../analyzer/normalize.js'

export interface ParseOptions {
  /** 只读注册表视图;parse 只问 manifest,不调 search */
  manifests?: readonly CapabilityManifest[]
  normalizers?: readonly Normalizer[]
  /** 壳以结构传进来的过滤片(不拼字符串);与查询串里写的同一格数据,结构的优先 */
  filters?: Record<string, FacetFilter>
  /** 只问一个能力时由调用方填;缺省 = 全部档 */
  capability?: string
}

const FILTER_KEY = /^[A-Za-z][A-Za-z0-9_]*$/

export function parse(raw: string, options: ParseOptions = {}): SearchQuery {
  const normalize = composeNormalizers(options.normalizers ?? DEFAULT_NORMALIZERS)
  const normalized = normalize(raw)
  const manifests = options.manifests ?? []

  const children: QueryNode[] = []
  const filters: Record<string, FacetFilter> = {}

  for (const piece of splitPieces(normalized.text)) {
    const range = mapRangeToSource(normalized, piece.range)

    if (piece.quoted) {
      children.push(wrapNegated(piece.negated, { type: 'phrase', text: piece.text, range }))
      continue
    }

    const filter = readFilterPiece(piece.text)
    if (filter !== undefined) {
      filters[filter.key] = piece.negated ? { not: filter.value } as FacetFilter : filter.value
      continue
    }

    if (piece.text.length === 0) continue
    children.push(wrapNegated(piece.negated, { type: 'term', text: piece.text, range }))
  }

  return {
    raw,
    ast: { type: 'and', children },
    intent: resolveIntent(normalized.text, manifests),
    filters: { ...filters, ...options.filters },
    capability: options.capability ?? ALL_CAPABILITIES,
  }
}

export function createParser(defaults: ParseOptions) {
  return (raw: string, options: ParseOptions = {}): SearchQuery =>
    parse(raw, { ...defaults, ...options, filters: { ...defaults.filters, ...options.filters } })
}

/**
 * 意图:命中哪个能力自报的前缀就是哪个意图(能力 id 即意图名);都不中 = content。
 * 长前缀先答 —— 一个能力报 `#`、另一个报 `##` 时,短的不许先把它截走。
 */
export function resolveIntent(text: string, manifests: readonly CapabilityManifest[]): string {
  const trimmed = text.trimStart()
  let winner: { id: string; length: number } | undefined
  for (const manifest of manifests) {
    for (const prefix of manifest.intentPrefixes ?? []) {
      if (prefix.length === 0 || !trimmed.startsWith(prefix)) continue
      if (winner === undefined || prefix.length > winner.length) {
        winner = { id: manifest.id, length: prefix.length }
      }
    }
  }
  return winner?.id ?? DEFAULT_INTENT
}

interface Piece {
  text: string
  range: TextRange
  quoted: boolean
  negated: boolean
}

/** 切片:引号成短语,前导 `-` 取反,其余按空白切。 */
function splitPieces(text: string): Piece[] {
  const pieces: Piece[] = []
  let index = 0

  while (index < text.length) {
    if (/\s/.test(text[index]!)) {
      index += 1
      continue
    }
    const start = index
    let negated = false
    if (text[index] === '-' && index + 1 < text.length && !/\s/.test(text[index + 1]!)) {
      negated = true
      index += 1
    }

    if (text[index] === '"') {
      index += 1
      const bodyStart = index
      while (index < text.length && text[index] !== '"') index += 1
      const body = text.slice(bodyStart, index)
      const end = index < text.length ? index + 1 : index
      index = end
      pieces.push({ text: body, range: { start, end }, quoted: true, negated })
      continue
    }

    while (index < text.length && !/\s/.test(text[index]!)) index += 1
    pieces.push({ text: text.slice(negated ? start + 1 : start, index), range: { start, end: index }, quoted: false, negated })
  }

  return pieces
}

/**
 * `k:v` 过滤片。守两条,否则 `https://x` 会被读成一个叫 https 的过滤片:
 * 键必须是普通标识符,值不许以 `/` 开头。
 */
function readFilterPiece(text: string): { key: string; value: FacetFilter } | undefined {
  const colon = text.indexOf(':')
  if (colon <= 0 || colon === text.length - 1) return undefined
  const key = text.slice(0, colon)
  const rawValue = text.slice(colon + 1)
  if (!FILTER_KEY.test(key) || rawValue.startsWith('/')) return undefined
  return { key, value: readFilterValue(rawValue) }
}

function readFilterValue(text: string): FacetFilter {
  if (text.includes(',')) {
    const parts = text.split(',').filter(part => part.length > 0)
    return parts.map(part => readScalar(part))
  }
  return readScalar(text)
}

function readScalar(text: string): string | number | boolean {
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text
}

function wrapNegated(negated: boolean, node: QueryNode): QueryNode {
  return negated ? { type: 'not', child: node } : node
}

/** 走一遍 AST,把词与短语摘出来(各段共用的读法,别处不要再手写一遍)。 */
export function collectQueryTerms(ast: QueryNode): {
  terms: Array<{ text: string; range: TextRange }>
  phrases: Array<{ text: string; range: TextRange }>
  excluded: Array<{ text: string; range: TextRange }>
} {
  const terms: Array<{ text: string; range: TextRange }> = []
  const phrases: Array<{ text: string; range: TextRange }> = []
  const excluded: Array<{ text: string; range: TextRange }> = []

  const walk = (node: QueryNode, negated: boolean): void => {
    if (node.type === 'and' || node.type === 'or') {
      for (const child of node.children) walk(child, negated)
      return
    }
    if (node.type === 'not') {
      walk(node.child, !negated)
      return
    }
    const entry = { text: node.text, range: node.range }
    if (negated) {
      excluded.push(entry)
      return
    }
    if (node.type === 'phrase') phrases.push(entry)
    else terms.push(entry)
  }

  walk(ast, false)
  return { terms, phrases, excluded }
}

/** parse 的产物再改一格(extract 用):不可变,别就地改。 */
export function withQueryChanges(
  query: SearchQuery,
  changes: { ast?: QueryNode; filters?: Record<string, FacetFilter> },
): SearchQuery {
  return {
    ...query,
    ast: changes.ast ?? query.ast,
    filters: changes.filters === undefined ? query.filters : { ...query.filters, ...changes.filters },
  }
}

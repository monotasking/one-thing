export const GATEWAY_STREAM_FLUSH_INTERVAL_MS = 250
export const GATEWAY_STREAM_SOFT_CHARS = 500
export const GATEWAY_STREAM_IDLE_MS = 3000
export const WECHAT_MAX_TEXT_LENGTH = 2000

const SENTENCE_BOUNDARY_RE = /[。.!！?？]/
const FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/
const LIST_OR_QUOTE_LINE_RE = /^[ \t]*(?:[-+*]|\d+[.)]|>)\s+/
const TABLE_SEPARATOR_RE = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/

export interface MarkdownSafeOutboundBufferOptions {
  maxSegmentLength?: number
  softSegmentLength?: number
}

export interface TakeReadySegmentsOptions {
  idle?: boolean
}

export class MarkdownSafeOutboundBuffer {
  private pending = ''
  private readonly maxSegmentLength: number
  private readonly softSegmentLength: number

  constructor(options: MarkdownSafeOutboundBufferOptions = {}) {
    this.maxSegmentLength = options.maxSegmentLength ?? WECHAT_MAX_TEXT_LENGTH
    this.softSegmentLength = options.softSegmentLength ?? GATEWAY_STREAM_SOFT_CHARS
  }

  append(text: string): void {
    this.pending += text
  }

  hasPending(): boolean {
    return hasRenderableText(this.pending)
  }

  takeReadySegments(options: TakeReadySegmentsOptions = {}): string[] {
    const segments: string[] = []
    const idle = options.idle === true

    while (hasRenderableText(this.pending)) {
      const openFenceSegment = this.takeOpenFenceSegment()
      if (openFenceSegment) {
        segments.push(openFenceSegment)
        continue
      }

      if (!idle && this.pending.length < this.softSegmentLength) break

      const cut = findReadyCut(this.pending, {
        idle,
        softSegmentLength: this.softSegmentLength,
      })
      if (cut <= 0) break

      const ready = this.pending.slice(0, cut)
      this.pending = this.pending.slice(cut)
      segments.push(...splitMarkdownText(ready, this.maxSegmentLength))
    }

    return segments.filter(hasRenderableText)
  }

  flushFinal(): string[] {
    const text = this.pending
    this.pending = ''
    return splitMarkdownText(text, this.maxSegmentLength)
  }

  private takeOpenFenceSegment(): string | null {
    const match = this.pending.match(/^([ \t]{0,3})(`{3,}|~{3,})([^\n]*)(\n|$)/)
    if (!match?.[0] || this.pending.length < this.maxSegmentLength) return null
    if (!hasUnclosedFence(this.pending)) return null

    const openingLine = match[0]
    const marker = match[2]
    const closingLine = `${marker}\n`
    const available = this.maxSegmentLength - openingLine.length - closingLine.length - 1
    if (available < 80) return null

    const body = this.pending.slice(openingLine.length)
    const bodyCut = findLineCut(body, available)
    if (bodyCut <= 0) return null

    const bodyChunk = body.slice(0, bodyCut)
    this.pending = openingLine + body.slice(bodyCut)
    return `${openingLine}${ensureTrailingNewline(bodyChunk)}${closingLine}`
  }
}

export function splitMarkdownText(text: string, maxLength = WECHAT_MAX_TEXT_LENGTH): string[] {
  if (!hasRenderableText(text)) return []

  const blocks = splitIntoMarkdownBlocks(text)
  const segments: string[] = []
  let current = ''

  const pushCurrent = (): void => {
    if (!hasRenderableText(current)) {
      current = ''
      return
    }
    segments.push(stripOuterBlankLines(current))
    current = ''
  }

  for (const block of blocks) {
    const pieces = splitOversizedBlock(block, maxLength)
    for (const piece of pieces) {
      if (!hasRenderableText(piece)) continue
      if (current && current.length + piece.length > maxLength) {
        pushCurrent()
      }
      if (piece.length > maxLength) {
        pushCurrent()
        segments.push(stripOuterBlankLines(piece))
        continue
      }
      current += piece
    }
  }

  pushCurrent()
  return segments.filter(hasRenderableText)
}

function findReadyCut(
  text: string,
  options: { idle: boolean; softSegmentLength: number },
): number {
  const candidates = collectCutCandidates(text, options)
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const cut = candidates[index]
    if (isSafeCut(text, cut, false)) {
      return cut
    }
  }
  return 0
}

function collectCutCandidates(
  text: string,
  options: { idle: boolean; softSegmentLength: number },
): number[] {
  const candidates: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const cut = index + 1
    if (char === '\n') {
      if (options.idle || cut >= options.softSegmentLength) {
        candidates.push(cut)
      }
      continue
    }
    if (SENTENCE_BOUNDARY_RE.test(char)) {
      if (options.idle || cut >= options.softSegmentLength) {
        candidates.push(cut)
      }
      continue
    }
    if (options.idle && index >= options.softSegmentLength && /\s/.test(char)) {
      candidates.push(cut)
    }
  }
  return uniqueSorted(candidates)
}

function isSafeCut(text: string, cut: number, final: boolean): boolean {
  if (cut <= 0 || cut > text.length) return false
  const prefix = text.slice(0, cut)
  const rest = text.slice(cut)
  if (!hasRenderableText(prefix)) return false
  if (hasUnclosedFence(prefix)) return false
  if (!hasBalancedInlineMarkdown(prefix)) return false
  if (cutsInsideListOrQuoteLine(prefix)) return false
  if (!isTableSafeAtBoundary(prefix, rest, final)) return false
  return true
}

function hasUnclosedFence(text: string): boolean {
  let openMarker: string | null = null
  for (const line of splitLines(text)) {
    const match = line.text.match(FENCE_LINE_RE)
    if (!match?.[1]) continue
    const marker = match[1]
    if (!openMarker) {
      openMarker = marker
      continue
    }
    if (marker[0] === openMarker[0] && marker.length >= openMarker.length) {
      openMarker = null
    }
  }
  return openMarker !== null
}

function hasBalancedInlineMarkdown(text: string): boolean {
  let inInlineCode = false
  let boldOpen = false
  let bracketDepth = 0
  let linkParenDepth = 0

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const previous = index > 0 ? text[index - 1] : ''
    if (previous === '\\') continue

    if (char === '`') {
      const runLength = countRun(text, index, '`')
      if (runLength === 1) {
        inInlineCode = !inInlineCode
      }
      index += runLength - 1
      continue
    }

    if (inInlineCode) continue

    if (char === '*' && text[index + 1] === '*') {
      boldOpen = !boldOpen
      index += 1
      continue
    }

    if (char === '[') {
      bracketDepth += 1
      continue
    }

    if (char === ']' && bracketDepth > 0) {
      bracketDepth -= 1
      if (text[index + 1] === '(') {
        linkParenDepth += 1
        index += 1
      }
      continue
    }

    if (char === ')' && linkParenDepth > 0) {
      linkParenDepth -= 1
    }
  }

  return !inInlineCode && !boldOpen && bracketDepth === 0 && linkParenDepth === 0
}

function cutsInsideListOrQuoteLine(prefix: string): boolean {
  if (prefix.endsWith('\n')) return false
  const lineStart = prefix.lastIndexOf('\n') + 1
  return LIST_OR_QUOTE_LINE_RE.test(prefix.slice(lineStart))
}

function isTableSafeAtBoundary(prefix: string, rest: string, final: boolean): boolean {
  const info = trailingTableInfo(prefix)
  if (!info) {
    const lastLine = getLastLine(prefix)
    if (lastLine.includes('|') && final) return true
    if (lastLine.includes('|') && !rest) return false
    if (lastLine.includes('|') && !prefix.endsWith('\n')) return false
    if (lastLine.includes('|') && startsWithTableSeparator(rest)) return false
    return true
  }

  if (!info.hasDataRow) return false
  if (final) return true
  return restStartsOutsideTable(rest)
}

function trailingTableInfo(text: string): { hasDataRow: boolean } | null {
  const lines = splitCompleteLineTexts(text)
    .map(line => line.replace(/\n$/, ''))
    .filter(line => line.trim().length > 0)
  if (lines.length < 2) return null

  let start = lines.length - 1
  while (start >= 0 && looksLikeTableLine(lines[start])) {
    start -= 1
  }
  const tableLines = lines.slice(start + 1)
  if (tableLines.length < 2) return null
  if (!looksLikeTableLine(tableLines[0]) || !isTableSeparator(tableLines[1])) return null
  return { hasDataRow: tableLines.length >= 3 }
}

function restStartsOutsideTable(rest: string): boolean {
  if (!rest) return false
  const line = firstLine(rest).replace(/\n$/, '')
  if (!line.trim()) return true
  return !looksLikeTableLine(line) && !isTableSeparator(line)
}

function startsWithTableSeparator(rest: string): boolean {
  const line = firstLine(rest).replace(/\n$/, '')
  return isTableSeparator(line)
}

function splitIntoMarkdownBlocks(text: string): string[] {
  const lines = splitLines(text)
  const blocks: string[] = []
  let current = ''

  const pushCurrent = (): void => {
    if (current) {
      blocks.push(current)
      current = ''
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    if (isFenceLine(line.text)) {
      pushCurrent()
      let block = line.text
      const marker = line.text.match(FENCE_LINE_RE)?.[1]
      index += 1
      while (index < lines.length) {
        block += lines[index].text
        if (marker && closesFence(lines[index].text, marker)) break
        index += 1
      }
      blocks.push(block)
      continue
    }

    if (
      index + 1 < lines.length
      && looksLikeTableLine(line.text)
      && isTableSeparator(lines[index + 1].text)
    ) {
      pushCurrent()
      let block = line.text + lines[index + 1].text
      index += 2
      while (index < lines.length && looksLikeTableLine(lines[index].text)) {
        block += lines[index].text
        index += 1
      }
      index -= 1
      blocks.push(block)
      continue
    }

    current += line.text
    if (!line.text.trim() || LIST_OR_QUOTE_LINE_RE.test(line.text)) {
      pushCurrent()
    }
  }

  pushCurrent()
  return blocks
}

function splitOversizedBlock(block: string, maxLength: number): string[] {
  if (block.length <= maxLength) return [block]
  if (isFenceLine(block)) return splitFencedCodeBlock(block, maxLength)
  return splitPlainMarkdownBlock(block, maxLength)
}

function splitPlainMarkdownBlock(block: string, maxLength: number): string[] {
  const segments: string[] = []
  let pending = block

  while (pending.length > maxLength) {
    const cut = findFinalSafeCut(pending, maxLength)
    if (cut <= 0) {
      segments.push(pending.slice(0, maxLength))
      pending = pending.slice(maxLength)
      continue
    }
    segments.push(pending.slice(0, cut))
    pending = pending.slice(cut)
  }

  if (pending) segments.push(pending)
  return segments
}

function splitFencedCodeBlock(block: string, maxLength: number): string[] {
  const openingMatch = block.match(/^([ \t]{0,3})(`{3,}|~{3,})([^\n]*)(\n|$)/)
  if (!openingMatch?.[0] || !openingMatch[2]) return splitPlainMarkdownBlock(block, maxLength)

  const openingLine = openingMatch[0]
  const marker = openingMatch[2]
  const closingMatch = findClosingFence(block.slice(openingLine.length), marker)
  const closingLine = `${marker}\n`
  const body = closingMatch
    ? block.slice(openingLine.length, openingLine.length + closingMatch.bodyLength)
    : block.slice(openingLine.length)
  const available = maxLength - openingLine.length - closingLine.length - 1
  if (available < 80) return splitPlainMarkdownBlock(block, maxLength)

  const segments: string[] = []
  let pending = body
  while (pending.length > available) {
    const cut = findLineCut(pending, available)
    if (cut <= 0) break
    const chunk = pending.slice(0, cut)
    segments.push(`${openingLine}${ensureTrailingNewline(chunk)}${closingLine}`)
    pending = pending.slice(cut)
  }
  if (pending || segments.length === 0) {
    segments.push(`${openingLine}${ensureTrailingNewline(pending)}${closingLine}`)
  }
  return segments
}

function findFinalSafeCut(text: string, maxLength: number): number {
  const candidates: number[] = []
  const limit = Math.min(text.length, maxLength)
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\n' || SENTENCE_BOUNDARY_RE.test(char) || /\s/.test(char)) {
      candidates.push(index + 1)
    }
  }

  const beforeLimit = candidates.filter(candidate => candidate <= limit).reverse()
  for (const candidate of beforeLimit) {
    if (isSafeCut(text, candidate, true)) return candidate
  }

  for (const candidate of candidates.filter(candidate => candidate > limit)) {
    if (isSafeCut(text, candidate, true)) return candidate
  }

  return 0
}

function findLineCut(text: string, maxLength: number): number {
  const limit = Math.min(text.length, maxLength)
  const newline = text.lastIndexOf('\n', limit)
  if (newline > 0) return newline + 1
  return limit
}

function findClosingFence(text: string, openingMarker: string): { bodyLength: number } | null {
  let offset = 0
  for (const line of splitLines(text)) {
    if (closesFence(line.text, openingMarker)) {
      return { bodyLength: offset }
    }
    offset += line.text.length
  }
  return null
}

function closesFence(line: string, openingMarker: string): boolean {
  const match = line.match(FENCE_LINE_RE)
  if (!match?.[1]) return false
  const marker = match[1]
  return marker[0] === openingMarker[0] && marker.length >= openingMarker.length
}

function isFenceLine(line: string): boolean {
  return FENCE_LINE_RE.test(line)
}

function looksLikeTableLine(line: string): boolean {
  return line.includes('|') && line.trim().length > 0
}

function isTableSeparator(line: string): boolean {
  return TABLE_SEPARATOR_RE.test(line.trim())
}

function splitLines(text: string): Array<{ text: string }> {
  const matches = text.match(/[^\n]*\n|[^\n]+$/g)
  return matches?.map(line => ({ text: line })) ?? []
}

function splitCompleteLineTexts(text: string): string[] {
  return text.match(/[^\n]*\n/g) ?? []
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline + 1)
}

function getLastLine(text: string): string {
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text
  const newline = withoutTrailingNewline.lastIndexOf('\n')
  return newline === -1 ? withoutTrailingNewline : withoutTrailingNewline.slice(newline + 1)
}

function countRun(text: string, start: number, char: string): number {
  let count = 0
  for (let index = start; index < text.length && text[index] === char; index += 1) {
    count += 1
  }
  return count
}

function uniqueSorted(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b)
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

function stripOuterBlankLines(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '')
}

function hasRenderableText(text: string): boolean {
  return text.trim().length > 0
}

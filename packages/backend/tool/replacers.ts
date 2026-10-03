/**
 * Edit Replacement Strategies
 *
 * A chain of 9 replacement strategies for intelligent code editing.
 * Tries strategies in order until one succeeds.
 *
 * Sources:
 * - https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
 * - https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
 * - https://github.com/sst/opencode (OpenCode project)
 */

/**
 * Replacer function type
 * Yields potential matches for the search string in the content
 */
export type Replacer = (content: string, find: string) => Generator<string, void, void>

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3

/**
 * Levenshtein distance algorithm implementation
 */
function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') {
    return Math.max(a.length, b.length)
  }

  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      )
    }
  }

  return matrix[a.length][b.length]
}

/**
 * 1. SimpleReplacer - Exact match
 * Just yields the search string for exact matching
 */
export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

/**
 * 2. LineTrimmedReplacer - Ignores trailing whitespace per line
 * Matches blocks where each line's trimmed content matches
 */
export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')

  if (searchLines[searchLines.length - 1] === '') {
    searchLines.pop()
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim()
      const searchTrimmed = searchLines[j].trim()

      if (originalTrimmed !== searchTrimmed) {
        matches = false
        break
      }
    }

    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1
      }

      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

/**
 * 3. BlockAnchorReplacer - First/last line anchors with Levenshtein distance
 * Uses first and last lines as anchors, compares middle content with fuzzy matching
 */
export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')

  if (searchLines.length < 3) {
    return
  }

  if (searchLines[searchLines.length - 1] === '') {
    searchLines.pop()
  }

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length

  // Collect all candidate positions where both anchors match
  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue
    }

    // Look for the matching last line after this first line
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j })
        break // Only match the first occurrence of the last line
      }
    }
  }

  // Return immediately if no candidates
  if (candidates.length === 0) {
    return
  }

  // Handle single candidate scenario (using relaxed threshold)
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck

        // Exit early when threshold is reached
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break
        }
      }
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1
      }
      let matchEndIndex = matchStartIndex
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length
        if (k < endLine) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
    return
  }

  // Calculate similarity for multiple candidates
  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck // Average similarity
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }

  // Threshold judgment
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1
    }
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) {
        matchEndIndex += 1
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

/**
 * 4. WhitespaceNormalizedReplacer - Normalizes all whitespace
 * Collapses multiple spaces/tabs to single space
 */
export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim()
  const normalizedFind = normalizeWhitespace(find)

  // Handle single line matches
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      // Only check for substring matches if the full line doesn't match
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        // Find the actual substring in the original line that matches
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
          try {
            const regex = new RegExp(pattern)
            const match = line.match(regex)
            if (match) {
              yield match[0]
            }
          } catch (_e) {
            // Invalid regex pattern, skip
          }
        }
      }
    }
  }

  // Handle multi-line matches
  const findLines = find.split('\n')
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join('\n')) === normalizedFind) {
        yield block.join('\n')
      }
    }
  }
}

/**
 * 5. IndentationFlexibleReplacer - Flexible indentation matching
 * Removes minimum indentation before comparison
 */
export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split('\n')
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      })
    )

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join('\n')
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split('\n')
  const findLines = find.split('\n')

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n')
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

/**
 * 6. EscapeNormalizedReplacer - Handles escape characters
 * Normalizes escape sequences before comparison
 */
export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case 'n':
          return '\n'
        case 't':
          return '\t'
        case 'r':
          return '\r'
        case "'":
          return "'"
        case '"':
          return '"'
        case '`':
          return '`'
        case '\\':
          return '\\'
        case '\n':
          return '\n'
        case '$':
          return '$'
        default:
          return match
      }
    })
  }

  const unescapedFind = unescapeString(find)

  // Try direct match with unescaped find string
  if (content.includes(unescapedFind)) {
    yield unescapedFind
  }

  // Also try finding escaped versions in content that match unescaped find
  const lines = content.split('\n')
  const findLines = unescapedFind.split('\n')

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')
    const unescapedBlock = unescapeString(block)

    if (unescapedBlock === unescapedFind) {
      yield block
    }
  }
}

/**
 * 7. TrimmedBoundaryReplacer - Trims boundaries
 * Matches content with leading/trailing whitespace trimmed
 */
export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()

  if (trimmedFind === find) {
    // Already trimmed, no point in trying
    return
  }

  // Try to find the trimmed version
  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  // Also try finding blocks where trimmed content matches
  const lines = content.split('\n')
  const findLines = find.split('\n')

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')

    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

/**
 * 8. ContextAwareReplacer - Context-aware matching
 * Uses first/last lines as context anchors with similarity check for middle content
 */
export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split('\n')
  if (findLines.length < 3) {
    // Need at least 3 lines to have meaningful context
    return
  }

  // Remove trailing empty line if present
  if (findLines[findLines.length - 1] === '') {
    findLines.pop()
  }

  const contentLines = content.split('\n')

  // Extract first and last lines as context anchors
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  // Find blocks that start and end with the context anchors
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue

    // Look for the matching last line
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        // Found a potential context block
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join('\n')

        // Check if the middle content has reasonable similarity
        // (simple heuristic: at least 50% of non-empty lines should match when trimmed)
        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()

            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) {
                matchingLines++
              }
            }
          }

          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break // Only match the first occurrence
          }
        }
        break
      }
    }
  }
}

/**
 * 9. MultiOccurrenceReplacer - Handles multiple occurrences
 * Yields all exact matches for replaceAll functionality
 */
export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0

  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break

    yield find
    startIndex = index + find.length
  }
}

/**
 * All replacers in order of priority
 */
export const REPLACERS: Replacer[] = [
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  TrimmedBoundaryReplacer,
  ContextAwareReplacer,
  MultiOccurrenceReplacer,
]

/**
 * Replace oldString with newString in content using the replacement chain
 * Tries each replacer in order until one succeeds
 *
 * @throws Error if oldString not found or multiple ambiguous matches found
 */
export function replace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false
): string {
  if (oldString === newString) {
    throw new Error('oldString and newString must be different')
  }

  let notFound = true

  for (const replacer of REPLACERS) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue

      notFound = false

      if (replaceAll) {
        // Use split/join as a polyfill for replaceAll
        return content.split(search).join(newString)
      }

      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue // Multiple matches, try next replacer

      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }

  if (notFound) {
    throw new Error('oldString not found in content')
  }

  throw new Error(
    'Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match.'
  )
}

/**
 * Normalize line endings (CRLF to LF)
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

const TRIM_DIFF_HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Flags which lines are hunk-body content by counting them off against the
 * `@@` headers, the way git parses patches. Prefix-pattern classification is
 * ambiguous: a deleted `-- foo` line (Lua/SQL comments) serializes as
 * `--- foo` and would be skipped as a file header. Returns null when the diff
 * has no hunk headers (bare fragments), where counting is impossible.
 */
function flagHunkContentLines(lines: string[]): boolean[] | null {
  const flags = new Array<boolean>(lines.length).fill(false)
  let sawHeader = false
  let i = 0
  while (i < lines.length) {
    const header = lines[i].match(TRIM_DIFF_HUNK_HEADER)
    if (!header) {
      i += 1
      continue
    }
    sawHeader = true
    let remainingOld = header[2] !== undefined ? parseInt(header[2], 10) : 1
    let remainingNew = header[4] !== undefined ? parseInt(header[4], 10) : 1
    i += 1
    while (i < lines.length && (remainingOld > 0 || remainingNew > 0)) {
      const prefix = lines[i][0]
      if (prefix === '\\') {
        i += 1
        continue
      }
      if (prefix === '+') remainingNew -= 1
      else if (prefix === '-') remainingOld -= 1
      else {
        remainingOld -= 1
        remainingNew -= 1
      }
      flags[i] = true
      i += 1
    }
  }
  return sawHeader ? flags : null
}

/**
 * Trim diff output for cleaner display
 */
export function trimDiff(diff: string): string {
  const lines = diff.split('\n')
  // Header-less fragments fall back to prefix classification; real patches
  // are walked by hunk-header counts so `---`-looking deletions participate.
  const countedFlags = flagHunkContentLines(lines)
  const isContentLine = countedFlags
    ? (line: string, index: number) => countedFlags[index]
    : (line: string) =>
        (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) &&
        !line.startsWith('---') &&
        !line.startsWith('+++')

  const contentLines = lines.filter((line, index) => isContentLine(line, index))
  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }

  if (min === Infinity || min === 0) return diff

  const trimmedLines = lines.map((line, index) => {
    if (isContentLine(line, index)) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join('\n')
}

export const DIFF_DISPLAY_MAX_LINES = 2_000
export const DIFF_DISPLAY_MAX_BYTES = 200_000

/**
 * Cap a diff before it is shipped to the renderer. The audit record keeps the
 * full diff on disk; the display payload only needs a bounded prefix so large
 * file rewrites don't inflate IPC messages and session persistence.
 */
export function truncateDiffForDisplay(
  diff: string,
  maxLines = DIFF_DISPLAY_MAX_LINES,
  maxBytes = DIFF_DISPLAY_MAX_BYTES,
): string {
  if (!diff) return diff

  const lines = diff.split('\n')
  let kept = lines
  let droppedLines = 0
  if (lines.length > maxLines) {
    kept = lines.slice(0, maxLines)
    droppedLines = lines.length - maxLines
  }

  let out = kept.join('\n')
  let truncated = droppedLines > 0
  if (out.length > maxBytes) {
    const cut = out.slice(0, maxBytes)
    const lastNewline = cut.lastIndexOf('\n')
    out = lastNewline > 0 ? cut.slice(0, lastNewline) : cut
    truncated = true
  }

  if (!truncated) return diff
  const suffix = droppedLines > 0 ? ` (${droppedLines} more lines)` : ''
  return `${out}\n[... diff truncated${suffix}; full diff kept in the file mutation audit]`
}

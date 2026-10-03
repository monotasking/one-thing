import { describe, expect, it } from 'vitest'
import {
  computeDiffHunks,
  trimDiffHunks,
  truncateDiffHunksForDisplay,
} from '../diff-hunks.js'

describe('computeDiffHunks', () => {
  it('carries deleted lines that would be ambiguous in unified diff text', () => {
    // The 2026-07-20 incident: deleting Lua `-- XX` comment lines serializes
    // as `--- XX` in unified diff, which header-pattern parsers read as a
    // file boundary. Structured hunks must carry them as plain deletions.
    const oldContent = 'a\n-- AR\n-- CL\n-- CO\n-- MX\n-- PE\nb\n'
    const newContent = 'a\nb\n'
    const hunks = computeDiffHunks('f.lua', oldContent, newContent)

    expect(hunks).toHaveLength(1)
    const deletions = hunks[0].lines.filter(line => line.op === 'del')
    expect(deletions.map(line => line.text)).toEqual([
      '-- AR',
      '-- CL',
      '-- CO',
      '-- MX',
      '-- PE',
    ])
    expect(hunks[0].oldLines).toBe(7)
    expect(hunks[0].newLines).toBe(2)
  })

  it('marks a missing trailing newline with a noeof line', () => {
    const hunks = computeDiffHunks('f', 'x\nno-eol', 'x\nchanged')
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines.map(line => line.op)).toEqual([
      'ctx',
      'del',
      'noeof',
      'add',
      'noeof',
    ])
  })

  it('returns no hunks for identical content', () => {
    expect(computeDiffHunks('f', 'same\n', 'same\n')).toEqual([])
  })
})

describe('trimDiffHunks', () => {
  it('dedents by the common indent across all content lines', () => {
    const hunks = computeDiffHunks('f', '    a\n    b\n', '    a\n    c\n')
    const trimmed = trimDiffHunks(hunks)
    const texts = trimmed[0].lines.filter(l => l.op !== 'noeof').map(l => l.text)
    expect(texts).toEqual(['a', 'b', 'c'])
  })

  it('dedents deletions whose content starts with dashes (text trimDiff blind spot)', () => {
    const hunks = computeDiffHunks('f.lua', '  keep\n  -- AR\n', '  keep\n')
    const trimmed = trimDiffHunks(hunks)
    const deletion = trimmed[0].lines.find(l => l.op === 'del')
    expect(deletion?.text).toBe('-- AR')
  })

  it('keeps hunks untouched when there is no common indent', () => {
    const hunks = computeDiffHunks('f', 'a\n', 'b\n')
    expect(trimDiffHunks(hunks)).toBe(hunks)
  })
})

describe('truncateDiffHunksForDisplay', () => {
  it('caps the total number of lines at a hunk-line boundary', () => {
    const oldContent = Array.from({ length: 50 }, (_, i) => `old${i}`).join('\n') + '\n'
    const newContent = Array.from({ length: 50 }, (_, i) => `new${i}`).join('\n') + '\n'
    const hunks = computeDiffHunks('f', oldContent, newContent)
    const truncated = truncateDiffHunksForDisplay(hunks, 10)
    const totalLines = truncated.reduce((acc, hunk) => acc + hunk.lines.length, 0)
    expect(totalLines).toBe(10)
  })

  it('returns hunks unchanged when under the limits', () => {
    const hunks = computeDiffHunks('f', 'a\n', 'b\n')
    expect(truncateDiffHunksForDisplay(hunks)).toEqual(hunks)
  })
})

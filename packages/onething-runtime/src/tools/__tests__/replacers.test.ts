import { describe, it, expect } from 'vitest'
import {
  replace,
  normalizeLineEndings,
  trimDiff,
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  TrimmedBoundaryReplacer,
  ContextAwareReplacer,
  MultiOccurrenceReplacer,
  REPLACERS,
} from '../replacers'

// Helper to collect all yields from a replacer generator
function collectYields(gen: Generator<string, void, unknown>): string[] {
  const results: string[] = []
  for (const value of gen) {
    results.push(value)
  }
  return results
}

// ─── replace() main function ───────────────────────────────────────────────

describe('replace()', () => {
  it('should replace exact match', () => {
    const content = 'hello world'
    const result = replace(content, 'hello', 'goodbye')
    expect(result).toBe('goodbye world')
  })

  it('should throw when oldString equals newString', () => {
    expect(() => replace('hello', 'hello', 'hello')).toThrow(
      'oldString and newString must be different'
    )
  })

  it('should throw when oldString not found', () => {
    expect(() => replace('hello world', 'xyz', 'abc')).toThrow('oldString not found in content')
  })

  it('should throw when multiple ambiguous matches and no unique match is found', () => {
    const content = 'foo bar foo bar'
    expect(() => replace(content, 'foo bar', 'baz')).toThrow('Found multiple matches')
  })

  it('should handle replaceAll mode', () => {
    const content = 'aaa bbb aaa'
    const result = replace(content, 'aaa', 'ccc', true)
    expect(result).toBe('ccc bbb ccc')
  })

  it('should replace multiline content', () => {
    const content = 'line1\nline2\nline3'
    const result = replace(content, 'line2', 'replaced')
    expect(result).toBe('line1\nreplaced\nline3')
  })

  it('should handle replacement at the beginning', () => {
    const result = replace('abc def', 'abc', 'xyz')
    expect(result).toBe('xyz def')
  })

  it('should handle replacement at the end', () => {
    const result = replace('abc def', 'def', 'xyz')
    expect(result).toBe('abc xyz')
  })

  it('should handle replacement of entire content', () => {
    const result = replace('hello', 'hello', 'world')
    expect(result).toBe('world')
  })
})

// ─── 1. SimpleReplacer ─────────────────────────────────────────────────────

describe('SimpleReplacer', () => {
  it('should yield the exact search string', () => {
    const results = collectYields(SimpleReplacer('any content', 'search'))
    expect(results).toEqual(['search'])
  })

  it('should yield even if content does not contain the search', () => {
    const results = collectYields(SimpleReplacer('hello', 'xyz'))
    expect(results).toEqual(['xyz'])
  })
})

// ─── 2. LineTrimmedReplacer ────────────────────────────────────────────────

describe('LineTrimmedReplacer', () => {
  it('should match lines ignoring trailing whitespace', () => {
    const content = 'hello   \nworld   '
    const find = 'hello\nworld'
    const results = collectYields(LineTrimmedReplacer(content, find))
    expect(results.length).toBe(1)
    expect(results[0]).toBe('hello   \nworld   ')
  })

  it('should match single line with trailing whitespace', () => {
    const content = 'line1\n  foo  \nline3'
    const find = 'foo'
    const results = collectYields(LineTrimmedReplacer(content, find))
    expect(results.length).toBe(1)
    expect(results[0]).toBe('  foo  ')
  })

  it('should return empty when no match', () => {
    const content = 'hello world'
    const find = 'xyz'
    const results = collectYields(LineTrimmedReplacer(content, find))
    expect(results).toEqual([])
  })

  it('should handle trailing empty line in search', () => {
    const content = 'aaa\nbbb\nccc'
    const find = 'aaa\nbbb\n'
    const results = collectYields(LineTrimmedReplacer(content, find))
    expect(results.length).toBe(1)
    expect(results[0]).toBe('aaa\nbbb')
  })

  it('should handle leading whitespace differences', () => {
    const content = '  hello\n  world'
    const find = 'hello\nworld'
    const results = collectYields(LineTrimmedReplacer(content, find))
    expect(results.length).toBe(1)
  })
})

// ─── 3. BlockAnchorReplacer ────────────────────────────────────────────────

describe('BlockAnchorReplacer', () => {
  it('should match blocks by first/last line anchors', () => {
    const content = 'function foo() {\n  const x = 1\n  return x\n}'
    const find = 'function foo() {\n  const y = 2\n}'
    const results = collectYields(BlockAnchorReplacer(content, find))
    expect(results.length).toBe(1)
    expect(results[0]).toBe('function foo() {\n  const x = 1\n  return x\n}')
  })

  it('should return empty for less than 3 lines in search', () => {
    const content = 'hello\nworld'
    const find = 'hello\nworld'
    const results = collectYields(BlockAnchorReplacer(content, find))
    expect(results).toEqual([])
  })

  it('should return empty when no anchor match', () => {
    const content = 'aaa\nbbb\nccc'
    const find = 'xxx\nyyy\nzzz'
    const results = collectYields(BlockAnchorReplacer(content, find))
    expect(results).toEqual([])
  })

  it('should pick best match among multiple candidates', () => {
    const content = 'start\n  exact match\nend\nstart\n  different\nend'
    const find = 'start\n  exact match\nend'
    const results = collectYields(BlockAnchorReplacer(content, find))
    expect(results.length).toBe(1)
    expect(results[0]).toContain('exact match')
  })
})

// ─── 4. WhitespaceNormalizedReplacer ───────────────────────────────────────

describe('WhitespaceNormalizedReplacer', () => {
  it('should match with collapsed whitespace', () => {
    const content = 'const   x  =  1'
    const find = 'const x = 1'
    const results = collectYields(WhitespaceNormalizedReplacer(content, find))
    expect(results.length).toBeGreaterThan(0)
  })

  it('should match tab-separated content', () => {
    const content = 'hello\tworld'
    const find = 'hello world'
    const results = collectYields(WhitespaceNormalizedReplacer(content, find))
    expect(results.length).toBeGreaterThan(0)
  })

  it('should return empty when no whitespace-normalized match', () => {
    const content = 'hello world'
    const find = 'xyz abc'
    const results = collectYields(WhitespaceNormalizedReplacer(content, find))
    expect(results).toEqual([])
  })

  it('should handle multiline blocks', () => {
    const content = 'line1  \n  line2'
    const find = 'line1\nline2'
    const results = collectYields(WhitespaceNormalizedReplacer(content, find))
    expect(results.length).toBeGreaterThan(0)
  })
})

// ─── 5. IndentationFlexibleReplacer ────────────────────────────────────────

describe('IndentationFlexibleReplacer', () => {
  it('should match blocks with different indentation levels', () => {
    const content = '    if (true) {\n      return 1\n    }'
    const find = 'if (true) {\n  return 1\n}'
    const results = collectYields(IndentationFlexibleReplacer(content, find))
    expect(results.length).toBe(1)
    expect(results[0]).toBe('    if (true) {\n      return 1\n    }')
  })

  it('should return empty when content differs beyond indentation', () => {
    const content = '    if (true) {\n      return 1\n    }'
    const find = 'if (false) {\n  return 2\n}'
    const results = collectYields(IndentationFlexibleReplacer(content, find))
    expect(results).toEqual([])
  })

  it('should handle zero-indentation match', () => {
    const content = 'hello\nworld'
    const find = 'hello\nworld'
    const results = collectYields(IndentationFlexibleReplacer(content, find))
    expect(results.length).toBe(1)
  })
})

// ─── 6. EscapeNormalizedReplacer ───────────────────────────────────────────

describe('EscapeNormalizedReplacer', () => {
  it('should match content with real newline using escaped search', () => {
    // Content has a real newline, find has escaped \n
    const content = 'hello\nworld'
    const find = 'hello\\nworld'
    const results = collectYields(EscapeNormalizedReplacer(content, find))
    expect(results.length).toBeGreaterThan(0)
  })

  it('should handle tab escape', () => {
    const content = 'hello\tworld'
    const find = 'hello\\tworld'
    const results = collectYields(EscapeNormalizedReplacer(content, find))
    expect(results.length).toBeGreaterThan(0)
  })

  it('should return empty when no match', () => {
    const content = 'hello world'
    const find = 'xyz\\nabc'
    const results = collectYields(EscapeNormalizedReplacer(content, find))
    expect(results).toEqual([])
  })
})

// ─── 7. TrimmedBoundaryReplacer ────────────────────────────────────────────

describe('TrimmedBoundaryReplacer', () => {
  it('should match with trimmed leading/trailing whitespace', () => {
    const content = 'hello world'
    const find = '  hello world  '
    const results = collectYields(TrimmedBoundaryReplacer(content, find))
    expect(results.length).toBeGreaterThan(0)
  })

  it('should return empty when find is already trimmed', () => {
    const content = 'hello world'
    const find = 'hello world'
    const results = collectYields(TrimmedBoundaryReplacer(content, find))
    expect(results).toEqual([])
  })

  it('should handle multiline with boundary whitespace', () => {
    const content = 'line1\nline2\nline3'
    const find = '\nline1\nline2\n'
    const results = collectYields(TrimmedBoundaryReplacer(content, find))
    expect(results.length).toBeGreaterThan(0)
  })
})

// ─── 8. ContextAwareReplacer ───────────────────────────────────────────────

describe('ContextAwareReplacer', () => {
  it('should match using context anchors with similar middle content', () => {
    const content = 'function test() {\n  const a = 1\n  const b = 2\n  return a + b\n}'
    const find = 'function test() {\n  const a = 1\n  const b = 2\n  return a + b\n}'
    const results = collectYields(ContextAwareReplacer(content, find))
    expect(results.length).toBe(1)
  })

  it('should return empty for fewer than 3 lines', () => {
    const content = 'hello\nworld'
    const find = 'hello\nworld'
    const results = collectYields(ContextAwareReplacer(content, find))
    expect(results).toEqual([])
  })

  it('should reject when middle content is too different', () => {
    const content = 'start\ncompletely different middle\nend'
    const find = 'start\nsome original text here\nsome more text here\nand even more text\nend'
    const results = collectYields(ContextAwareReplacer(content, find))
    expect(results).toEqual([])
  })

  it('should match with >=50% middle line similarity', () => {
    const content = 'function foo() {\n  const x = 1\n  const y = 2\n  return x + y\n}'
    const find = 'function foo() {\n  const x = 1\n  const z = 3\n  return x + y\n}'
    const results = collectYields(ContextAwareReplacer(content, find))
    // 2 out of 3 middle lines match => 66% >= 50%
    expect(results.length).toBe(1)
  })
})

// ─── 9. MultiOccurrenceReplacer ────────────────────────────────────────────

describe('MultiOccurrenceReplacer', () => {
  it('should yield all exact matches', () => {
    const content = 'foo bar foo baz foo'
    const find = 'foo'
    const results = collectYields(MultiOccurrenceReplacer(content, find))
    expect(results).toEqual(['foo', 'foo', 'foo'])
  })

  it('should yield empty when no match', () => {
    const content = 'hello world'
    const find = 'xyz'
    const results = collectYields(MultiOccurrenceReplacer(content, find))
    expect(results).toEqual([])
  })

  it('should handle adjacent matches', () => {
    const content = 'aaaa'
    const find = 'aa'
    const results = collectYields(MultiOccurrenceReplacer(content, find))
    expect(results).toEqual(['aa', 'aa'])
  })
})

// ─── REPLACERS array ───────────────────────────────────────────────────────

describe('REPLACERS', () => {
  it('should contain exactly 9 replacers', () => {
    expect(REPLACERS).toHaveLength(9)
  })

  it('should be in the correct order', () => {
    expect(REPLACERS[0]).toBe(SimpleReplacer)
    expect(REPLACERS[1]).toBe(LineTrimmedReplacer)
    expect(REPLACERS[2]).toBe(BlockAnchorReplacer)
    expect(REPLACERS[3]).toBe(WhitespaceNormalizedReplacer)
    expect(REPLACERS[4]).toBe(IndentationFlexibleReplacer)
    expect(REPLACERS[5]).toBe(EscapeNormalizedReplacer)
    expect(REPLACERS[6]).toBe(TrimmedBoundaryReplacer)
    expect(REPLACERS[7]).toBe(ContextAwareReplacer)
    expect(REPLACERS[8]).toBe(MultiOccurrenceReplacer)
  })
})

// ─── normalizeLineEndings ──────────────────────────────────────────────────

describe('normalizeLineEndings()', () => {
  it('should convert CRLF to LF', () => {
    expect(normalizeLineEndings('hello\r\nworld')).toBe('hello\nworld')
  })

  it('should leave LF unchanged', () => {
    expect(normalizeLineEndings('hello\nworld')).toBe('hello\nworld')
  })

  it('should handle multiple CRLF', () => {
    expect(normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc')
  })

  it('should handle empty string', () => {
    expect(normalizeLineEndings('')).toBe('')
  })

  it('should handle string with no line endings', () => {
    expect(normalizeLineEndings('hello')).toBe('hello')
  })
})

// ─── trimDiff ──────────────────────────────────────────────────────────────

describe('trimDiff()', () => {
  it('should trim common indentation from diff lines', () => {
    const diff = '+    hello\n-    world\n     common'
    const result = trimDiff(diff)
    expect(result).toBe('+hello\n-world\n common')
  })

  it('should not trim --- and +++ header lines', () => {
    const diff = '--- a/file.ts\n+++ b/file.ts\n+  hello'
    const result = trimDiff(diff)
    expect(result).toContain('--- a/file.ts')
    expect(result).toContain('+++ b/file.ts')
  })

  it('should return original diff when no content lines', () => {
    const diff = '--- a/file.ts\n+++ b/file.ts'
    expect(trimDiff(diff)).toBe(diff)
  })

  it('should return original diff when no common indentation', () => {
    const diff = '+hello\n-world'
    expect(trimDiff(diff)).toBe(diff)
  })

  it('dedents deleted lines whose content starts with dashes (counted by hunk header)', () => {
    // A deleted Lua `-- AR` comment serializes as `--- AR`; the old prefix
    // rules skipped it as a file header and left it un-dedented.
    const diff = [
      '--- f.lua',
      '+++ f.lua',
      '@@ -1,3 +1,2 @@',
      '   keep',
      '-  -- AR',
      '   also',
    ].join('\n')
    const result = trimDiff(diff)
    expect(result).toContain('\n--- AR')
    expect(result).toContain('\n keep')
    // Real headers stay untouched.
    expect(result).toContain('--- f.lua')
    expect(result).toContain('+++ f.lua')
  })
})

// ─── Integration: replace() with fuzzy matching ────────────────────────────

describe('replace() integration - fuzzy strategies', () => {
  it('should fall through to LineTrimmedReplacer when exact match fails', () => {
    const content = '  hello  \n  world  '
    const result = replace(content, 'hello\nworld', 'replaced')
    expect(result).toBe('replaced')
  })

  it('should fall through to IndentationFlexibleReplacer for indented blocks', () => {
    const content = '    if (true) {\n      return 1\n    }'
    const result = replace(content, 'if (true) {\n  return 1\n}', 'replaced')
    expect(result).toBe('replaced')
  })

  it('should fall through to TrimmedBoundaryReplacer for boundary whitespace', () => {
    const content = 'hello world'
    const result = replace(content, '  hello world  ', 'replaced')
    expect(result).toBe('replaced')
  })

  it('should fall through to WhitespaceNormalizedReplacer for whitespace differences', () => {
    const content = 'const   x  =  1'
    const result = replace(content, 'const x = 1', 'const y = 2')
    expect(result).toBe('const y = 2')
  })
})

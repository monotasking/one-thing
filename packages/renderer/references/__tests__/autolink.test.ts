import { describe, expect, it } from 'vitest'
import { findPathSpans, wholePathReference } from '../autolink'

describe('findPathSpans', () => {
  it('finds an absolute path and reports its span on the original text', () => {
    const text = '已写入 /Users/me/a.ts 完成'
    const spans = findPathSpans(text)

    expect(spans).toHaveLength(1)
    expect(text.slice(spans[0].start, spans[0].end)).toBe('/Users/me/a.ts')
    expect(spans[0].ref).toMatchObject({ kind: 'file', path: '/Users/me/a.ts' })
  })

  it('keeps the line suffix and drops trailing punctuation', () => {
    const spans = findPathSpans('见 /a/b.ts:12。')

    expect(spans).toHaveLength(1)
    expect(spans[0].ref).toMatchObject({ path: '/a/b.ts', line: 12 })
  })

  it('strips a trailing period that is not a line number', () => {
    const spans = findPathSpans('/a/b.ts.')

    expect(spans[0].ref.path).toBe('/a/b.ts')
  })

  it('accepts ~ and Windows drive paths', () => {
    expect(findPathSpans('~/notes/a.md')[0].ref.path).toBe('~/notes/a.md')
    expect(findPathSpans('C:\\Users\\me\\a.ts')[0].ref.path).toBe('C:\\Users\\me\\a.ts')
  })

  it('accepts a relative path only with an extension or a line number', () => {
    expect(findPathSpans('src/foo.ts')).toHaveLength(1)
    expect(findPathSpans('src/foo:12')).toHaveLength(1)
    expect(findPathSpans('and/or')).toHaveLength(0)
  })

  it('does not link a bare absolute path that looks like an HTTP route', () => {
    expect(findPathSpans('/api/files/read')).toHaveLength(0)
    expect(findPathSpans('/api/sessions')).toHaveLength(0)
    // 已知根、扩展名、行号任一都放行。
    expect(findPathSpans('/etc/hosts')).toHaveLength(1)
    expect(findPathSpans('/opt/homebrew/bin/node')).toHaveLength(1)
    expect(findPathSpans('/srv/app/main.py')).toHaveLength(1)
    expect(findPathSpans('/x/y/z.ts')).toHaveLength(1)
    expect(findPathSpans('/x/y/z:12')).toHaveLength(1)
  })

  it('never matches URLs', () => {
    expect(findPathSpans('https://example.com/a/b.ts')).toHaveLength(0)
    expect(findPathSpans('file:///a/b.ts')).toHaveLength(0)
  })

  it('finds several paths in one string', () => {
    const spans = findPathSpans('/a/b.ts 和 /c/d.ts:9')

    expect(spans.map(span => span.ref.path)).toEqual(['/a/b.ts', '/c/d.ts'])
    expect(spans[1].ref.line).toBe(9)
  })

  it('returns nothing for empty or prose-only text', () => {
    expect(findPathSpans('')).toEqual([])
    expect(findPathSpans('这里没有路径')).toEqual([])
  })
})

describe('wholePathReference', () => {
  it('matches when the whole inline-code content is one path', () => {
    expect(wholePathReference('/a/b.ts:12')).toMatchObject({ path: '/a/b.ts', line: 12 })
    expect(wholePathReference('  ~/a.md  ')).toMatchObject({ path: '~/a.md' })
  })

  it('refuses partial matches — a code span is wrapped whole or not at all', () => {
    expect(wholePathReference('cat /a/b.ts')).toBeNull()
    expect(wholePathReference('const x = 1')).toBeNull()
    expect(wholePathReference('rm -rf /')).toBeNull()
  })

  it('refuses non-paths', () => {
    expect(wholePathReference('npm')).toBeNull()
    expect(wholePathReference('https://example.com')).toBeNull()
    expect(wholePathReference('')).toBeNull()
  })
})

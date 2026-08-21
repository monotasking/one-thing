import { describe, expect, it } from 'vitest'
import {
  isImagePath,
  parseReference,
  pathToFileUrl,
  type ParseReferenceContext,
  type Reference,
} from '../parse'

interface Case {
  name: string
  href: string
  ctx?: ParseReferenceContext
  expected: Partial<Reference> | null
}

const RELATIVE: ParseReferenceContext = { allowRelative: true }

const cases: Case[] = [
  // ── 绝对路径 ────────────────────────────────────────────────────────────
  { name: 'absolute path', href: '/abs/path/file.ts', expected: { kind: 'file', path: '/abs/path/file.ts' } },
  { name: 'absolute directory', href: '/abs/path/', expected: { kind: 'file', path: '/abs/path/' } },
  { name: 'bare root is too ambiguous', href: '/', expected: null },
  { name: 'protocol-relative is not a path', href: '//example.com/x', expected: null },

  // ── 行号 ────────────────────────────────────────────────────────────────
  { name: ':line', href: '/a/b.ts:12', expected: { kind: 'file', path: '/a/b.ts', line: 12 } },
  { name: ':line-endLine', href: '/a/b.ts:12-30', expected: { kind: 'file', path: '/a/b.ts', line: 12, endLine: 30 } },
  { name: ':line:col', href: '/a/b.ts:12:5', expected: { kind: 'file', path: '/a/b.ts', line: 12, col: 5 } },
  { name: '#Lline', href: '/a/b.ts#L12', expected: { kind: 'file', path: '/a/b.ts', line: 12 } },
  { name: '#Lline-Lend', href: '/a/b.ts#L12-L30', expected: { kind: 'file', path: '/a/b.ts', line: 12, endLine: 30 } },
  { name: '#Lline-end', href: '/a/b.ts#L12-30', expected: { kind: 'file', path: '/a/b.ts', line: 12, endLine: 30 } },
  { name: 'line 0 is not a line', href: '/a/b.ts:0', expected: { kind: 'file', path: '/a/b.ts:0' } },
  { name: 'trailing colon is part of the path', href: '/a/b.ts:12:', expected: { kind: 'file', path: '/a/b.ts:12:' } },

  // ── file:// ─────────────────────────────────────────────────────────────
  { name: 'file url', href: 'file:///abs/path/file.ts', expected: { kind: 'file', path: '/abs/path/file.ts' } },
  { name: 'file url with line', href: 'file:///abs/b.ts:12', expected: { kind: 'file', path: '/abs/b.ts', line: 12 } },
  { name: 'file url with #L', href: 'file:///abs/b.ts#L7', expected: { kind: 'file', path: '/abs/b.ts', line: 7 } },
  { name: 'file url localhost host', href: 'file://localhost/abs/x.ts', expected: { kind: 'file', path: '/abs/x.ts' } },
  { name: 'file url remote host rejected', href: 'file://evil.example/x', expected: null },
  { name: 'file url percent-encoded space', href: 'file:///abs/cute%20cat.png', expected: { kind: 'file', path: '/abs/cute cat.png' } },
  { name: 'file url windows drive', href: 'file:///C:/Users/me/a.ts', expected: { kind: 'file', path: 'C:/Users/me/a.ts' } },

  // ── ~ / Windows ─────────────────────────────────────────────────────────
  { name: 'home path', href: '~/notes/a.md', expected: { kind: 'file', path: '~/notes/a.md' } },
  { name: 'home path with line', href: '~/notes/a.md:3', expected: { kind: 'file', path: '~/notes/a.md', line: 3 } },
  { name: 'bare tilde', href: '~', expected: null },
  { name: 'windows backslash path', href: 'C:\\Users\\me\\a.ts', expected: { kind: 'file', path: 'C:\\Users\\me\\a.ts' } },
  { name: 'windows forward slash with line', href: 'C:/Users/me/a.ts:9', expected: { kind: 'file', path: 'C:/Users/me/a.ts', line: 9 } },
  { name: 'bare drive letter', href: 'C:', expected: null },

  // ── URL / external ──────────────────────────────────────────────────────
  { name: 'https', href: 'https://example.com', expected: { kind: 'url', url: 'https://example.com' } },
  { name: 'http with query and hash', href: 'http://example.com/a?b=1#c', expected: { kind: 'url', url: 'http://example.com/a?b=1#c' } },
  { name: 'mailto', href: 'mailto:a@b.com', expected: { kind: 'external', url: 'mailto:a@b.com' } },
  { name: 'vscode scheme', href: 'vscode://file/a/b', expected: { kind: 'external', url: 'vscode://file/a/b' } },
  { name: 'onething scheme is external for now', href: 'onething://session/1', expected: { kind: 'external', url: 'onething://session/1' } },

  // ── 拒绝面 ──────────────────────────────────────────────────────────────
  { name: 'javascript:', href: 'javascript:alert(1)', expected: null },
  { name: 'JavaScript: mixed case', href: 'JavaScript:alert(1)', expected: null },
  { name: 'javascript: with leading space', href: '   javascript:alert(1)', expected: null },
  { name: 'vbscript:', href: 'vbscript:msgbox', expected: null },
  { name: 'data:text/html', href: 'data:text/html,<b>x</b>', expected: null },
  { name: 'data:image is not a reference', href: 'data:image/png;base64,AAA', expected: null },
  { name: 'plain anchor', href: '#section', expected: null },
  { name: 'empty', href: '', expected: null },
  { name: 'whitespace only', href: '   ', expected: null },

  // ── 相对路径 ────────────────────────────────────────────────────────────
  { name: 'relative rejected by default', href: 'src/foo.ts', expected: null },
  { name: 'relative with line rejected by default', href: 'src/foo.ts:12', expected: null },
  { name: 'relative allowed with ctx', href: 'src/foo.ts', ctx: RELATIVE, expected: { kind: 'file', path: 'src/foo.ts' } },
  { name: 'relative with line allowed with ctx', href: 'src/foo.ts:12', ctx: RELATIVE, expected: { kind: 'file', path: 'src/foo.ts', line: 12 } },
  { name: 'dot-slash relative', href: './a/b.ts', ctx: RELATIVE, expected: { kind: 'file', path: './a/b.ts' } },
  { name: 'bare filename rejected (indistinguishable from a domain)', href: 'foo.ts', ctx: RELATIVE, expected: null },
  { name: 'bare filename with line is neither file nor external', href: 'main.py:12', ctx: RELATIVE, expected: null },
  { name: 'hostname-looking first segment rejected', href: 'example.com/page', ctx: RELATIVE, expected: null },

  // ── 编码 ────────────────────────────────────────────────────────────────
  { name: 'percent-encoded bare path', href: '/path/with%20space.ts', expected: { kind: 'file', path: '/path/with space.ts' } },
  { name: 'broken percent escape is left alone', href: '/path/100%.ts', expected: { kind: 'file', path: '/path/100%.ts' } },
]

describe('parseReference', () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = parseReference(testCase.href, testCase.ctx)
      if (testCase.expected === null) {
        expect(result).toBeNull()
        return
      }
      expect(result).toMatchObject(testCase.expected)
      expect(result?.raw).toBe(testCase.href.trim())
    })
  }

  it('omits absent position fields entirely (data-ref stays small)', () => {
    expect(JSON.stringify(parseReference('/a/b.ts'))).toBe(
      '{"kind":"file","path":"/a/b.ts","raw":"/a/b.ts"}',
    )
  })
})

describe('pathToFileUrl', () => {
  it('encodes spaces per segment and keeps the drive colon', () => {
    expect(pathToFileUrl('/Users/me/cute cat.png')).toBe('file:///Users/me/cute%20cat.png')
    expect(pathToFileUrl('C:/Users/me/a.ts')).toBe('file:///C:/Users/me/a.ts')
    expect(pathToFileUrl('C:\\Users\\me\\a.ts')).toBe('file:///C:/Users/me/a.ts')
  })
})

describe('isImagePath', () => {
  it('classifies by extension only', () => {
    expect(isImagePath('/a/b.PNG')).toBe(true)
    expect(isImagePath('/a/b.svg')).toBe(true)
    expect(isImagePath('/a/b.ts')).toBe(false)
    expect(isImagePath('/a/png')).toBe(false)
  })
})

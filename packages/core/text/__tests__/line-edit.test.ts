import { describe, expect, it } from 'vitest'
import { applyAt, applyBatch, invert, locate, splitLines, type LineEdit } from '../line-edit.js'

const doc = ['# 计划', '', '- [ ] 甲', '- [ ] 乙', '- [ ] 丙']

describe('locate', () => {
  it('keeps the given line when it still matches', () => {
    expect(locate(doc, { start: 3, expect: ['- [ ] 乙'], lines: ['- [x] 乙'] })).toEqual({ ok: true, start: 3 })
  })

  it('finds the line again after someone inserted lines above it', () => {
    const shifted = ['# 计划', '', '- [ ] 新插的一', '- [ ] 新插的二', ...doc.slice(2)]
    expect(locate(shifted, { start: 3, expect: ['- [ ] 乙'], lines: ['- [x] 乙'] })).toEqual({ ok: true, start: 5 })
  })

  it('reports a conflict when the expected text is gone', () => {
    const changed = doc.map(line => (line === '- [ ] 乙' ? '- [x] 乙(AI 改过)' : line))
    expect(locate(changed, { start: 3, expect: ['- [ ] 乙'], lines: ['- [x] 乙'] })).toEqual({ ok: false, reason: 'conflict' })
  })

  it('reports a conflict when the expected text is ambiguous', () => {
    const twice = [...doc, '- [ ] 乙']
    expect(locate(twice, { start: 0, expect: ['- [ ] 乙'], lines: [] })).toEqual({ ok: false, reason: 'conflict' })
  })

  it('places a pure insertion by its anchor line', () => {
    const shifted = ['插在最上面', ...doc]
    expect(locate(shifted, { start: 3, expect: [], lines: ['- [ ] 新'], anchor: '- [ ] 甲' })).toEqual({ ok: true, start: 4 })
  })

  it('matches a multi-line block as one unit', () => {
    const block: LineEdit = { start: 2, expect: ['- [ ] 甲', '- [ ] 乙'], lines: ['- [ ] 甲乙'] }
    expect(locate(['x', ...doc], block)).toEqual({ ok: true, start: 3 })
  })
})

describe('applyBatch', () => {
  it('writes nothing when any edit conflicts', () => {
    const result = applyBatch(doc, [
      { start: 2, expect: ['- [ ] 甲'], lines: ['- [x] 甲'] },
      { start: 4, expect: ['- [ ] 不存在'], lines: [] },
    ])
    expect(result).toEqual({ ok: false, reason: 'conflict', index: 1 })
  })

  it('applies edits in order against the evolving text', () => {
    const result = applyBatch(doc, [
      { start: 2, expect: ['- [ ] 甲'], lines: ['- [ ] 甲', '- [ ] 甲二'] },
      { start: 4, expect: ['- [ ] 乙'], lines: ['- [x] 乙'] },
    ])
    expect(result.ok && result.lines).toEqual(['# 计划', '', '- [ ] 甲', '- [ ] 甲二', '- [x] 乙', '- [ ] 丙'])
  })
})

describe('invert', () => {
  it('round-trips a replace, an insert and a delete', () => {
    const edits: LineEdit[] = [
      { start: 3, expect: ['- [ ] 乙'], lines: ['- [x] 乙', '- [ ] 乙二'] },
      { start: 5, expect: [], lines: ['- [ ] 丁'], anchor: '- [ ] 丙' },
      { start: 2, expect: ['- [ ] 甲'], lines: [] },
    ]
    for (const edit of edits) {
      const at = locate(doc, edit)
      expect(at.ok).toBe(true)
      if (!at.ok) continue
      const after = applyAt(doc, edit, at.start)
      const back = invert(doc, edit, at.start)
      const found = locate(after, back)
      expect(found.ok).toBe(true)
      if (found.ok) expect(applyAt(after, back, found.start)).toEqual(doc)
    }
  })
})

it('splitLines treats CRLF as LF', () => {
  expect(splitLines('a\r\nb\nc')).toEqual(['a', 'b', 'c'])
})

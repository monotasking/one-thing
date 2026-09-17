import { describe, expect, it, vi } from 'vitest'
import { applyBatch, splitLines } from '@onething/core/text'
import { analyzeUnit } from '../inline-tokens'
import { paint } from '../paint'
import { canonicalPosition, REVEAL_POLICIES, sourceToView, viewToSource } from '../reveal'
import { continuedPrefix, editValueOf, isList, linesFromEdit, parseUnits, prefixOf, type ListUnit } from '../units'
import { DocHistory } from '../doc-history'
import { changedLineIndices, diffLines, EditorDocument, FLUSH_IDLE_MS } from '../editor-document'

const CLASSES = { code: 'ic', link: 'lk', mark: 'mk', url: 'url', current: 'cur' }
const DOC = [
  '# 计划',
  '',
  '## 待修 bug',
  '- [x] 服务器端 `git rev-parse` → **本地算好**再传',
  '  - [ ] 只保留最近 *3* 个',
  '1. 重写 Makefile',
  '* 星号项 __下划线__',
  '',
  '> 引用**一句**',
  '',
  '```bash',
  'make deploy',
  '```',
]

describe('parseUnits', () => {
  it('splits a todo document into editable units that map back to exact lines', () => {
    const units = parseUnits(DOC)
    expect(units.map(u => `${u.type}:${u.start}-${u.end}`)).toEqual([
      'heading:0-0', 'heading:2-2', 'task:3-3', 'task:4-4', 'ordered:5-5', 'bullet:6-6', 'quote:8-8', 'code:10-12',
    ])
    for (const unit of units) {
      expect(linesFromEdit(unit, editValueOf(unit, DOC))).toEqual(DOC.slice(unit.start, unit.end + 1))
    }
  })

  it('keeps the author\'s marker and continues numbering', () => {
    const [bullet, ordered] = parseUnits(['* a', '3) b']) as ListUnit[]
    expect(prefixOf(bullet)).toBe('* ')
    expect(continuedPrefix(ordered)).toBe('4) ')
    const [task] = parseUnits(['  - [x] done']) as ListUnit[]
    expect(isList(task) && continuedPrefix(task)).toBe('  - [ ] ')
  })
})

describe('analyzeUnit + paint', () => {
  const task = parseUnits(['- [ ] 重启前先 **确认备份**，跑 `make` 见[文档](https://x.y)'])[0]
  const value = editValueOf(task, ['- [ ] 重启前先 **确认备份**，跑 `make` 见[文档](https://x.y)'])
  const analysis = analyzeUnit(task, value)

  it('marks exactly the syntax characters that the message renderer hides', () => {
    const marks = analysis.tokens.filter(t => t.kind !== 'text').map(t => value.slice(t.from, t.to))
    expect(marks).toEqual(['**', '**', '`', '`', '[', '](', 'https://x.y', ')'])
  })

  it('shows the same text in both paints; only marks differ', () => {
    const resting = paint(analysis, new Set(), null, CLASSES)
    const all = paint(analysis, REVEAL_POLICIES.block.revealed(analysis, 0, 0), null, CLASSES)
    expect(resting.html).toContain('<strong>确认备份</strong>')
    expect(resting.html).not.toContain('**')
    expect(all.html).toContain('<span class="mk">**</span>')
    const hidden = analysis.tokens.filter(t => t.kind !== 'text').reduce((n, t) => n + t.to - t.from, 0)
    expect(resting.vis.length).toBe(value.length - hidden)
    expect(all.vis.length).toBe(value.length)
  })

  it('keeps inline code as one chip with its backticks inside', () => {
    const codeGroup = analysis.groups.find(g => g.kind === 'code')!
    const html = paint(analysis, new Set([codeGroup.id]), null, CLASSES).html
    expect(html).toContain('<span class="ic"><span class="mk">`</span>make<span class="mk">`</span></span>')
  })

  it('splits a backslash escape into a mark and a character', () => {
    const para = parseUnits(['a \\*b'])[0]
    const escaped = analyzeUnit(para, 'a \\*b')
    expect(escaped.tokens.map(t => `${t.kind}:${'a \\*b'.slice(t.from, t.to)}`)).toEqual(['text:a ', 'mark:\\', 'text:*b'])
  })

  it('reveals only the element touching the caret in element mode', () => {
    const start = value.indexOf('**')
    const revealed = REVEAL_POLICIES.element.revealed(analysis, start, start)
    expect([...revealed].map(id => analysis.groups[id].kind)).toEqual(['strong'])
  })

  it('maps view offsets to source offsets with a bias at hidden marks', () => {
    const { vis } = paint(analysis, new Set(), null, CLASSES)
    const boundary = sourceToView(vis, value.indexOf('确'))
    expect(viewToSource(vis, value.length, boundary, 'low')).toBe(value.indexOf('**'))
    expect(viewToSource(vis, value.length, boundary, 'high')).toBe(value.indexOf('确'))
    // 不显示记号档:跟左边那个字走 → 粗体开头前面是普通字
    expect(canonicalPosition(analysis, vis, value.length, boundary)).toBe(value.indexOf('**'))
  })

  it('puts the canonical caret after a heading prefix', () => {
    const heading = parseUnits(['## 待修'])[0]
    const a = analyzeUnit(heading, '## 待修')
    const { vis } = paint(a, new Set(), null, CLASSES)
    expect(canonicalPosition(a, vis, 5, 0)).toBe(3)
  })
})

describe('diffLines', () => {
  it('produces one minimal edit that reconciles against the original', () => {
    const before = ['a', 'b', 'c', 'd']
    for (const after of [['a', 'B', 'c', 'd'], ['a', 'b', 'x', 'c', 'd'], ['a', 'd'], ['z', 'a', 'b', 'c', 'd']]) {
      const edit = diffLines(before, after)!
      const result = applyBatch(before, [edit])
      expect(result.ok && result.lines).toEqual(after)
    }
    expect(diffLines(before, before)).toBeNull()
  })

  it('lists only lines that are new', () => {
    expect(changedLineIndices(['a', 'b'], ['a', 'c', 'b', ''])).toEqual([1])
  })
})

describe('DocHistory', () => {
  it('merges typing in one unit and keeps structural steps separate', () => {
    let now = 1000
    const history = new DocHistory(() => now)
    history.record('type', { lines: ['0'], caret: { start: 1, anchor: 0, focus: 0 } })
    now += 100
    history.record('type', { lines: ['1'], caret: { start: 1, anchor: 1, focus: 1 } })
    history.record('struct', { lines: ['2'], caret: { start: 1, anchor: 1, focus: 1 } })
    expect(history.undo({ lines: ['3'], caret: null })?.lines).toEqual(['2'])
    expect(history.undo({ lines: ['2'], caret: null })?.lines).toEqual(['0'])
    expect(history.redo({ lines: ['0'], caret: null })?.lines).toEqual(['2'])
  })
})

describe('EditorDocument', () => {
  it('batches local edits and sends them after the idle delay', async () => {
    vi.useFakeTimers()
    const submit = vi.fn(async () => ({ conflict: false, revision: 'r2' }))
    const doc = new EditorDocument('a\nb', 'r1', { submit, requestReload: vi.fn() })
    doc.setLines(['a', 'B'])
    doc.setLines(['a', 'B', 'c'])
    expect(submit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(FLUSH_IDLE_MS)
    expect(submit).toHaveBeenCalledTimes(1)
    const [edits, base] = submit.mock.calls[0] as unknown as [unknown[], string]
    expect(base).toBe('r1')
    expect(edits).toHaveLength(2)
    expect(doc.baseRevision).toBe('r2')
    vi.useRealTimers()
  })

  it('holds a server copy until local edits land, then drops it as stale', async () => {
    let release!: (v: { conflict: boolean; revision: string }) => void
    const submit = vi.fn(() => new Promise<{ conflict: boolean; revision: string }>(r => { release = r }))
    const doc = new EditorDocument('a', 'r1', { submit, requestReload: vi.fn() })
    doc.setLines(['a', 'mine'])
    const flushing = doc.flush()
    doc.receive('a\nold server copy', 'r0', true)
    expect(doc.lines).toEqual(['a', 'mine'])
    release({ conflict: false, revision: 'r2' })
    await flushing
    expect(doc.lines).toEqual(['a', 'mine'])
  })

  it('marks lines added by an external change', () => {
    const doc = new EditorDocument('- [ ] a', 'r1', { submit: vi.fn(), requestReload: vi.fn() })
    doc.receive('- [ ] a\n- [ ] AI 加的', 'r2', true)
    expect([...doc.recentlyChanged.keys()]).toEqual([1])
    expect(splitLines('x')).toEqual(['x'])
  })
})

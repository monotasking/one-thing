import { describe, expect, it } from 'vitest'
import { sectionsOf, todoViewOf, type TodoViewPrefs } from '../todo-view'

/**
 * 待办文档怎么看(B 形 U4):小节切分、已完成收起、小节折叠。纯函数,原文一个字不动。
 */

const DOC = [
  '# 清单', //            0
  '- [x] 根里做完的', //   1
  '- [ ] 根里没做的', //   2
  '', //                   3
  '## 甲', //             4
  '- [ ] 甲一', //         5
  '- [x] 甲二', //         6
  '- [x] 甲三', //         7
  '### 甲下', //          8
  '- [x] 甲下一', //       9
  '- [ ] 甲下二', //      10
  '## 乙', //            11
  '- [ ] 乙一', //        12
]

const prefs = (over: Partial<TodoViewPrefs> = {}): TodoViewPrefs => ({
  showDone: false,
  doneOpen: new Set(),
  folded: new Set(),
  ...over,
})

describe('小节', () => {
  it('二、三级标题各开一节;自己的单元到下一个标题为止,折叠范围到同级或更高级为止', () => {
    const sections = sectionsOf(DOC)
    expect(sections.map(s => [s.key, s.ownEnd, s.foldEnd])).toEqual([
      ['', 4, 4],
      ['甲', 8, 11],
      ['甲下', 11, 11],
      ['乙', 13, 13],
    ])
    expect(sections[0].units.map(u => u.start)).toEqual([0, 1, 2])
  })
})

describe('已完成收起', () => {
  it('每一节收起自己的已完成项,节末一行「已完成 N 项」', () => {
    const view = todoViewOf(DOC, prefs())
    expect([...view.hidden].sort((a, b) => a - b)).toEqual([1, 6, 7, 9])
    expect(view.folds.map(f => [f.kind, f.section, f.at, f.kind === 'done' ? f.count : null])).toEqual([
      ['done', '', 4, 1],
      ['done', '甲', 8, 2],
      ['done', '甲下', 11, 1],
    ])
  })

  it('展开了的那一节:项不收,提示行还在、换成展开', () => {
    const view = todoViewOf(DOC, prefs({ doneOpen: new Set(['甲']) }))
    expect(view.hidden.has(6)).toBe(false)
    expect(view.folds.find(f => f.section === '甲')).toMatchObject({ kind: 'done', open: true })
  })

  it('全局「显示已完成」开着:什么都不收,也没有提示行', () => {
    const view = todoViewOf(DOC, prefs({ showDone: true }))
    expect(view.hidden.size).toBe(0)
    expect(view.folds).toEqual([])
  })
})

describe('小节折叠', () => {
  it('折起一节:标题留着,盖住的范围整段收起(含更深的小节),紧跟标题一行「N 项未完成」', () => {
    const view = todoViewOf(DOC, prefs({ showDone: true, folded: new Set(['甲']) }))
    expect([...view.hidden].sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10])
    expect(view.folds).toEqual([{ kind: 'section', key: 'section:甲', section: '甲', at: 5, remaining: 2 }])
  })

  it('被折起来盖住的节不再单独说「已完成」', () => {
    const view = todoViewOf(DOC, prefs({ folded: new Set(['甲']) }))
    expect(view.folds.map(f => f.key)).toEqual(['done:', 'section:甲'])
  })

  it('空的一节折起来:提示行落在下一个标题之前', () => {
    const view = todoViewOf(['## 空', '## 下一节', '- [ ] x'], prefs({ showDone: true, folded: new Set(['空']) }))
    expect(view.folds).toEqual([{ kind: 'section', key: 'section:空', section: '空', at: 1, remaining: 0 }])
    expect(view.hidden.size).toBe(0)
  })
})

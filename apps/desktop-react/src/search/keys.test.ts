import { describe, expect, it } from 'vitest'
import { isSequenceIntent, searchIntentOf } from './keys'
import type { SearchIntent } from './keys'

/**
 * 键名 → 意图那张表的判据(检索面终稿 附录 B §1)。**全表覆盖** ——
 * 一张查表函数的用例要么把每一格都写出来,要么就只是在重复实现。
 */

describe('searchIntentOf(键名单产地)', () => {
  const table: Array<[string, boolean, SearchIntent | null]> = [
    // Tab 在这块面里是**换搜索范围**,不是「把焦点交出去」。
    ['Tab', false, 'tab-next'],
    ['Tab', true, 'tab-prev'],
    ['Enter', false, 'enter'],
    // 空格照旧是输入一个空格(拍点 B 保旧,不赋列表语义)。
    [' ', false, 'space'],
    // ↑ 是「回上一条查询 / 往上走一行」同一下键,判据由面板合取。
    ['ArrowUp', false, 'history-recall-or-up'],
    ['ArrowDown', false, 'move'],
    // ←→ 在输入框里是光标左右移动 —— 纵向那条轴上原语不认它们。
    ['ArrowLeft', false, null],
    ['ArrowRight', false, null],
    // Home / End 在输入框里是行首 / 行尾(`homeEnd: false` 的另一半)。
    ['Home', false, null],
    ['End', false, null],
    // Esc 不在表上:退层是响应链的事,不是列表的键。
    ['Escape', false, null],
    ['a', false, null],
    ['Backspace', false, null],
  ]

  for (const [key, shift, want] of table) {
    it(`${shift ? '⇧+' : ''}${key === ' ' ? '空格' : key} → ${want ?? 'null(不吞)'}`, () => {
      expect(searchIntentOf(key, shift)).toBe(want)
    })
  }

  it('不给 shift 就是没按', () => {
    expect(searchIntentOf('Tab')).toBe('tab-next')
  })
})

describe('isSequenceIntent(哪两格要交回 selection.handleKey)', () => {
  it('走位那两格是,别的都不是 —— 走位算术一步都不在这个文件里', () => {
    expect(isSequenceIntent('move')).toBe(true)
    expect(isSequenceIntent('history-recall-or-up')).toBe(true)
    expect(isSequenceIntent('enter')).toBe(false)
    expect(isSequenceIntent('tab-next')).toBe(false)
    expect(isSequenceIntent('space')).toBe(false)
    expect(isSequenceIntent(null)).toBe(false)
  })
})

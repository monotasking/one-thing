import { describe, expect, it } from 'vitest'
import { exposeIntentOf, stepRowIndex } from './keys'
import { nextRovingIndex } from '../ui/a11y/roving'

/**
 * 键名判据的单产地(§3.2 那道禁令:方向键字面量只许出现在这只文件里)。
 * 这一组钉两件事:①八种意图各自认得它那一下;②步进**复用** roving 的算术。
 */
describe('exposeIntentOf', () => {
  it('八种意图各认一下', () => {
    expect(exposeIntentOf('ArrowUp')).toBe('move-up')
    expect(exposeIntentOf('ArrowDown')).toBe('move-down')
    expect(exposeIntentOf('ArrowRight')).toBe('expand')
    expect(exposeIntentOf('ArrowLeft')).toBe('collapse')
    expect(exposeIntentOf('Home')).toBe('home')
    expect(exposeIntentOf('End')).toBe('end')
    expect(exposeIntentOf('Enter')).toBe('enter')
    expect(exposeIntentOf(' ')).toBe('quicklook')
  })

  it('不认识的键回 null —— 调用方据此不 preventDefault(不许吞键)', () => {
    for (const key of ['Escape', 'Tab', 'a', 'PageDown', '']) {
      expect(exposeIntentOf(key), key).toBeNull()
    }
  })
})

describe('stepRowIndex', () => {
  it('**到头就停,不回绕** —— 与 roving 的不回绕档逐字同一份算术', () => {
    expect(stepRowIndex('move-down', 0, 3)).toBe(nextRovingIndex('ArrowDown', 0, 3, 'vertical', false))
    expect(stepRowIndex('move-up', 0, 3)).toBe(0)
    expect(stepRowIndex('move-down', 2, 3)).toBe(2)
  })

  it('还没落焦(-1)时任何一下都落到序列首', () => {
    expect(stepRowIndex('move-up', -1, 3)).toBe(0)
    expect(stepRowIndex('move-down', -1, 3)).toBe(0)
  })

  it('Home / End 落首尾', () => {
    expect(stepRowIndex('home', 2, 5)).toBe(0)
    expect(stepRowIndex('end', 0, 5)).toBe(4)
  })

  it('不归序列管的意图回 null;一行都没有时也回 null', () => {
    expect(stepRowIndex('expand', 0, 3)).toBeNull()
    expect(stepRowIndex('collapse', 0, 3)).toBeNull()
    expect(stepRowIndex('enter', 0, 3)).toBeNull()
    expect(stepRowIndex('quicklook', 0, 3)).toBeNull()
    expect(stepRowIndex('move-down', 0, 0)).toBeNull()
  })
})

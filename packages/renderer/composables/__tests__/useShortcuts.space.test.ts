// @vitest-environment happy-dom
/**
 * ⌘1..9 切空间的键位映射(批 B5,docs/design/workspace-spaces-2026-08.md)。
 *
 * 只测纯映射函数:`useShortcuts` 本身要挂 `onMounted`,而这条快捷键的全部
 * 判断都在 `spaceShortcutIndex` 里 —— 起一个组件只为了敲一次键盘,测的是
 * Vue 不是键位。
 */
import { describe, expect, it } from 'vitest'
import { spaceShortcutIndex } from '../useShortcuts'

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return init as KeyboardEvent
}

describe('spaceShortcutIndex', () => {
  it('⌘1..⌘9 → 0 起的下标(⌘1 = 列表第一个空间)', () => {
    for (let digit = 1; digit <= 9; digit++) {
      expect(spaceShortcutIndex(key({ key: String(digit), metaKey: true }))).toBe(digit - 1)
    }
  })

  it('Ctrl+1..9 同样认(Windows/Linux)', () => {
    expect(spaceShortcutIndex(key({ key: '3', ctrlKey: true }))).toBe(2)
  })

  it('不带修饰键的裸数字不认 —— 那是用户在打字', () => {
    expect(spaceShortcutIndex(key({ key: '1' }))).toBeNull()
  })

  it('⌘0 不认(空间从 1 数起,0 没有对应项)', () => {
    expect(spaceShortcutIndex(key({ key: '0', metaKey: true }))).toBeNull()
  })

  it('⌥ / ⇧ 一律不认 —— 那些组合留给别人', () => {
    expect(spaceShortcutIndex(key({ key: '1', metaKey: true, altKey: true }))).toBeNull()
    // ⌘⇧7/8/9 是笔记编辑器的列表命令,不能被空间切换吃掉。
    expect(spaceShortcutIndex(key({ key: '7', metaKey: true, shiftKey: true }))).toBeNull()
  })

  it('非数字键不认', () => {
    expect(spaceShortcutIndex(key({ key: 'a', metaKey: true }))).toBeNull()
    expect(spaceShortcutIndex(key({ key: 'Enter', metaKey: true }))).toBeNull()
  })
})

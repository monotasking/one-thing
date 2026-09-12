import { describe, expect, it } from 'vitest'
import { boundChordsFor, chordOfCombo } from '../keymap-downlink'
import { KEYMAP_COMMANDS, effectiveCombo } from '../../../keymap/transitions'

/**
 * **两端要对同一个键说同一个名字**(B2 §9-1)。
 *
 * 判据的产地是主进程那一侧的 `chordOf`(`electron/browser/keymap-bridge.ts`):
 * 修饰键固定次序 `cmd → ctrl → alt → shift`、主键小写。这一组钉的是壳这一侧
 * 按同一套规则把 `Combo` 写成串 —— 尤其是**「主修饰键是哪一枚」必须在这里就
 * 解释掉**:主进程收到的是一次真按键(mac 上 `meta: true`),把 `ctrl` 原样推
 * 下去,mac 上一条写成 `{ctrl:true}` 的出厂绑定会永远对不上。
 */

describe('一条绑定 → 一个串', () => {
  it('主修饰键按平台落地:mac 写 cmd,其余写 ctrl', () => {
    expect(chordOfCombo({ meta: true, key: 'l' }, 'mac')).toBe('cmd+l')
    expect(chordOfCombo({ meta: true, key: 'l' }, 'other')).toBe('ctrl+l')
    // **出厂的 `toggle:terminal` 写的是 `ctrl`**,而它在 mac 上按的是 ⌘ ——
    // 两种拼法都读作「主修饰键」(`matchCombo`,T1-fix)。
    expect(chordOfCombo({ ctrl: true, key: '`' }, 'mac')).toBe('cmd+`')
    expect(chordOfCombo({ ctrl: true, key: '`' }, 'other')).toBe('ctrl+`')
  })

  it('修饰键次序固定,主键小写', () => {
    expect(chordOfCombo({ meta: true, alt: true, shift: true, key: 'ArrowLeft' }, 'mac')).toBe(
      'cmd+alt+shift+arrowleft',
    )
    // 没有修饰键的那一档(今天表里没有,但写法要对)。
    expect(chordOfCombo({ key: 'F5' }, 'mac')).toBe('f5')
  })
})

describe('整表', () => {
  it('全局命令 ∪ 那几个作用域的局部键,去重且排序', () => {
    const chords = boundChordsFor(['browser'], {}, 'mac')
    // `browser` 那条局部键(⌘L)在表里 —— 它是保留键,得先于页面。
    expect(chords).toContain('cmd+l')
    // 全局命令也在(⌘P 检索面 / ⌘E 会话总览)。
    expect(chords).toContain('cmd+p')
    expect(chords).toContain('cmd+e')
    // 去重 + 排序:同一个串只出现一次,整表有序(两端比对的是集合)。
    expect(new Set(chords).size).toBe(chords.length)
    expect([...chords].sort()).toEqual(chords)
  })

  it('改绑跟着走 —— 表是从 `overrides` 现算的,不是一份快照', () => {
    const before = boundChordsFor([], {}, 'mac')
    const after = boundChordsFor([], { 'toggle:search': { meta: true, key: 'k' } }, 'mac')
    expect(before).toContain('cmd+p')
    expect(after).not.toContain('cmd+p')
    expect(after).toContain('cmd+k')
  })

  it('解绑(`null`)的命令不进表 —— 那个组合该归页面', () => {
    const chords = boundChordsFor([], { 'toggle:search': null }, 'mac')
    expect(chords).not.toContain('cmd+p')
  })

  it('表里每一条都真的对应一条**有绑定**的命令(不多不少)', () => {
    const chords = new Set(boundChordsFor([], {}, 'mac'))
    const bound = KEYMAP_COMMANDS.filter((c) => effectiveCombo({ overrides: {} }, c.id) !== null)
    for (const command of bound) {
      const combo = effectiveCombo({ overrides: {} }, command.id)!
      expect(chords.has(chordOfCombo(combo, 'mac'))).toBe(true)
    }
  })
})

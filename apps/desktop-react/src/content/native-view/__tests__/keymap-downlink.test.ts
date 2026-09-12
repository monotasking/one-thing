import { describe, expect, it } from 'vitest'
import { boundChordsFor, chordOfCombo } from '../keymap-downlink'
import { KEYMAP_COMMANDS, effectiveCombos } from '../../../keymap/transitions'
import { focusScopeAnswersOf } from '../../../focus/scopes'

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
    const after = boundChordsFor([], { 'toggle:search': [{ meta: true, key: 'k' }] }, 'mac')
    expect(before).toContain('cmd+p')
    expect(after).not.toContain('cmd+p')
    expect(after).toContain('cmd+k')
  })

  it('解绑(`null`)的命令不进表 —— 那个组合该归页面', () => {
    const chords = boundChordsFor([], { 'toggle:search': null }, 'mac')
    expect(chords).not.toContain('cmd+p')
  })

  it('表里每一条都真的对应一条**有绑定的应用级**命令(不多不少)', () => {
    /*
     * K0:进表的判据从「是不是全局命令」变成了**命令表上的两格数据**
     * (`nativeView === 'reserve'` ∧ 有绑定 ∧(`app` ∨ 在场的作用域答得出))。
     * 不给作用域时,进表的就只剩应用级那一族 —— `view.save` 这类跟随焦点的命令
     * 不该被推下去:查看器与那片原生视图不会同时在场,推下去只会让页面自己的
     * ⌘S 变成一个什么都不做的键。
     */
    const chords = new Set(boundChordsFor([], {}, 'mac'))
    const bound = KEYMAP_COMMANDS.filter(
      (c) => c.app && effectiveCombos({ overrides: {} }, c.id).length > 0,
    )
    for (const command of bound) {
      for (const combo of effectiveCombos({ overrides: {} }, command.id)) {
        expect(chords.has(chordOfCombo(combo, 'mac')), command.id).toBe(true)
      }
    }
    // 跟随焦点那一族,没有在场的作用域就一条都不进表。
    expect(chords.has('cmd+s')).toBe(false)
    expect(chords.has('cmd+i')).toBe(false)
  })

  /**
   * **K0 零行为变化的那把尺子**:改前推下去的键集逐字写成字面量,改后必须相等。
   *
   * 这十九条是 2026-09-12 K0 开工前在 `boundChordsFor(['browser'], {}, …)` 上
   * 实测出来的(13 条应用级出厂键 + `browser` 那两条局部键 ⌘L / ⌘F,再加四条
   * 架子)。**多一条**就是某个跟随焦点的命令被错误地下沉了(页面自己的那个键
   * 会变成哑键);**少一条**就是壳的某个保留键被让给了页面。
   */
  const LEGACY_BROWSER_CHORDS_MAC = [
    'cmd+1',
    'cmd+2',
    'cmd+3',
    'cmd+`',
    'cmd+alt+arrowdown',
    'cmd+alt+arrowleft',
    'cmd+alt+arrowright',
    'cmd+alt+arrowup',
    'cmd+alt+shift+arrowleft',
    'cmd+alt+shift+arrowright',
    'cmd+e',
    'cmd+f',
    'cmd+j',
    'cmd+l',
    'cmd+n',
    'cmd+p',
    'cmd+shift+enter',
    'cmd+shift+o',
    'cmd+shift+w',
  ]

  it('推下去的键集与 K0 之前逐字相等(mac 档)', () => {
    expect(boundChordsFor(['browser'], {}, 'mac')).toEqual(LEGACY_BROWSER_CHORDS_MAC)
  })

  it('Win / Linux 档同一张表,只换主修饰键的写法', () => {
    expect(boundChordsFor(['browser'], {}, 'other')).toEqual(
      LEGACY_BROWSER_CHORDS_MAC.map((c) => c.replace(/^cmd\+/, 'ctrl+')).sort(),
    )
  })

  it('⌘L / ⌘F 进表是因为 `browser` **答得出**那两条命令,不是因为它叫 browser', () => {
    // 拆掉 `BROWSER_ANSWERS` 里任意一条 → 这一条与上面那张字面量表一起红。
    expect(focusScopeAnswersOf('browser').map((a) => a.command)).toEqual([
      'browser.address',
      'view.find',
    ])
    const without = boundChordsFor([], {}, 'mac')
    expect(without).not.toContain('cmd+l')
    expect(without).not.toContain('cmd+f')
  })
})

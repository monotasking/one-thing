import { describe, expect, it } from 'vitest'
import { chordOfCombo, comboOfChord } from '../chord'
import { KEYMAP_COMMANDS } from '../commands'
import { effectiveCombos, sameCombo } from '../transitions'
import type { Combo, KeymapPlatform } from '../types'

/**
 * **规范串两向互逆**(K5,`keymap/chord.ts`)。
 *
 * 为什么这一组值得存在:K5 之前「⌘⇧F 写成 `cmd+shift+f`」只有一个方向,而它是
 * 推给主进程的中间产物 —— 没人需要读回来,于是也没人保证读得回来。键位组的文件
 * 形把同一句话落到了**磁盘**上:写出去读不回来,导出的文件就是一堆废纸。
 *
 * 互逆有两句,缺一不可:
 *  · combo → 串 → combo:`sameCombo` 相等(`meta` 与 `ctrl` 是同一件事的两种拼法,
 *    所以这一头不能要求逐字相等);
 *  · 串 → combo → 串:**逐字**相等(写出去那一侧有固定次序,读进来那一侧宽容 ——
 *    宽容的入口不许改变规范的出口)。
 */

const PLATFORMS: KeymapPlatform[] = ['mac', 'other']

describe('规范串:两向互逆', () => {
  it('出厂表里每一条绑定写出去再读回来都是同一条(两台机器各走一遍)', () => {
    for (const platform of PLATFORMS) {
      for (const command of KEYMAP_COMMANDS) {
        for (const combo of effectiveCombos({ overrides: {} }, command.id)) {
          const chord = chordOfCombo(combo, platform)
          const back = comboOfChord(chord, platform)
          expect(back, `${command.id} / ${platform} / ${chord}`).not.toBeNull()
          expect(sameCombo(back as Combo, combo), `${command.id} / ${chord}`).toBe(true)
          // 读回来再写出去逐字相等 —— 规范的出口只有一个。
          expect(chordOfCombo(back as Combo, platform)).toBe(chord)
        }
      }
    }
  })

  it('「另一枚」两台机器上写成两个词,而且各自读得回来', () => {
    const offHand: Combo = { offHand: true, key: 'tab' }
    expect(chordOfCombo(offHand, 'mac')).toBe('ctrl+tab')
    expect(chordOfCombo(offHand, 'other')).toBe('cmd+tab')
    expect(comboOfChord('ctrl+tab', 'mac')).toEqual({ offHand: true, key: 'tab' })
    expect(comboOfChord('cmd+tab', 'other')).toEqual({ offHand: true, key: 'tab' })
  })

  it('主修饰键两种拼法写出同一个串,读回来固定是 meta', () => {
    expect(chordOfCombo({ meta: true, key: 'w' }, 'mac')).toBe('cmd+w')
    expect(chordOfCombo({ ctrl: true, key: 'w' }, 'mac')).toBe('cmd+w')
    expect(comboOfChord('cmd+w', 'mac')).toEqual({ meta: true, key: 'w' })
    expect(comboOfChord('ctrl+w', 'other')).toEqual({ meta: true, key: 'w' })
  })

  it('修饰键次序不管,但写出去的次序固定 cmd → ctrl → alt → shift', () => {
    const a = comboOfChord('shift+cmd+]', 'mac')
    const b = comboOfChord('cmd+shift+]', 'mac')
    expect(a).toEqual(b)
    expect(chordOfCombo(a as Combo, 'mac')).toBe('cmd+shift+]')
  })

  it('主键本身是 + 的那一档读得出来(末位那个 + 是键不是分隔符)', () => {
    expect(chordOfCombo({ meta: true, key: '+' }, 'mac')).toBe('cmd++')
    expect(comboOfChord('cmd++', 'mac')).toEqual({ meta: true, key: '+' })
    expect(comboOfChord('+', 'mac')).toEqual({ key: '+' })
  })

  it('读不出就是 null —— 不猜', () => {
    expect(comboOfChord('', 'mac')).toBeNull()
    expect(comboOfChord('   ', 'mac')).toBeNull()
    expect(comboOfChord('cmd+', 'mac')).toBeNull()
    expect(comboOfChord('hyper+f', 'mac')).toBeNull()
    // 两枚修饰键都要的组合这台壳不收(判词在 `Combo.offHand` 上)。
    expect(comboOfChord('cmd+ctrl+tab', 'mac')).toBeNull()
  })
})

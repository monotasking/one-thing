import { describe, expect, it } from 'vitest'
import {
  comboFromEvent,
  effectiveCombos,
  formatCombo,
  initialKeymapState,
  lookupCommands,
  matchCombo,
  platformOf,
  recordKey,
  sameCombo,
} from '../transitions'
import { TERMINAL_SUMMON_COMBOS, comboForPlatform } from '../commands'
import type { Combo, ComboEvent } from '../types'

/**
 * **`Combo.offHand`:声明侧说得出「就是另一枚」**(K2,方案
 * `apps/desktop-react/docs/keymap-responder-2026-09.md` §5 K2)。
 *
 * ── 它治的是什么 ────────────────────────────────────────────────────────
 * T1 立法时把「另一枚修饰键永远不参与绑定」写成了按下侧的一道闸
 * (`offHandPressed`),于是这张表**说不出** ⌃Tab:写 `{ctrl:true,key:'tab'}` 在
 * mac 上读作 ⌘Tab(声明侧 `meta` 与 `ctrl` 同义),而 ⌃Tab / ⌃⇧Tab 恰恰是跨应用
 * 三十年的「下 / 上一个标签」。壳 CLAUDE.md 那条留账(「今天的 `Combo` 表达不出
 * 『就是 Ctrl 那一枚』」)随本单结清。
 *
 * 四件事各一节:**按下侧**(三平台)、**身份**(`sameCombo`)、**键面**
 * (`formatCombo`)、**出厂表上那三条**真的落到了这一档。
 *
 * **K5 补上第五节:录制**。K2 交卷时留了一笔账 —— 「录制录不出 `offHand`,
 * 设置页录 ⌃Tab 仍读成 `{ctrl:true}`」,也就是用户按的是一枚键、存下来的是另一枚。
 * 判据与 `matchCombo` 的 offHand 那一支逐字相同:另一枚按着**且主修饰键没按**。
 */

function press(key: string, mods: Partial<Omit<ComboEvent, 'key'>> = {}): ComboEvent {
  return {
    key,
    metaKey: mods.metaKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  }
}

const CTRL_TAB: Combo = { offHand: true, key: 'tab' }
const CTRL_SHIFT_TAB: Combo = { offHand: true, shift: true, key: 'tab' }

describe('按下侧:另一枚按着,而且主修饰键没按', () => {
  it('mac:⌃Tab 命中,⌘Tab 不命中', () => {
    expect(matchCombo(press('Tab', { ctrlKey: true }), CTRL_TAB, 'mac')).toBe(true)
    expect(matchCombo(press('Tab', { metaKey: true }), CTRL_TAB, 'mac')).toBe(false)
    // 裸 Tab 也不是它 —— 那是结构键(第三层,不进任何表)。
    expect(matchCombo(press('Tab'), CTRL_TAB, 'mac')).toBe(false)
  })

  it('win / linux:Win+Tab 命中,Ctrl+Tab 不命中(那边 Ctrl 是主修饰键)', () => {
    expect(matchCombo(press('Tab', { metaKey: true }), CTRL_TAB, 'other')).toBe(true)
    expect(matchCombo(press('Tab', { ctrlKey: true }), CTRL_TAB, 'other')).toBe(false)
  })

  /**
   * **两枚同按不是这一条**。判据是 `primaryHeldIn`(主修饰键那一枚按着没有),
   * 不是 `primaryPressedIn`(它在两枚同按时也答 false)—— 拿后者当这一句,
   * mac 上 ⌃⌘Tab 会命中 ⌃Tab。拆掉 `!primaryHeldIn(...)` → 这一条红。
   */
  it('⌃⌘Tab 不是 ⌃Tab(两枚同按一律不算)', () => {
    expect(matchCombo(press('Tab', { ctrlKey: true, metaKey: true }), CTRL_TAB, 'mac')).toBe(false)
    expect(matchCombo(press('Tab', { ctrlKey: true, metaKey: true }), CTRL_TAB, 'other')).toBe(false)
  })

  it('⇧ 逐位相等:⌃Tab 与 ⌃⇧Tab 是两条', () => {
    expect(matchCombo(press('Tab', { ctrlKey: true }), CTRL_SHIFT_TAB, 'mac')).toBe(false)
    expect(matchCombo(press('Tab', { ctrlKey: true, shiftKey: true }), CTRL_SHIFT_TAB, 'mac')).toBe(
      true,
    )
    expect(matchCombo(press('Tab', { ctrlKey: true, shiftKey: true }), CTRL_TAB, 'mac')).toBe(false)
  })

  /**
   * **不带 `offHand` 的绑定,那道闸一个字没改**(T1 的病历:mac 上 ^W 会触发
   * ⌘W,而 `^W` 在 readline 下是「删一个词」)。
   */
  it('老那一档照旧:mac 上 ⌃W 不命中 ⌘W', () => {
    const cmdW: Combo = { meta: true, key: 'w' }
    expect(matchCombo(press('w', { metaKey: true }), cmdW, 'mac')).toBe(true)
    expect(matchCombo(press('w', { ctrlKey: true }), cmdW, 'mac')).toBe(false)
  })
})

describe('身份与键面', () => {
  it('`sameCombo`:⌃Tab 与 ⌘Tab 不是同一条绑定', () => {
    expect(sameCombo(CTRL_TAB, { meta: true, key: 'tab' })).toBe(false)
    expect(sameCombo(CTRL_TAB, { ctrl: true, key: 'tab' })).toBe(false)
    expect(sameCombo(CTRL_TAB, { key: 'tab' })).toBe(false)
    expect(sameCombo(CTRL_TAB, { offHand: true, key: 'tab' })).toBe(true)
    expect(sameCombo(CTRL_TAB, CTRL_SHIFT_TAB)).toBe(false)
  })

  it('`formatCombo`:mac 画 ⌃,别处画 Win', () => {
    expect(formatCombo(CTRL_TAB, 'mac')).toEqual(['⌃', 'Tab'])
    expect(formatCombo(CTRL_TAB, 'other')).toEqual(['Win', 'Tab'])
    expect(formatCombo(CTRL_SHIFT_TAB, 'mac')).toEqual(['⌃', '⇧', 'Tab'])
    // 主修饰那一族一个字没变。
    expect(formatCombo({ meta: true, shift: true, key: ']' }, 'mac')).toEqual(['⌘', '⇧', ']'])
  })
})

describe('出厂表上那三条真的在这一档', () => {
  it('`tab.next` / `tab.prev` 的第二个键是 offHand(两台机器上都一样)', () => {
    expect(effectiveCombos(initialKeymapState, 'tab.next')[1]).toEqual(CTRL_TAB)
    expect(effectiveCombos(initialKeymapState, 'tab.prev')[1]).toEqual(CTRL_SHIFT_TAB)
  })

  /**
   * **召唤终端那一条不在这一档,它按平台分档**(K2 修一轮,`byPlatform`)。
   *
   * 判词整段在 `commands.ts` 的 `byPlatform` 上:那一条要的是「两台机器上都按
   * Ctrl 那一枚」,而 `offHand`(非主修饰键)在 Win / Linux 上是 Win 键 ——
   * 一行声明说不出这句话,因为它**本来就是两档**。
   */
  it('`toggle:terminal` 走 `byPlatform`:mac 是 offHand,其余是主修饰键', () => {
    expect(comboForPlatform(TERMINAL_SUMMON_COMBOS, 'mac')).toEqual({ offHand: true, key: '`' })
    expect(comboForPlatform(TERMINAL_SUMMON_COMBOS, 'other')).toEqual({ ctrl: true, key: '`' })
    // 这台机器出厂就是它自己那一档。
    expect(effectiveCombos(initialKeymapState, 'toggle:terminal')).toEqual([
      comboForPlatform(TERMINAL_SUMMON_COMBOS, platformOf(navigator.userAgent)),
    ])
  })

  /**
   * **整条路走一遍**:一次真按键 → 候选命令集。这一条才是「⌃Tab 真的能换标签」
   * 的入口(`routeKey` 随后拿这个候选集沿活动路径问叶)。
   */
  it('mac:⌃Tab 落在 `tab.next` 上,⌘Tab 谁都不落', () => {
    expect(lookupCommands(initialKeymapState, press('Tab', { ctrlKey: true }), 'mac')).toEqual([
      'tab.next',
    ])
    expect(
      lookupCommands(initialKeymapState, press('Tab', { ctrlKey: true, shiftKey: true }), 'mac'),
    ).toEqual(['tab.prev'])
    expect(lookupCommands(initialKeymapState, press('Tab', { metaKey: true }), 'mac')).toEqual([])
  })

  it('win / linux:Win+Tab 落在 `tab.next` 上,Ctrl+Tab 谁都不落', () => {
    expect(lookupCommands(initialKeymapState, press('Tab', { metaKey: true }), 'other')).toEqual([
      'tab.next',
    ])
    expect(lookupCommands(initialKeymapState, press('Tab', { ctrlKey: true }), 'other')).toEqual([])
  })
})

describe('录制:认得出「另一枚」(K5,结清 K2 那笔账)', () => {
  it('mac:录 ⌃Tab 得 offHand,录 ⌘Tab 得 meta', () => {
    expect(comboFromEvent(press('Tab', { ctrlKey: true }), 'mac')).toEqual({
      offHand: true,
      key: 'tab',
    })
    expect(comboFromEvent(press('Tab', { metaKey: true }), 'mac')).toEqual({
      meta: true,
      key: 'tab',
    })
  })

  it('win / linux:录 Win+Tab 得 offHand,录 Ctrl+Tab 得主修饰键', () => {
    expect(comboFromEvent(press('Tab', { metaKey: true }), 'other')).toEqual({
      offHand: true,
      key: 'tab',
    })
    expect(comboFromEvent(press('Tab', { ctrlKey: true }), 'other')).toEqual({
      ctrl: true,
      key: 'tab',
    })
  })

  it('⌥ / ⇧ 照旧叠在上面;录出来的那一条真的能被同一下按键命中', () => {
    const combo = comboFromEvent(press('Tab', { ctrlKey: true, shiftKey: true }), 'mac')
    expect(combo).toEqual({ offHand: true, shift: true, key: 'tab' })
    expect(matchCombo(press('Tab', { ctrlKey: true, shiftKey: true }), combo as Combo, 'mac')).toBe(
      true,
    )
  })

  it('`recordKey` 走的是同一只(录制态那一口也认得出另一枚)', () => {
    expect(recordKey(press('`', { ctrlKey: true }), 'mac')).toEqual({
      kind: 'bind',
      combo: { offHand: true, key: '`' },
    })
  })
})

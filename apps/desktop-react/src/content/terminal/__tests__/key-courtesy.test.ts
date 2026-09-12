import { describe, expect, it } from 'vitest'
import {
  TERMINAL_CLAIMS,
  TERMINAL_COURTESY_LETTERS,
  appAlreadyTookKey,
  terminalClaims,
} from '../key-courtesy'
import { FOCUS_SCOPES } from '../../../focus/scopes'
import { KEYMAP_COMMANDS, effectiveCombos, matchCombo, sameCombo } from '../../../keymap/transitions'
import { scopesAnswering } from '../../../keymap/commands'
import { en } from '../../../i18n/en'
import { zh } from '../../../i18n/zh'

/**
 * **键盘认领表的守卫**(T1 立,K0 改名 —— 它从「伪装成局部键」改回了它本来的
 * 样子:一张 `claims`)。
 *
 * 这一组把那张表的**判据**钉住 —— 不是钉住「今天写着 p/e/j/n/w」这个事实,
 * 而是钉住「它们是从哪一条规则算出来的」:出厂命令表里占着「主修饰键 + 单个
 * 字母」的那几条,就是这张表。哪天有人给某条命令绑上 ⌘K,这一组会说「表该更新了」。
 */

/**
 * 出厂表里「主修饰键 + 一个字母、没有 ⌥ 没有 ⇧」、而且**会把这个键从终端手里
 * 拿走**的那些命令绑的字母。
 *
 * 后半句是判据的要害,K0 之后它必须写出来:命令表上如今也有 `view.save`(⌘S)、
 * `viewer.gotoLine` / `browser.address`(⌘L)这些**跟随焦点**的命令,而它们的
 * 响应者(查看器 / 浏览器)与终端**不会同时在一条活动路径上** —— 在终端里按
 * `Ctrl+S` / `Ctrl+L`,派发器沿路径问一圈问不到人、也没有应用层兜底,于是不
 * `preventDefault`,`^S` / `^L` 照常进 PTY。给它们各写一个认领只会在设置页的
 * 「谁答」列上长出一串永远不会发生的行。
 *
 * 真会拿走这个键的只有两族:**应用级命令**(焦点在哪儿都响),以及**装着这格
 * 终端的那片叶**答得出的命令(`leaf` 是 `terminal` 的祖先,由深到浅问得到它)。
 * T1 那一版的原话「出厂全局表 + `focus/scopes.ts` 的 `leaf`」说的正是这两族,
 * 只是那时候它们分住两张表。
 */
function factoryPlainLetterCommands(): string[] {
  const out: string[] = []
  for (const command of KEYMAP_COMMANDS) {
    const takesItAway = command.app || scopesAnswering(command.id).includes('leaf')
    if (!takesItAway) continue
    for (const combo of effectiveCombos({ overrides: {} }, command.id)) {
      if (combo.alt || combo.shift) continue
      if (!(combo.meta || combo.ctrl)) continue
      if (!/^[a-z]$/.test(combo.key)) continue
      out.push(combo.key)
    }
  }
  return out
}

describe('表是算出来的,不是抄出来的', () => {
  it('认领的字母 = 出厂表里被「主修饰键 + 单字母」占着的那几个,一个不多一个不少', () => {
    /*
     * 这一条是这张表的**判据本身**。加一条 `⌘K` 的命令而不更新认领表 →
     * 当场红,提示是「终端里 ^K 会被应用吃掉」;反过来往表里塞一个没人占着的
     * 字母(比如 `c`)也红,提示是「^C 本来就到得了 PTY,别在这张表里加噪音」。
     *
     * K0 之后 `tab.close`(⌘W)也在同一张命令表里,所以这一条不必再像 T1 那样
     * 从两个产地各捞一遍(那时 `leaf` 的 ⌘W 是局部键,不在命令表上);
     * 「会不会把键拿走」那一半的判词写在 `factoryPlainLetterCommands` 上。
     */
    expect([...TERMINAL_COURTESY_LETTERS].sort()).toEqual(factoryPlainLetterCommands().sort())
  })

  it('三条例外(Ctrl+Tab 族 / Ctrl+` / Ctrl+,)结构上就进不来:这张表只收单个字母', () => {
    for (const letter of TERMINAL_COURTESY_LETTERS) expect(letter).toMatch(/^[a-z]$/)
    // 召唤终端那条命令用的正是反引号 —— 它进了表就再也收不起来。
    expect(effectiveCombos({ overrides: {} }, 'toggle:terminal')).toEqual([
      { ctrl: true, key: '`' },
    ])
    expect(TERMINAL_COURTESY_LETTERS).not.toContain('`')
  })

  /**
   * **按平台分档,而这是判据不是省事**(T1-fix,方案 §2.1-7 的原形)。
   *
   * mac 空表成立的**前提**就在下面这两句里:`Ctrl+P` 在 mac 上命中不了任何一条
   * 绑定(主修饰键是 ⌘),于是派发器不 `preventDefault`,xterm 照常把 `^P` 发给
   * PTY —— 一行声明都不用写。把 `matchCombo` 改回「⌘ 与 Ctrl 皆可」,这一条当场红。
   */
  it('mac:空表,因为 Ctrl 那一枚根本命中不了任何绑定', () => {
    expect(terminalClaims('mac')).toEqual([])
    const searchCombo = effectiveCombos({ overrides: {} }, 'toggle:search')[0]
    expect(searchCombo).toEqual({ meta: true, key: 'p' })
    const ctrlP = { metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, key: 'p' }
    const cmdP = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: 'p' }
    expect(matchCombo(ctrlP, searchCombo, 'mac')).toBe(false) // ^P 归 PTY
    expect(matchCombo(cmdP, searchCombo, 'mac')).toBe(true) // ⌘P 照旧开检索面
  })

  it('win / linux:那五个在场,而且每一个都与它挡下的那条绑定是同一个组合', () => {
    const claims = terminalClaims('other')
    expect(claims).toEqual(TERMINAL_COURTESY_LETTERS.map((letter) => ({ ctrl: true, key: letter })))
    const searchCombo = effectiveCombos({ overrides: {} }, 'toggle:search')[0]
    // 同一个组合 → 认领先命中才拦得住(这件事由设置页的「谁答」列说出口)。
    expect(sameCombo(claims[0], searchCombo)).toBe(true)
    const ctrlP = { metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, key: 'p' }
    expect(matchCombo(ctrlP, claims[0], 'other')).toBe(true)
  })

  it('这台机器上那一份就是按它的平台算出来的(模块加载时量一次)', () => {
    // 测试跑在 jsdom 上(UA 不是 mac),所以这里应当是 Win / Linux 那一档。
    expect(TERMINAL_CLAIMS).toEqual(terminalClaims('other'))
  })
})

describe('认领不是命令', () => {
  it('作用域表上装着它们,而且装在 `claims` 那一格(不是 `answers`)', () => {
    expect(FOCUS_SCOPES.terminal.claims).toEqual([...TERMINAL_CLAIMS])
    // `answers` 那一格是反着的一句话:那一条 ⌘F 归应用,不交给 PTY。
    expect(FOCUS_SCOPES.terminal.answers?.map((a) => a.command)).toEqual(['view.find'])
  })

  it('「交给终端」那句文案在两本字典里都真有一条(设置页的「谁答」列读它)', () => {
    expect(zh['terminal.keyToPty']).toBeTruthy()
    expect(en['terminal.keyToPty']).toBeTruthy()
  })
})

describe('xterm 侧那唯一一行', () => {
  it('**应用已经拿走的键不再进 PTY**(反证:把这条判据改成恒 false,按 ⌘K 时 PTY 会收到字节)', () => {
    expect(appAlreadyTookKey({ defaultPrevented: true })).toBe(true)
    expect(appAlreadyTookKey({ defaultPrevented: false })).toBe(false)
  })

  /**
   * **K0 的那一格**:认领命中时派发器**不** `preventDefault`,所以这只守卫会放行,
   * xterm 自己把 `^P` 写成 `\x10` 发下去。从前是壳先截下来、再由
   * `session.sendCourtesyKey` 把同一个字节写一遍(`controlByteOf` 与它一起退役)。
   */
  it('认领放行的那一下 `defaultPrevented` 是 false,所以它到得了 PTY', () => {
    expect(appAlreadyTookKey({ defaultPrevented: false })).toBe(false)
  })
})

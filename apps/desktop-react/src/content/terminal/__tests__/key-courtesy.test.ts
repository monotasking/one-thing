import { describe, expect, it } from 'vitest'
import {
  TERMINAL_COURTESY_LETTERS,
  TERMINAL_SCOPED_KEYS,
  appAlreadyTookKey,
  controlByteOf,
  terminalPtyKeyAction,
  terminalScopedKeys,
} from '../key-courtesy'
import { FOCUS_SCOPES } from '../../../focus/scopes'
import { KEYMAP_COMMANDS, effectiveCombo, matchCombo, sameCombo } from '../../../keymap/transitions'
import { en } from '../../../i18n/en'
import { zh } from '../../../i18n/zh'

/**
 * **键盘礼让表的守卫**(T1)。
 *
 * 这一组把那张表的**判据**钉住 —— 不是钉住「今天写着 p/e/j/n/w」这个事实,
 * 而是钉住「它们是从哪一条规则算出来的」:出厂全局表(含 `leaf` 的 ⌘W)里
 * 占着「主修饰键 + 单个字母」的那几条,就是这张表。哪天有人给某条命令绑上
 * ⌘K,这一组会说「表该更新了」。
 */

/** 出厂表里「主修饰键 + 一个字母、没有 ⌥ 没有 ⇧」的那些命令绑的字母。 */
function factoryPlainLetterCommands(): string[] {
  const out: string[] = []
  for (const command of KEYMAP_COMMANDS) {
    const combo = effectiveCombo({ overrides: {} }, command.id)
    if (!combo) continue
    if (combo.alt || combo.shift) continue
    if (!(combo.meta || combo.ctrl)) continue
    if (!/^[a-z]$/.test(combo.key)) continue
    out.push(combo.key)
  }
  // `leaf` 的 ⌘W 不是全局命令,它是一格局部键 —— 但对 PTY 来说后果一样。
  for (const scoped of FOCUS_SCOPES.leaf.keys ?? []) {
    if (/^[a-z]$/.test(scoped.combo.key)) out.push(scoped.combo.key)
  }
  return out
}

describe('表是算出来的,不是抄出来的', () => {
  it('礼让的字母 = 出厂表里被「主修饰键 + 单字母」占着的那几个,一个不多一个不少', () => {
    /*
     * 这一条是这张表的**判据本身**。加一条 `⌘K` 的全局命令而不更新礼让表 →
     * 当场红,提示是「终端里 ^K 会被应用吃掉」;反过来往表里塞一个没人占着的
     * 字母(比如 `c`)也红,提示是「^C 本来就到得了 PTY,别在撞键表里加噪音」。
     */
    expect([...TERMINAL_COURTESY_LETTERS].sort()).toEqual(factoryPlainLetterCommands().sort())
  })

  it('三条例外(Ctrl+Tab 族 / Ctrl+` / Ctrl+,)结构上就进不来:这张表只收单个字母', () => {
    for (const letter of TERMINAL_COURTESY_LETTERS) expect(letter).toMatch(/^[a-z]$/)
    // 召唤终端那条命令用的正是反引号 —— 它进了表就再也收不起来。
    const summon = effectiveCombo({ overrides: {} }, 'toggle:terminal')
    expect(summon).toEqual({ ctrl: true, key: '`' })
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
    expect(terminalScopedKeys('mac')).toEqual([])
    const searchCombo = effectiveCombo({ overrides: {} }, 'toggle:search')
    expect(searchCombo).toEqual({ meta: true, key: 'p' })
    const ctrlP = { metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, key: 'p' }
    const cmdP = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: 'p' }
    expect(matchCombo(ctrlP, searchCombo!, 'mac')).toBe(false) // ^P 归 PTY
    expect(matchCombo(cmdP, searchCombo!, 'mac')).toBe(true) // ⌘P 照旧开检索面
  })

  it('win / linux:那五行在场,而且每一行都与它挡下的那条全局绑定是同一个组合', () => {
    const rows = terminalScopedKeys('other')
    expect(rows.map((k) => k.combo)).toEqual(
      TERMINAL_COURTESY_LETTERS.map((letter) => ({ ctrl: true, key: letter })),
    )
    const searchCombo = effectiveCombo({ overrides: {} }, 'toggle:search')
    // 同一个组合 → 局部先接才拦得住(撞键由 `scopedCollisionsOf` 说出口)。
    expect(sameCombo(rows[0].combo, searchCombo!)).toBe(true)
    const ctrlP = { metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, key: 'p' }
    expect(matchCombo(ctrlP, rows[0].combo, 'other')).toBe(true)
  })

  it('这台机器上那一份就是按它的平台算出来的(模块加载时量一次)', () => {
    // 测试跑在 jsdom 上(UA 不是 mac),所以这里应当是 Win / Linux 那一档。
    expect(TERMINAL_SCOPED_KEYS).toEqual(terminalScopedKeys('other'))
  })
})

describe('一行一个组合,名字与文案都对得上', () => {
  it('五行各自带 ctrl、带自己的 action、共用一句文案(Win / Linux 那一档)', () => {
    const rows = terminalScopedKeys('other')
    expect(rows.map((k) => k.combo)).toEqual(
      TERMINAL_COURTESY_LETTERS.map((letter) => ({ ctrl: true, key: letter })),
    )
    expect(rows.map((k) => k.action)).toEqual(TERMINAL_COURTESY_LETTERS.map(terminalPtyKeyAction))
    expect(new Set(rows.map((k) => k.labelKey)).size).toBe(1)
  })

  it('那句文案在两本字典里都真有一条', () => {
    expect(zh['terminal.keyToPty']).toBeTruthy()
    expect(en['terminal.keyToPty']).toBeTruthy()
  })

  it('作用域表上装的就是这几行(声明只有一个产地)', () => {
    expect(FOCUS_SCOPES.terminal.keys).toBe(TERMINAL_SCOPED_KEYS)
  })
})

describe('控制字节是编码算出来的,不是一张查找表', () => {
  it('w → 0x17 / p → 0x10 / e → 0x05 / j → 0x0A / n → 0x0E', () => {
    expect(controlByteOf('w')).toBe('\x17')
    expect(controlByteOf('p')).toBe('\x10')
    expect(controlByteOf('e')).toBe('\x05')
    expect(controlByteOf('j')).toBe('\x0a')
    expect(controlByteOf('n')).toBe('\x0e')
    // 大小写不是第二种真相。
    expect(controlByteOf('W')).toBe(controlByteOf('w'))
  })
})

describe('xterm 侧那唯一一行', () => {
  it('**应用已经拿走的键不再进 PTY**(反证:把这条判据改成恒 false,按 ⌘K 时 PTY 会收到字节)', () => {
    expect(appAlreadyTookKey({ defaultPrevented: true })).toBe(true)
    expect(appAlreadyTookKey({ defaultPrevented: false })).toBe(false)
  })
})

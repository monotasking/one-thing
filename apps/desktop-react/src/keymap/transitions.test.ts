import { describe, expect, it } from 'vitest'
import { STAGE_ITEMS } from '../stage/items'
import {
  KEYMAP_COMMANDS,
  KEYMAP_PERSIST_VERSION,
  bindCombo,
  comboFromEvent,
  effectiveCombo,
  findCommand,
  formatCombo,
  hasModifier,
  hasOverride,
  initialKeymapState,
  lookupCommand,
  matchCombo,
  migrateKeymapPersisted,
  normalizeKey,
  platformOf,
  recordKey,
  resetCombo,
  sameCombo,
  unbindCombo,
} from './transitions'
import type { Combo, ComboEvent, KeymapState } from './types'

/** 真事件的五个字段,给个趁手的构造器 —— 测试里不该到处写 false, false, false。 */
function press(key: string, mods: Partial<Omit<ComboEvent, 'key'>> = {}): ComboEvent {
  return {
    key,
    metaKey: mods.metaKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  }
}

const CMD_P: Combo = { meta: true, key: 'p' }

describe('命令表', () => {
  it('每个非 takeover 的瓦恰有一条 toggle,takeover 的一条都没有', () => {
    const toggles = KEYMAP_COMMANDS.filter((c) => c.id.startsWith('toggle:')).map((c) => c.id)
    const expected = STAGE_ITEMS.filter((i) => !i.takeover).map((i) => `toggle:${i.id}`)
    expect(toggles).toEqual(expected)
    for (const item of STAGE_ITEMS.filter((i) => i.takeover)) {
      expect(toggles).not.toContain(`toggle:${item.id}`)
    }
  })

  it('出厂只绑三条:检索 ⌘P、总览 ⌘E、目录 ⌘⇧O,别的一律未绑定', () => {
    const bound = KEYMAP_COMMANDS.filter((c) => c.defaultCombo !== null).map((c) => c.id)
    expect(bound).toEqual(['toggle:search', 'expose.toggle', 'toc.toggle'])
    expect(findCommand('toggle:search')?.defaultCombo).toEqual({ meta: true, key: 'p' })
    expect(findCommand('expose.toggle')?.defaultCombo).toEqual({ meta: true, key: 'e' })
    expect(findCommand('shelf.right.toggle')?.defaultCombo).toBeNull()
    expect(findCommand('toc.toggle')?.defaultCombo).toEqual({ meta: true, shift: true, key: 'o' })
  })
})

describe('匹配', () => {
  it('修饰键逐位相等:多按一个 Shift 就不是同一条绑定', () => {
    expect(matchCombo(press('p', { metaKey: true }), CMD_P)).toBe(true)
    expect(matchCombo(press('p', { metaKey: true, shiftKey: true }), CMD_P)).toBe(false)
    expect(matchCombo(press('p', { metaKey: true, altKey: true }), CMD_P)).toBe(false)
    expect(matchCombo(press('p'), CMD_P)).toBe(false)
  })

  it('主修饰键:⌘ 与 Ctrl 是同一个位子,一条绑定在两种键盘上都好使', () => {
    expect(matchCombo(press('p', { ctrlKey: true }), CMD_P)).toBe(true)
    expect(matchCombo(press('p', { metaKey: true }), { ctrl: true, key: 'p' })).toBe(true)
    expect(sameCombo(CMD_P, { ctrl: true, key: 'p' })).toBe(true)
  })

  it('大小写规范形:按住 Shift 时 key 是 "P",仍认得出是同一个键', () => {
    expect(normalizeKey('P')).toBe('p')
    const combo = comboFromEvent(press('P', { metaKey: true, shiftKey: true }))
    expect(combo).toEqual({ key: 'p', meta: true, shift: true })
    expect(matchCombo(press('P', { metaKey: true, shiftKey: true }), combo!)).toBe(true)
  })

  it('只按修饰键读不出组合(录制态要接着等真正那个键)', () => {
    expect(comboFromEvent(press('Meta', { metaKey: true }))).toBeNull()
    expect(comboFromEvent(press('Shift', { shiftKey: true }))).toBeNull()
  })

  it('hasModifier 只认主修饰与 ⌥ —— Shift 不算(⇧A 在输入框里就是 A)', () => {
    expect(hasModifier(press('a', { metaKey: true }))).toBe(true)
    expect(hasModifier(press('a', { altKey: true }))).toBe(true)
    expect(hasModifier(press('a', { shiftKey: true }))).toBe(false)
  })
})

describe('注册表读写', () => {
  it('effectiveCombo:覆盖赢默认,显式 null(用户解绑)也赢默认', () => {
    expect(effectiveCombo(initialKeymapState, 'toggle:search')).toEqual(CMD_P)
    const rebound: KeymapState = { overrides: { 'toggle:search': { meta: true, key: 'k' } } }
    expect(effectiveCombo(rebound, 'toggle:search')).toEqual({ meta: true, key: 'k' })
    const unbound = unbindCombo(initialKeymapState, 'toggle:search')
    expect(unbound.overrides['toggle:search']).toBeNull()
    expect(effectiveCombo(unbound, 'toggle:search')).toBeNull()
  })

  it('bind 撞车时返回占它的那条命令,一个字都不写(不静默覆盖)', () => {
    const result = bindCombo(initialKeymapState, 'toggle:files', CMD_P)
    expect(result).toEqual({ conflict: 'toggle:search' })
    expect(initialKeymapState.overrides).toEqual({})
  })

  it('绑到自己身上不算撞车;被占的那条解绑之后位子就让出来了', () => {
    expect(bindCombo(initialKeymapState, 'toggle:search', CMD_P)).toHaveProperty('ok')
    const freed = unbindCombo(initialKeymapState, 'toggle:search')
    const result = bindCombo(freed, 'toggle:files', CMD_P)
    expect(result).toHaveProperty('ok')
    expect('ok' in result && result.ok.overrides['toggle:files']).toEqual(CMD_P)
  })

  it('reset 摘掉覆盖、落回出厂值;没覆盖时是恒等变换', () => {
    const bound = bindCombo(initialKeymapState, 'toggle:search', { meta: true, key: 'k' })
    const state = 'ok' in bound ? bound.ok : initialKeymapState
    expect(hasOverride(state, 'toggle:search')).toBe(true)
    const back = resetCombo(state, 'toggle:search')
    expect(hasOverride(back, 'toggle:search')).toBe(false)
    expect(effectiveCombo(back, 'toggle:search')).toEqual(CMD_P)
    expect(resetCombo(back, 'toggle:search')).toBe(back)
  })

  it('lookupCommand:按键落在哪条命令上,没人认领就是 null', () => {
    expect(lookupCommand(initialKeymapState, press('p', { metaKey: true }))).toBe('toggle:search')
    expect(lookupCommand(initialKeymapState, press('e', { metaKey: true }))).toBe('expose.toggle')
    expect(lookupCommand(initialKeymapState, press('p'))).toBeNull()
    const rebound: KeymapState = { overrides: { 'toggle:search': { meta: true, key: 'k' } } }
    expect(lookupCommand(rebound, press('p', { metaKey: true }))).toBeNull()
    expect(lookupCommand(rebound, press('k', { metaKey: true }))).toBe('toggle:search')
  })
})

describe('显示', () => {
  it('平台只影响键面写 ⌘ 还是 Ctrl,顺序固定:主修饰、⌥、⇧、键', () => {
    const combo: Combo = { meta: true, alt: true, shift: true, key: 'p' }
    expect(formatCombo(combo, 'mac')).toEqual(['⌘', '⌥', '⇧', 'P'])
    expect(formatCombo(combo, 'other')).toEqual(['Ctrl', 'Alt', 'Shift', 'P'])
    expect(formatCombo({ key: ' ' }, 'mac')).toEqual(['Space'])
    expect(formatCombo({ key: 'arrowup' }, 'mac')).toEqual(['↑'])
  })

  it('platformOf 只看 UA 字符串 —— 纯函数不读 navigator', () => {
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac')
    expect(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('other')
  })
})

describe('录制', () => {
  it('Esc 取消、Backspace 与 Delete 解绑', () => {
    expect(recordKey(press('Escape'))).toEqual({ kind: 'cancel' })
    expect(recordKey(press('Backspace'))).toEqual({ kind: 'unbind' })
    expect(recordKey(press('Delete'))).toEqual({ kind: 'unbind' })
  })

  it('只按修饰键继续等,按到真键就是这一下要绑的组合', () => {
    expect(recordKey(press('Meta', { metaKey: true }))).toEqual({ kind: 'ignore' })
    expect(recordKey(press('K', { metaKey: true, shiftKey: true }))).toEqual({
      kind: 'bind',
      combo: { key: 'k', meta: true, shift: true },
    })
  })
})

describe('persist', () => {
  it('version 1 是第一版档案,原样放行', () => {
    const archived = { overrides: { 'toggle:files': { meta: true, key: 'f' } } }
    expect(migrateKeymapPersisted(archived, KEYMAP_PERSIST_VERSION)).toEqual(archived)
    expect(migrateKeymapPersisted(archived, 0)).toEqual(archived)
  })
})

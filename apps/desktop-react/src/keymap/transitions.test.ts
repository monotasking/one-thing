import { describe, expect, it } from 'vitest'
import { SESSIONS_ITEM_ID, STAGE_ITEMS } from '../stage/items'
import {
  KEYMAP_COMMANDS,
  KEYMAP_PERSIST_VERSION,
  bindCombo,
  comboFromEvent,
  effectiveCombos,
  findCommand,
  formatCombo,
  hasModifier,
  hasOverride,
  initialKeymapState,
  lookupCommands,
  matchCombo,
  migrateKeymapPersisted,
  normalizeKey,
  platformOf,
  recordKey,
  resetCombo,
  sameCombo,
  toggleCommandId,
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
  it('每块瓦恰有一条 toggle,一块不漏(会话总览去接管化之后也在其中)', () => {
    const toggles = KEYMAP_COMMANDS.filter((c) => c.id.startsWith('toggle:')).map((c) => c.id)
    expect(toggles).toEqual(STAGE_ITEMS.map((i) => toggleCommandId(i.id)))
    expect(toggles).toContain(toggleCommandId(SESSIONS_ITEM_ID))
  })

  it('出厂绑这二十六条,别的一律未绑定;次序即注册表次序', () => {
    const bound = KEYMAP_COMMANDS.filter((c) => c.defaultCombos.length > 0).map((c) => c.id)
    /*
     * 检索 ⌘P、总览 ⌘E、四条架子 ⌘⌥←/→/↓/↑(09-01 用户放权后新绑)、
     * 工作区面板 ⌘⇧W、工作区序号 ⌘1/2/3、目录 ⌘⇧O、agent 切换器 ⌘J、新建会话 ⌘N、
     * 真全屏 ⌘⇧↩(W2 / 拍点 ④)、标签换序 ⌘⌥⇧←/→(W7-c 裁定 3 —— 规格点名的
     * ⌘⌥←/→ 被架子那一族占着,判词写在 `DEFAULT_COMBOS` 上)、
     * **终端 Ctrl+\`**(T1 —— 它不是一条新命令,`toggle:terminal` 那一族本来就是
     * 「召唤」;这一批只给它补了一个出厂键位,判词写在 `DEFAULT_COMBOS` 上)。
     *
     * 架子那四条排在瓦之后、工作区之前 **只是排版** —— 出厂表里没有两条命令
     * 共用一个组合(下面那条「全表两两不同」的断言钉着这件事),所以次序不决定
     * 任何一个键的去向。
     */
    expect(bound).toEqual([
      // 瓦那一族按 `STAGE_ITEMS` 的声明序:终端(目录 / 改动之后)排在检索之前。
      'toggle:terminal',
      'toggle:search',
      toggleCommandId(SESSIONS_ITEM_ID),
      'shelf.left.toggle',
      'shelf.right.toggle',
      'shelf.bottom.toggle',
      'shelf.top.toggle',
      'workspace.palette',
      'workspace.slot:1',
      'workspace.slot:2',
      'workspace.slot:3',
      'toc.toggle',
      'agent.menu',
      'session.new',
      'workbench.toggleFull',
      'workbench.moveTabLeft',
      'workbench.moveTabRight',
      /*
       * 跟随焦点那九条(K0):它们从前是七块面各自的局部键,现在与上面那些同住
       * 一张表,区别只在 `app: false`(没有应用层兜底 —— 没人答就放行)。
       */
      'view.find',
      'view.save',
      'viewer.gotoLine',
      'browser.address',
      'files.detail',
      'nav.back',
      'nav.forward',
      'expose.pin',
      'tab.close',
    ])
    // ⌘⇧↩(W2)。全表零冲突由下面那条「两两不同」的断言钉着。
    expect(findCommand('workbench.toggleFull')?.defaultCombos).toEqual([
      { meta: true, shift: true, key: 'enter' },
    ])
    expect(findCommand('agent.menu')?.defaultCombos).toEqual([{ meta: true, key: 'j' }])
    expect(findCommand('session.new')?.defaultCombos).toEqual([{ meta: true, key: 'n' }])
    expect(findCommand('toggle:search')?.defaultCombos).toEqual([{ meta: true, key: 'p' }])
    expect(findCommand(toggleCommandId(SESSIONS_ITEM_ID))?.defaultCombos).toEqual([
      { meta: true, key: 'e' },
    ])
    expect(findCommand('toc.toggle')?.defaultCombos).toEqual([
      { meta: true, shift: true, key: 'o' },
    ])
    // **一条命令两个出厂键**(K0):文件树的详情是 ⌘I 与 ⌘↵。
    expect(findCommand('files.detail')?.defaultCombos).toEqual([
      { meta: true, key: 'i' },
      { meta: true, key: 'enter' },
    ])
  })
})

describe('匹配', () => {
  it('修饰键逐位相等:多按一个 Shift 就不是同一条绑定', () => {
    expect(matchCombo(press('p', { metaKey: true }), CMD_P, 'mac')).toBe(true)
    expect(matchCombo(press('p', { metaKey: true, shiftKey: true }), CMD_P, 'mac')).toBe(false)
    expect(matchCombo(press('p', { metaKey: true, altKey: true }), CMD_P, 'mac')).toBe(false)
    expect(matchCombo(press('p'), CMD_P, 'mac')).toBe(false)
  })

  /**
   * **声明两种拼法同义,按下的却是一枚具体的键**(T1-fix)。
   *
   * 病历:从前 `matchCombo` 用 `e.metaKey || e.ctrlKey` 当「按下了主修饰键」,
   * 于是 mac 上按 **Ctrl+W** 会触发 ⌘W(关当前 tab)、Win 上按 **Win+W** 会触发
   * Ctrl+W。平常看不出来,直到终端进壳:`^W` 在 readline 下是「删一个词」,
   * 而那时它会把跑着的 shell 连同这一格叶一起关掉。
   *
   * 改判之后:**声明**这一侧照旧两种拼法同义(`sameCombo` 一个字没改,撞键表
   * 仍然把 ⌘P 与 Ctrl+P 判为同一条);**按下**这一侧认平台那一枚。
   */
  it('声明:⌘P 与 Ctrl+P 仍是同一条绑定(撞键判定不变)', () => {
    expect(sameCombo(CMD_P, { ctrl: true, key: 'p' })).toBe(true)
  })

  it('mac:主修饰键是 ⌘ —— Ctrl+P **不再**命中 ⌘P', () => {
    expect(matchCombo(press('p', { metaKey: true }), CMD_P, 'mac')).toBe(true)
    expect(matchCombo(press('p', { ctrlKey: true }), CMD_P, 'mac')).toBe(false)
    // 声明写成 `ctrl` 的那条在 mac 上同样是「按 ⌘」(声明两种拼法同义)。
    expect(matchCombo(press('p', { metaKey: true }), { ctrl: true, key: 'p' }, 'mac')).toBe(true)
    expect(matchCombo(press('p', { ctrlKey: true }), { ctrl: true, key: 'p' }, 'mac')).toBe(false)
  })

  it('win / linux:主修饰键是 Ctrl —— Win 键**不再**命中 Ctrl+P', () => {
    expect(matchCombo(press('p', { ctrlKey: true }), CMD_P, 'other')).toBe(true)
    expect(matchCombo(press('p', { metaKey: true }), CMD_P, 'other')).toBe(false)
  })

  it('另一枚按着就不是这一条(mac 的 ⌃⌘P 不是 ⌘P;Win 的 Win+Ctrl+P 不是 Ctrl+P)', () => {
    expect(matchCombo(press('p', { metaKey: true, ctrlKey: true }), CMD_P, 'mac')).toBe(false)
    expect(matchCombo(press('p', { metaKey: true, ctrlKey: true }), CMD_P, 'other')).toBe(false)
    /*
     * 连**不带主修饰**的那一档也要挡:没有这一句,mac 上的 Ctrl+⌥X 会命中
     * `{alt:true,key:'x'}` —— 因为那时「按下了主修饰键」恰好也答 false。
     */
    expect(matchCombo(press('x', { altKey: true }), { alt: true, key: 'x' }, 'mac')).toBe(true)
    expect(matchCombo(press('x', { altKey: true, ctrlKey: true }), { alt: true, key: 'x' }, 'mac')).toBe(false)
  })

  it('大小写规范形:按住 Shift 时 key 是 "P",仍认得出是同一个键', () => {
    expect(normalizeKey('P')).toBe('p')
    const combo = comboFromEvent(press('P', { metaKey: true, shiftKey: true }))
    expect(combo).toEqual({ key: 'p', meta: true, shift: true })
    expect(matchCombo(press('P', { metaKey: true, shiftKey: true }), combo!, 'mac')).toBe(true)
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
  it('effectiveCombos:覆盖赢默认,显式 null(用户解绑)也赢默认', () => {
    expect(effectiveCombos(initialKeymapState, 'toggle:search')).toEqual([CMD_P])
    const rebound: KeymapState = { overrides: { 'toggle:search': [{ meta: true, key: 'k' }] } }
    expect(effectiveCombos(rebound, 'toggle:search')).toEqual([{ meta: true, key: 'k' }])
    const unbound = unbindCombo(initialKeymapState, 'toggle:search')
    expect(unbound.overrides['toggle:search']).toBeNull()
    expect(effectiveCombos(unbound, 'toggle:search')).toEqual([])
  })

  it('bind 撞车时返回撞的是谁 + 哪一条规则,一个字都不写(不静默覆盖)', () => {
    const result = bindCombo(initialKeymapState, 'toggle:files', CMD_P)
    // 两条都是 `app: true` —— 一个键上只能有一条应用级命令。
    expect(result).toEqual({ conflict: { rule: 'app', with: 'toggle:search' } })
    expect(initialKeymapState.overrides).toEqual({})
  })

  it('绑到自己身上不算撞车;被占的那条解绑之后位子就让出来了', () => {
    expect(bindCombo(initialKeymapState, 'toggle:search', CMD_P)).toHaveProperty('ok')
    const freed = unbindCombo(initialKeymapState, 'toggle:search')
    const result = bindCombo(freed, 'toggle:files', CMD_P)
    expect(result).toHaveProperty('ok')
    expect('ok' in result && result.ok.overrides['toggle:files']).toEqual([CMD_P])
  })

  it('reset 摘掉覆盖、落回出厂值;没覆盖时是恒等变换', () => {
    const bound = bindCombo(initialKeymapState, 'toggle:search', { meta: true, key: 'k' })
    const state = 'ok' in bound ? bound.ok : initialKeymapState
    expect(hasOverride(state, 'toggle:search')).toBe(true)
    const back = resetCombo(state, 'toggle:search')
    expect(hasOverride(back, 'toggle:search')).toBe(false)
    expect(effectiveCombos(back, 'toggle:search')).toEqual([CMD_P])
    expect(resetCombo(back, 'toggle:search')).toBe(back)
  })

  it('lookupCommands:按键落在**哪几条**命令上,没人认领就是空表', () => {
    expect(lookupCommands(initialKeymapState, press('p', { metaKey: true }), 'mac')).toEqual([
      'toggle:search',
    ])
    expect(lookupCommands(initialKeymapState, press('e', { metaKey: true }), 'mac')).toEqual([
      toggleCommandId(SESSIONS_ITEM_ID),
    ])
    expect(lookupCommands(initialKeymapState, press('p'), 'mac')).toEqual([])
    const rebound: KeymapState = { overrides: { 'toggle:search': [{ meta: true, key: 'k' }] } }
    expect(lookupCommands(rebound, press('p', { metaKey: true }), 'mac')).toEqual([])
    expect(lookupCommands(rebound, press('k', { metaKey: true }), 'mac')).toEqual(['toggle:search'])
    /*
     * T1-fix:同一条命令在两台机器上认的是**两枚不同的物理键**。
     * `toggle:terminal` 的出厂键位写的是 `ctrl`(它要的就是 Ctrl 那一枚),
     * 而声明两种拼法同义 —— 所以 mac 上它由 ⌘\` 触发,Win 上由 Ctrl+\` 触发。
     */
    expect(lookupCommands(initialKeymapState, press('`', { metaKey: true }), 'mac')).toEqual([
      'toggle:terminal',
    ])
    expect(lookupCommands(initialKeymapState, press('`', { ctrlKey: true }), 'mac')).toEqual([])
    expect(lookupCommands(initialKeymapState, press('`', { ctrlKey: true }), 'other')).toEqual([
      'toggle:terminal',
    ])
    expect(lookupCommands(initialKeymapState, press('`', { metaKey: true }), 'other')).toEqual([])
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
  it('当前版本的档案原样放行;老档案里那一格 Combo 在 v3 段被包成 [Combo]', () => {
    const now = { overrides: { 'toggle:files': [{ meta: true, key: 'f' }] } }
    expect(migrateKeymapPersisted(now, KEYMAP_PERSIST_VERSION)).toEqual(now)
    const archived = { overrides: { 'toggle:files': { meta: true, key: 'f' } } }
    expect(migrateKeymapPersisted(archived, 1)).toEqual(now)
  })

  it('v2:老档案里 expose.toggle 上的覆盖改挂到会话总览那条 toggle 上', () => {
    const archived = { overrides: { 'expose.toggle': { meta: true, key: 'j' } } }
    expect(migrateKeymapPersisted(archived, 1)).toEqual({
      overrides: { [toggleCommandId(SESSIONS_ITEM_ID)]: [{ meta: true, key: 'j' }] },
    })
  })

  it('v2:用户显式解绑的那条 null 一样跟着迁移(不迁 = 替他把 ⌘E 装回去)', () => {
    const archived = { overrides: { 'expose.toggle': null, 'toggle:files': { meta: true, key: 'f' } } }
    expect(migrateKeymapPersisted(archived, 1)).toEqual({
      overrides: {
        'toggle:files': [{ meta: true, key: 'f' }],
        [toggleCommandId(SESSIONS_ITEM_ID)]: null,
      },
    })
  })
})

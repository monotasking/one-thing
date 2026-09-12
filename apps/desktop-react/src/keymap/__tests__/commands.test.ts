import { describe, expect, it } from 'vitest'
import { KEYMAP_COMMANDS, comboConflictBetween, findCommand, scopesAnswering } from '../commands'
import {
  KEYMAP_PERSIST_VERSION,
  bindCombo,
  effectiveCombos,
  lookupCommands,
  migrateKeymapPersisted,
  sameCombo,
} from '../transitions'
import type { Combo, CommandId } from '../types'

/**
 * **命令表 + 冲突规则**(K0,方案 `docs/keymap-responder-2026-09.md` §4)。
 *
 * 三件事在这儿钉着,一件都不许靠人眼:
 *  ① **出厂表自己过冲突规则** —— 08-31 那次 ⌘⇧O 撞车的病根原话是「出厂表这一层
 *    没有冲突检查」,于是表的**行序**成了裁决。K0 把规则写成一只可跑的纯函数,
 *    第一个跑它的就是出厂表。
 *  ② **规则本身**两条红两条绿,逐条有名字(`app` / `overlap`)。
 *  ③ **迁移** v2→v3:老档案里一格一个 `Combo`,新形是 `Combo[]`;显式 null 原样。
 */

const factory = { overrides: {} }

/** 按「同一个组合」把表分组 —— 规则是**成对**判的,所以要先找出成对的。 */
function pairsSharingAChord(): Array<[CommandId, CommandId]> {
  const out: Array<[CommandId, CommandId]> = []
  for (let i = 0; i < KEYMAP_COMMANDS.length; i += 1) {
    for (let j = i + 1; j < KEYMAP_COMMANDS.length; j += 1) {
      const a = effectiveCombos(factory, KEYMAP_COMMANDS[i].id)
      const b = effectiveCombos(factory, KEYMAP_COMMANDS[j].id)
      if (a.some((x) => b.some((y) => sameCombo(x, y)))) {
        out.push([KEYMAP_COMMANDS[i].id, KEYMAP_COMMANDS[j].id])
      }
    }
  }
  return out
}

describe('出厂表自己过冲突规则', () => {
  it('全表两两:共用一个键的每一对都合法', () => {
    for (const [a, b] of pairsSharingAChord()) {
      expect(comboConflictBetween(a, b), `${a} ↔ ${b}`).toBeNull()
    }
  })

  /**
   * 出厂档下**恰好一对**共键:⌘L 上浏览器的地址栏与查看器的跳行。
   * 这一条把「今天有几对」钉住 —— 多一对少一对都该有人解释一句。
   */
  it('出厂档下共键恰好一对:⌘L 的 browser.address ↔ viewer.gotoLine', () => {
    expect(pairsSharingAChord()).toEqual([['viewer.gotoLine', 'browser.address']])
    expect(scopesAnswering('viewer.gotoLine')).toEqual(['viewer'])
    expect(scopesAnswering('browser.address')).toEqual(['browser'])
  })

  it('每条命令的 `app` / `nativeView` 两格都填了(派发器读的是数据不是命令名)', () => {
    for (const command of KEYMAP_COMMANDS) {
      expect(typeof command.app, command.id).toBe('boolean')
      expect(['reserve', 'yield'], command.id).toContain(command.nativeView)
    }
    // K0 零行为变化:今天全表都是 reserve(让出 ⌘P 给网页打印是 K2 的拍点)。
    expect(KEYMAP_COMMANDS.every((c) => c.nativeView === 'reserve')).toBe(true)
  })

  it('`app: false` 的每一条都真有响应者(没有指向空气的跟随焦点命令)', () => {
    for (const command of KEYMAP_COMMANDS) {
      if (command.app) continue
      expect(scopesAnswering(command.id).length, command.id).toBeGreaterThan(0)
    }
  })
})

describe('冲突规则:一条,两种红', () => {
  it('**`app: true` 的至多一条** —— 两条应用级命令共键必红', () => {
    expect(comboConflictBetween('toc.toggle', 'agent.menu')).toEqual({
      rule: 'app',
      with: 'agent.menu',
    })
  })

  it('**作用域集合两两不交** —— 同一块面里两条都可能答,必红', () => {
    // 查看器同时答 `view.find` 与 `view.save`,所以这两条不许共一个键。
    expect(comboConflictBetween('view.find', 'view.save')).toEqual({
      rule: 'overlap',
      with: 'view.save',
      scope: 'viewer',
    })
  })

  it('两块永不同框的面 → 合法(⌘L 那一对)', () => {
    expect(comboConflictBetween('viewer.gotoLine', 'browser.address')).toBeNull()
  })

  it('一条应用级 + 一条跟随焦点 → 合法(局部先接、没接住放行,那正是三层立法)', () => {
    expect(comboConflictBetween('toggle:search', 'view.find')).toBeNull()
  })

  it('`bindCombo` 用的就是这一条规则:合法的共键放行,不合法的拦住并说清规则', () => {
    // 用户把检索面改绑到 ⌘F:合法(唯一那条应用级,三块面在场时局部先接)。
    const ok = bindCombo(factory, 'toggle:search', { meta: true, key: 'f' })
    expect('ok' in ok).toBe(true)
    // 再把「新建会话」也改到 ⌘F:两条应用级共键 —— 拦住。
    const after = 'ok' in ok ? ok.ok : factory
    const bad = bindCombo(after, 'session.new', { meta: true, key: 'f' })
    expect(bad).toEqual({ conflict: { rule: 'app', with: 'toggle:search' } })
  })

  it('绑到自己身上是恒等成功(再按一次同一个组合不该报「与自己冲突」)', () => {
    const again = bindCombo(factory, 'toggle:search', { meta: true, key: 'p' })
    expect('ok' in again).toBe(true)
  })

  it('录一次 = 整条换成那一个键(`files.detail` 的第二个出厂键因此会丢)', () => {
    expect(effectiveCombos(factory, 'files.detail')).toHaveLength(2)
    const next = bindCombo(factory, 'files.detail', { meta: true, key: 'd' })
    expect('ok' in next).toBe(true)
    if ('ok' in next) expect(effectiveCombos(next.ok, 'files.detail')).toEqual([{ meta: true, key: 'd' }])
  })
})

describe('一个键 → 候选集', () => {
  const press = (combo: Combo) => ({
    key: combo.key,
    metaKey: combo.meta === true,
    ctrlKey: combo.ctrl === true,
    altKey: combo.alt === true,
    shiftKey: combo.shift === true,
  })

  it('⌘L 回两条(谁做由活动路径说了算,不由表的行序)', () => {
    expect(lookupCommands(factory, press({ meta: true, key: 'l' }), 'mac')).toEqual([
      'viewer.gotoLine',
      'browser.address',
    ])
  })

  it('⌘I 与 ⌘↵ 都回同一条命令(一条命令两个键面)', () => {
    expect(lookupCommands(factory, press({ meta: true, key: 'i' }), 'mac')).toEqual(['files.detail'])
    expect(lookupCommands(factory, press({ meta: true, key: 'enter' }), 'mac')).toEqual([
      'files.detail',
    ])
  })

  it('没人要的键回空表', () => {
    expect(lookupCommands(factory, press({ meta: true, key: 'q' }), 'mac')).toEqual([])
  })
})

describe('persist 迁移 v2 → v3', () => {
  it('老档案里那一格 `Combo` 包成 `[Combo]`', () => {
    const out = migrateKeymapPersisted(
      { overrides: { 'toc.toggle': { meta: true, key: 'y' } } },
      2,
    ) as { overrides: Record<string, unknown> }
    expect(out.overrides['toc.toggle']).toEqual([{ meta: true, key: 'y' }])
  })

  it('**显式的 null 仍然是 null** —— 那是「用户把它解绑了」,不是「没绑过」', () => {
    const out = migrateKeymapPersisted({ overrides: { 'agent.menu': null } }, 2) as {
      overrides: Record<string, unknown>
    }
    expect(out.overrides['agent.menu']).toBeNull()
  })

  it('v1 那一段(`expose.toggle` 改挂)与 v3 的包裹**同一次跑完**', () => {
    const out = migrateKeymapPersisted(
      { overrides: { 'expose.toggle': { meta: true, key: 'e' } } },
      1,
    ) as { overrides: Record<string, unknown> }
    expect(out.overrides['expose.toggle']).toBeUndefined()
    expect(out.overrides['toggle:sessions']).toEqual([{ meta: true, key: 'e' }])
  })

  it('已经是新版的原样返回,而且迁移幂等(数组不会被再包一层)', () => {
    const now = { overrides: { 'toc.toggle': [{ meta: true, key: 'y' }] } }
    expect(migrateKeymapPersisted(now, KEYMAP_PERSIST_VERSION)).toBe(now)
    const out = migrateKeymapPersisted(now, 2) as { overrides: Record<string, unknown> }
    expect(out.overrides['toc.toggle']).toEqual([{ meta: true, key: 'y' }])
  })

  it('版本号与迁移段同生共死(改一个就要动另一个)', () => {
    expect(KEYMAP_PERSIST_VERSION).toBe(3)
  })
})

describe('命令表的形状', () => {
  it('每条 id 唯一', () => {
    const ids = KEYMAP_COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('`findCommand` 认得表上每一条,认不出的回 undefined', () => {
    for (const command of KEYMAP_COMMANDS) expect(findCommand(command.id)).toBe(command)
    expect(findCommand('nope' as CommandId)).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { MENU_FAMILIES, menuFamilyOf, projectAppMenu } from '../menu-projection'
import { KEYMAP_COMMANDS, effectiveCombos } from '../transitions'
import { chordOfCombo } from '../chord'
import type { CommandId, KeymapState } from '../types'
import type { MessageKey } from '../../i18n'

/**
 * **菜单表 = 命令表的一次投影**(K4)。
 *
 * 这一组钉的是「同一个产地」那句话的三半:分节是**按 id 的形状**判的(不是一张
 * 名单)、键面走的是**与保留键表同一份规范串**、`enabled` 是**调用方给的那只
 * 判官**(派发器用的那只)的原样转述。
 */

const EMPTY: KeymapState = { overrides: {} }
const t = (key: MessageKey): string => `t:${key}`
const allEnabled = (): boolean => true

describe('分节:按 id 的形状,不是一张名单', () => {
  it('四族各自认得出自己那些', () => {
    expect(menuFamilyOf({ id: 'toggle:search', app: true })).toBe('global')
    expect(menuFamilyOf({ id: 'workbench.toggleFull', app: true })).toBe('global')
    expect(menuFamilyOf({ id: 'tab.new', app: false })).toBe('tab')
    expect(menuFamilyOf({ id: 'tab.select:3' as CommandId, app: false })).toBe('tab')
    expect(menuFamilyOf({ id: 'content.new', app: false })).toBe('tab')
    expect(menuFamilyOf({ id: 'view.find', app: false })).toBe('content')
    expect(menuFamilyOf({ id: 'view.zoomIn', app: false })).toBe('content')
    expect(menuFamilyOf({ id: 'nav.back', app: false })).toBe('content')
    expect(menuFamilyOf({ id: 'viewer.gotoLine', app: false })).toBe('face')
    expect(menuFamilyOf({ id: 'browser.address', app: false })).toBe('face')
    expect(menuFamilyOf({ id: 'files.detail', app: false })).toBe('face')
    expect(menuFamilyOf({ id: 'expose.pin', app: false })).toBe('face')
  })

  /**
   * **`app` 那一格先判**:一条有应用层兜底的命令永远进「全局」那一节,哪怕它
   * 的 id 长得像别的族。判据与派发器那一句 `findCommand(c)?.app` 同源。
   */
  it('`app: true` 压过 id 的形状', () => {
    expect(menuFamilyOf({ id: 'view.find' as CommandId, app: true })).toBe('global')
  })

  it('出厂全表一条不漏、一条不重 —— 每条命令恰好进一节', () => {
    const menu = projectAppMenu({ state: EMPTY, platform: 'mac', isEnabled: allEnabled, translate: t })
    const ids = menu.sections.flatMap((section) => section.items.map((item) => item.id))
    expect(ids.length).toBe(KEYMAP_COMMANDS.length)
    expect(new Set(ids).size).toBe(ids.length)
    for (const command of KEYMAP_COMMANDS) expect(ids).toContain(command.id)
  })

  it('节的次序就是菜单栏上从左到右的次序', () => {
    const menu = projectAppMenu({ state: EMPTY, platform: 'mac', isEnabled: allEnabled, translate: t })
    expect(menu.sections.map((s) => s.label)).toEqual(
      MENU_FAMILIES.map((family) => `t:menu.section${family[0].toUpperCase()}${family.slice(1)}`),
    )
  })
})

describe('每一行', () => {
  it('键面走的是与保留键表同一份规范串(取第一枚)', () => {
    const menu = projectAppMenu({ state: EMPTY, platform: 'mac', isEnabled: allEnabled, translate: t })
    const rows = new Map(menu.sections.flatMap((s) => s.items).map((item) => [item.id, item]))
    for (const command of KEYMAP_COMMANDS) {
      const combos = effectiveCombos(EMPTY, command.id)
      expect(rows.get(command.id)?.chord).toBe(
        combos.length > 0 ? chordOfCombo(combos[0], 'mac') : null,
      )
    }
    // 出厂就绑着 ⌘T 的那一条 —— 门读的正是这个串。
    expect(rows.get('tab.new')?.chord).toBe('cmd+t')
  })

  it('标签是当场翻好的串(主进程没有字典)', () => {
    const menu = projectAppMenu({ state: EMPTY, platform: 'mac', isEnabled: allEnabled, translate: t })
    const row = menu.sections.flatMap((s) => s.items).find((item) => item.id === 'tab.new')
    expect(row?.label).toBe('t:keymap.tabNew')
  })

  it('解绑了的命令 chord = null,不是空串', () => {
    const state: KeymapState = { overrides: { 'tab.new': null } }
    const menu = projectAppMenu({ state, platform: 'mac', isEnabled: allEnabled, translate: t })
    const row = menu.sections.flatMap((s) => s.items).find((item) => item.id === 'tab.new')
    expect(row?.chord).toBeNull()
  })

  /**
   * **`enabled` 是判官说的,不是这只函数猜的**。反证:把调用方那只判官换成
   * 恒假,全表当场全灰 —— 说明这一格没有第二个产地。
   */
  it('`enabled` 原样转述调用方那只判官', () => {
    const asked: CommandId[] = []
    const menu = projectAppMenu({
      state: EMPTY,
      platform: 'mac',
      isEnabled: (id) => { asked.push(id); return id === 'tab.new' },
      translate: t,
    })
    const rows = menu.sections.flatMap((s) => s.items)
    expect(asked.length).toBe(KEYMAP_COMMANDS.length)
    expect(rows.filter((item) => item.enabled).map((item) => item.id)).toEqual(['tab.new'])
  })
})

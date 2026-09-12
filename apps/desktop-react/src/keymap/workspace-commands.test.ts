import { describe, expect, it } from 'vitest'
import { WORKSPACE_ITEM_ID } from '../stage/items'
import { WORKSPACE_SLOT_COUNT } from '../workspace/types'
import {
  KEYMAP_COMMANDS,
  effectiveCombo,
  initialKeymapState,
  lookupCommand,
  workspaceSlotCommandId,
} from './transitions'

/**
 * 工作区那一族在注册表里的落位。这一份用例存在的理由有两条,第二条更要紧:
 *
 *  ① 序号直达是**按预算**长出来的(三条),不是手抄的三行 —— 预算改了这里当场红;
 *  ② 出厂表**两两不撞键**。曾经撞过:工作区面板与 `toc.toggle` 都出厂在 ⌘⇧O,
 *     而出厂表这一层没有冲突检查(bindCombo 只拦用户改绑),lookupCommand 取的
 *     是第一个命中 —— 于是 KEYMAP_COMMANDS 的**次序**成了裁决,目录面板的出厂键
 *     当下按不响。08-31 用户裁定工作区面板改 ⌘⇧W(W = workspace),⌘⇧O 还给目录。
 *
 *     所以这一节从「谁赢」改成了「**不再有谁要赢**」:守的是全表任意两条命令的
 *     出厂组合都不同。这条更强,而且不会像「谁赢」那样在下次加键时无声失效 ——
 *     后者只盯着一对,新撞出来的第二对它一个字都不会说。
 */

describe('序号直达那一族', () => {
  it('按 WORKSPACE_SLOT_COUNT 长出对应条数,一条不多一条不少', () => {
    const slots = KEYMAP_COMMANDS.filter((c) => c.id.startsWith('workspace.slot:'))
    expect(slots).toHaveLength(WORKSPACE_SLOT_COUNT)
  })

  it('每一条都有名字(labelKey 不许是 undefined —— 那会在设置页画出一行空白)', () => {
    for (let n = 1; n <= WORKSPACE_SLOT_COUNT; n += 1) {
      const command = KEYMAP_COMMANDS.find((c) => c.id === workspaceSlotCommandId(n))
      expect(command?.labelKey).toBeTruthy()
    }
  })

  it('出厂键是 ⌘1 / ⌘2 / ⌘3', () => {
    for (let n = 1; n <= WORKSPACE_SLOT_COUNT; n += 1) {
      expect(effectiveCombo(initialKeymapState, workspaceSlotCommandId(n))).toEqual({
        meta: true,
        key: String(n),
      })
    }
  })

  it('⌘2 落到第二个序号的命令上', () => {
    // T1-fix:`lookupCommand` 从这一批起要知道「主修饰键是哪一枚物理键」。
    // 这一组的夹具按的都是 ⌘,所以递 `'mac'`(判词在 `matchCombo` 上)。
    const id = lookupCommand(
      initialKeymapState,
      { key: '2', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
      'mac',
    )
    expect(id).toBe(workspaceSlotCommandId(2))
  })
})

describe('出厂表两两不撞键(见文件头 ②)', () => {
  const press = (key: string, shift = false) => ({
    key,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: shift,
  })

  it('全表任意两条命令的出厂组合都不同 —— 撞了就说得出是哪两条', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const command of KEYMAP_COMMANDS) {
      const combo = effectiveCombo(initialKeymapState, command.id)
      if (!combo) continue
      // 组合的规范写法。四个修饰键都写进去,免得 {meta} 与 {meta, shift:false} 被当成两个键。
      const key = [
        combo.meta ? 'M' : '',
        combo.ctrl ? 'C' : '',
        combo.alt ? 'A' : '',
        combo.shift ? 'S' : '',
        combo.key,
      ].join('-')
      const other = seen.get(key)
      if (other) clashes.push(`${key}: ${other} ⟷ ${command.id}`)
      else seen.set(key, command.id)
    }
    expect(clashes).toEqual([])
  })

  it('⌘⇧W 落在工作区面板上(08-31 裁定的新键)', () => {
    expect(lookupCommand(initialKeymapState, press('w', true), 'mac')).toBe('workspace.palette')
  })

  it('⌘⇧O 还给目录面板 —— 撞键解开之后它才真的按得响', () => {
    expect(lookupCommand(initialKeymapState, press('o', true), 'mac')).toBe('toc.toggle')
  })

  it('工作区总览不占独立快捷键(单击瓦即达,快切面板里也有入口)', () => {
    const overview = KEYMAP_COMMANDS.find((c) => c.id === `toggle:${WORKSPACE_ITEM_ID}`)
    // 它在表里(每块瓦都有一条 toggle,用户改得了),但出厂**不绑键**。
    expect(overview).toBeTruthy()
    expect(overview?.defaultCombo ?? null).toBeNull()
  })
})

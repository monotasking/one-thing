import { describe, expect, it } from 'vitest'
import {
  KEYMAP_COMMANDS,
  comboConflictBetween,
  effectiveCombos,
  findCommand,
  sameCombo,
  shelfSideOfCommand,
  shelfToggleCommandId,
} from '../transitions'
import { FOCUS_SCOPE_LIST } from '../../focus/scopes'
import type { KeymapState } from '../types'
import type { ShelfSide } from '../../stage/types'

/**
 * 四条架子的快捷键(09-01 用户放权键位)。这一组钉三件:
 *  ① 四条都在表里,而且**方向即键位**(左=⌘⌥←,以此类推);
 *  ② **全表两两不同** —— 这是「加键之前先做全表冲突检查」那条派工令的机器化。
 *     它守的是「没有两条命令共用一个组合」,而不是某一对谁赢:后者会在下次
 *     加键时无声地失效(判例:08-31 那次 ⌘⇧O 撞车,次序当了裁决);
 *  ③ id 的拼法**只有一个产地** —— 派发器靠 `shelfSideOfCommand` 反解,
 *     它与 `shelfToggleCommandId` 必须是一对可逆的函数。
 */

const SIDES: ShelfSide[] = ['left', 'right', 'bottom', 'top']
const EMPTY: KeymapState = { overrides: {} }

describe('四条架子的命令行', () => {
  it('四条都在表里,一条不漏', () => {
    for (const side of SIDES) {
      expect(findCommand(shelfToggleCommandId(side))).toBeTruthy()
    }
  })

  it('方向即键位:⌘⌥ + 那个方向的箭头', () => {
    const expected: Record<ShelfSide, string> = {
      left: 'arrowleft',
      right: 'arrowright',
      bottom: 'arrowdown',
      top: 'arrowup',
    }
    for (const side of SIDES) {
      expect(findCommand(shelfToggleCommandId(side))?.defaultCombos).toEqual([
        { meta: true, alt: true, key: expected[side] },
      ])
    }
  })

  it('名字用架子自己那四个键 —— 不借 Dock 的「右/左/上/下」', () => {
    // 命令表里读到的是「右侧栏」,不是「右」。设置页那一列全是命令名,
    // 只写一个「右」在那一列里说不清是什么的右。
    expect(findCommand(shelfToggleCommandId('right'))?.labelKey).toBe('shelf.labelRight')
    expect(findCommand(shelfToggleCommandId('bottom'))?.labelKey).toBe('shelf.labelBottom')
  })
})

describe('全表冲突检查(加键之前那一步的机器化)', () => {
  it('出厂表里共用一个组合的每一对都过得了冲突规则', () => {
    /*
     * K0 之前这一条读作「没有两条命令共用一个组合」。那句话随「一个键可以绑
     * 好几条命令」一起作废,但它守的那件事没变,只是判据从「一个都不许有」变成
     * 了**那条规则**(`comboConflictBetween`):`app: true` 的至多一条,其余每两条
     * 的作用域集合两两不交。出厂表自己第一个跑它。
     */
    const bound = KEYMAP_COMMANDS.flatMap((c) =>
      effectiveCombos(EMPTY, c.id).map((combo) => ({ id: c.id, combo })),
    )
    const clashes: string[] = []
    for (let i = 0; i < bound.length; i += 1) {
      for (let j = i + 1; j < bound.length; j += 1) {
        if (bound[i].id === bound[j].id) continue
        if (!sameCombo(bound[i].combo, bound[j].combo)) continue
        const conflict = comboConflictBetween(bound[i].id, bound[j].id)
        if (conflict) clashes.push(`${bound[i].id} ↔ ${bound[j].id}(${conflict.rule})`)
      }
    }
    expect(clashes).toEqual([])
  })

  it('四条架子键与**跟随焦点那九条**也不撞,而且没有一块面认领着它们', () => {
    /*
     * 共键本身不是错(局部先接、没接住放行应用层),但架子这四条是**应用级**的:
     * 真撞上了,焦点在查看器里时那一侧架子就按不响 —— 而用户会以为键坏了。
     * 所以这一族要求的是干净:一条都不许撞,也不许被哪块面认领走。
     */
    const clashes: string[] = []
    for (const side of SIDES) {
      for (const combo of effectiveCombos(EMPTY, shelfToggleCommandId(side))) {
        for (const command of KEYMAP_COMMANDS) {
          if (command.app) continue
          if (effectiveCombos(EMPTY, command.id).some((c) => sameCombo(combo, c))) {
            clashes.push(`${side} ↔ ${command.id}`)
          }
        }
        for (const spec of FOCUS_SCOPE_LIST) {
          if ((spec.claims ?? []).some((c) => sameCombo(combo, c))) {
            clashes.push(`${side} ↔ claim:${spec.id}`)
          }
        }
      }
    }
    expect(clashes).toEqual([])
  })

  /*
   * W7-c 之前这一条读作「全表唯一带 ⌥ 的」。标签换序两条(⌘⌥⇧←/→)长出来之后
   * 那句话不成立了 —— 而它守的那件事**还在**:带 ⌥ 的键必须是**这一族与它的
   * 近亲**,不许有第三伙人悄悄挤进这根轴。所以断言从「只有它」改成「它,加上
   * 明写在这儿的那两条」;第三条带 ⌥ 的命令一出现就红,而那时要问的第一句话
   * 仍旧是「它凭什么用这根轴」。
   *
   * 换序那两条与架子那四条**同一根轴、只多一个 ⇧**,而 ⇧ 在跨应用里正是「带着
   * 这个东西一起走」(判词写在 `DEFAULT_COMBOS` 上)。上面那条「全表两两不同」
   * 已经钉住它们没挤掉谁。
   */
  it('带 ⌥ 的只有这一族与标签换序那两条(第三伙人挤进来就红)', () => {
    const withAlt = KEYMAP_COMMANDS.filter((c) =>
      effectiveCombos(EMPTY, c.id).some((combo) => combo.alt === true),
    ).map((c) => c.id)
    expect(withAlt).toEqual([
      ...SIDES.map(shelfToggleCommandId),
      'workbench.moveTabLeft',
      'workbench.moveTabRight',
    ])
  })
})

describe('id 的拼法只有一个产地', () => {
  it('拼与反解是一对可逆的函数', () => {
    for (const side of SIDES) {
      expect(shelfSideOfCommand(shelfToggleCommandId(side))).toBe(side)
    }
  })

  it('不是架子命令的 id 反解成 null —— 派发器据此放行,不去猜', () => {
    expect(shelfSideOfCommand('toc.toggle')).toBeNull()
    expect(shelfSideOfCommand('toggle:files')).toBeNull()
    // 形状像但不是表里那四侧的,同样不认(不会拿一个不存在的 side 去调 store)。
    expect(shelfSideOfCommand('shelf.middle.toggle' as never)).toBeNull()
  })
})

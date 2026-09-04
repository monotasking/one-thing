import { describe, expect, it } from 'vitest'
import { summonTransition } from '../summon'
import { emptyShelves, initialStageState, isItemVisible, occluderOf } from '../transitions'
import type { Placement, ShelfSide, StageState } from '../types'

/**
 * **召唤三态的状态表守卫**(S1,设计 §14;表在 `stage/summon.ts` 文件头)。
 *
 * 这一组钉的是那张表逐行成立 **加上判据的顺序** —— 后者才是真正会被改坏的东西:
 * 四行不是四个互斥的谓词而是一条有序的链,换了顺序,收在架子后台的那块面会被
 * 当成「未打开」重开一遍。所以每一行都配一条反证注释,说清拆掉它会红成什么样。
 *
 * 落焦那一半在真机门里(`gate:focus` 场景 14「召唤三态」四步)。
 */

const state = (over: Partial<StageState> = {}): StageState => ({
  ...initialStageState,
  ...over,
})

const at = (id: string, placement: Placement): Partial<StageState> => ({
  placements: { [id]: placement },
})

/** 一条边上的架子:谁在上面、谁露脸、收没收。 */
const shelfWith = (
  side: ShelfSide,
  tabs: string[],
  activeId: string | null,
  collapsed = false,
): Pick<StageState, 'shelves'> => {
  const shelves = emptyShelves()
  shelves[side] = { ...shelves[side], tabs, activeId, collapsed }
  return { shelves }
}

const nobodyFocused = { focusedOwner: null }

describe('① 未打开(在 Dock 里)', () => {
  it('缺席 = dock = 开出来', () => {
    expect(summonTransition(state(), 'files', nobodyFocused)).toEqual({ kind: 'open' })
  })

  it('明写 dock 也一样(收回 Dock 之后再召唤)', () => {
    const s = state(at('files', { kind: 'dock' }))
    expect(summonTransition(s, 'files', nobodyFocused)).toEqual({ kind: 'open' })
  })

  it('**判据顺序**:在 Dock 里的那块面即便「焦点在它里面」也是开,不是回去', () => {
    // 反证:把 dock 那一格挪到 focus/return 之后 → 这里会答 return,
    // 于是一块没开的面被「还」了一次,永远开不出来。
    expect(summonTransition(state(), 'files', { focusedOwner: 'files' })).toEqual({ kind: 'open' })
  })
})

describe('② 打开了但看不见 —— 露出来,位置不变', () => {
  it('架子展开着,露脸的是别人 → 点名那个 tab', () => {
    const s = state({
      ...at('files', { kind: 'edge', side: 'right' }),
      ...shelfWith('right', ['sessions', 'files'], 'sessions'),
    })
    expect(summonTransition(s, 'files', nobodyFocused)).toEqual({
      kind: 'reveal',
      how: 'shelf-tab',
      side: 'right',
    })
  })

  it('架子收成细梁 → 展开(哪怕它已经是活动 tab)', () => {
    const s = state({
      ...at('files', { kind: 'edge', side: 'left' }),
      ...shelfWith('left', ['files'], 'files', true),
    })
    // 反证:把 `shelf.collapsed ?` 那一句删成恒等 'shelf-tab' → 这里答 shelf-tab,
    // 而 activateShelfTab 对已经是活动的那一格是恒等变换 —— 按键什么都不会发生。
    expect(summonTransition(s, 'files', nobodyFocused)).toEqual({
      kind: 'reveal',
      how: 'shelf-expand',
      side: 'left',
    })
  })

  it('架子既收着、露的又是别人 → 仍然先展开(细梁上换 tab 不成立)', () => {
    const s = state({
      ...at('files', { kind: 'edge', side: 'right' }),
      ...shelfWith('right', ['sessions', 'files'], 'sessions', true),
    })
    expect(summonTransition(s, 'files', nobodyFocused)).toEqual({
      kind: 'reveal',
      how: 'shelf-expand',
      side: 'right',
    })
  })

  it('浮窗被压在下面 → 翻到最上面;最上面那一扇不算「看不见」', () => {
    const two = {
      placements: {
        files: { kind: 'float' } as Placement,
        search: { kind: 'float' } as Placement,
      },
      floatOrder: ['files', 'search'],
    }
    const s = state(two)
    expect(summonTransition(s, 'files', nobodyFocused)).toEqual({
      kind: 'reveal',
      how: 'float-front',
      side: null,
    })
    // 末位最上 —— 它看得见,所以走的是第三格。
    expect(summonTransition(s, 'search', nobodyFocused)).toEqual({
      kind: 'focus',
      scope: 'float-layer',
    })
  })

  it('**判据顺序**:看不见的那块面即便报着「焦点在它里面」也先露出来', () => {
    const s = state({
      ...at('files', { kind: 'edge', side: 'right' }),
      ...shelfWith('right', ['sessions', 'files'], 'sessions'),
    })
    // 反证:把 isItemVisible 那一闸挪到 focus/return 之后 → 这里答 return,
    // 于是一块藏在后台 tab 里的面被「还」了一次,永远露不出来。
    expect(summonTransition(s, 'files', { focusedOwner: 'files' })).toEqual({
      kind: 'reveal',
      how: 'shelf-tab',
      side: 'right',
    })
  })
})

describe('② 之二:被盖 / 舞台压着 —— 不越过盖层(§14)', () => {
  it('盖开着时,架子上的那块面是 blocked 而不是 reveal', () => {
    const s = state({
      placements: {
        apps: { kind: 'cover' } as Placement,
        files: { kind: 'edge', side: 'right' } as Placement,
      },
      ...shelfWith('right', ['files'], 'files'),
    })
    // 反证:把 occluderOf 那一闸删掉 → 这里答 reveal,而「露出来」在盖底下
    // 只能靠先把盖收掉 —— 那正是 §14 明令不做的「越过盖层」。
    expect(summonTransition(s, 'files', nobodyFocused)).toEqual({ kind: 'blocked', by: 'cover' })
  })

  it('盖压不过浮窗(--z-cover 100 < --z-float 200):浮窗照旧可召唤', () => {
    const s = state({
      placements: {
        apps: { kind: 'cover' } as Placement,
        files: { kind: 'float' } as Placement,
      },
      floatOrder: ['files'],
    })
    expect(summonTransition(s, 'files', nobodyFocused)).toEqual({
      kind: 'focus',
      scope: 'float-layer',
    })
  })

  it('舞台的 scrim 压住一切:它开着时别人一律 blocked,它自己照旧', () => {
    const s = state({
      placements: {
        viewer: { kind: 'stage' } as Placement,
        files: { kind: 'float' } as Placement,
        sessions: { kind: 'edge', side: 'right' } as Placement,
      },
      floatOrder: ['files'],
      ...shelfWith('right', ['sessions'], 'sessions'),
    })
    expect(summonTransition(s, 'files', nobodyFocused)).toEqual({ kind: 'blocked', by: 'stage' })
    expect(summonTransition(s, 'sessions', nobodyFocused)).toEqual({ kind: 'blocked', by: 'stage' })
    expect(summonTransition(s, 'viewer', nobodyFocused)).toEqual({
      kind: 'focus',
      scope: 'stage-layer',
    })
  })
})

describe('③ 看得见、焦点不在它里面 —— 只聚焦,形态零变化', () => {
  it('四种形态各给出装着它的那一层', () => {
    const cases: Array<[Placement, string]> = [
      [{ kind: 'stage' }, 'stage-layer'],
      [{ kind: 'cover' }, 'cover-layer'],
      [{ kind: 'edge', side: 'right' }, 'shelf-layer'],
    ]
    for (const [placement, scope] of cases) {
      const s = state({
        ...at('files', placement),
        ...shelfWith('right', ['files'], 'files'),
      })
      expect(summonTransition(s, 'files', nobodyFocused)).toEqual({ kind: 'focus', scope })
    }
    const floated = state({ ...at('files', { kind: 'float' }), floatOrder: ['files'] })
    expect(summonTransition(floated, 'files', nobodyFocused)).toEqual({
      kind: 'focus',
      scope: 'float-layer',
    })
  })

  it('焦点在**别人**里面也是聚焦', () => {
    const s = state({ ...at('files', { kind: 'float' }), floatOrder: ['files'] })
    expect(summonTransition(s, 'files', { focusedOwner: 'search' })).toEqual({
      kind: 'focus',
      scope: 'float-layer',
    })
  })
})

describe('④ 看得见、焦点在它里面 —— 隐藏(09-04 用户改判,推翻 09-03 的「回去」)', () => {
  it('浮窗:收回 Dock(没有「收起」这一档)', () => {
    const s = state({ ...at('files', { kind: 'float' }), floatOrder: ['files'] })
    /*
     * 反证:把这一格改回 09-03 那版的 `{ kind: 'return', scope }` → 这里当场红。
     * 用户 09-04 的原话是 VS Code 终端 ⌃` 那一族:同一个键叫出来、再按一下收走。
     */
    expect(summonTransition(s, 'files', { focusedOwner: 'files' })).toEqual({
      kind: 'hide',
      how: 'close',
      side: null,
    })
  })

  it('舞台 / 盖同理(它们都不是家具,是开着的面)', () => {
    for (const placement of [{ kind: 'stage' } as const, { kind: 'cover' } as const]) {
      const s = state(at('files', placement))
      expect(summonTransition(s, 'files', { focusedOwner: 'files' })).toEqual({
        kind: 'hide',
        how: 'close',
        side: null,
      })
    }
  })

  it('**钉在架子上:收起整条架子**,不是关掉这块面(09-04 用户裁定)', () => {
    const s = state({
      ...at('files', { kind: 'edge', side: 'bottom' }),
      ...shelfWith('bottom', ['files'], 'files'),
    })
    /*
     * 反证:把这一格也判成 `close` → 这里红。用户否决的正是那一版:关掉这块面之后
     * 架子会露出隔壁那个 tab,焦点跟着掉到隔壁面上 —— 按的是「收走」,拿回来的是
     * 「换了一块面」。收整条架子才与 `reveal` 的 `shelf-expand` 成一对(收起 →
     * 再召唤 = 展开回原样)。
     */
    expect(summonTransition(s, 'files', { focusedOwner: 'files' })).toEqual({
      kind: 'hide',
      how: 'shelf-collapse',
      side: 'bottom',
    })
  })

  it('钉边那一形交出的 side 是**它自己那条边**(四条边各判各的)', () => {
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const s = state({
        ...at('files', { kind: 'edge', side }),
        ...shelfWith(side, ['files'], 'files'),
      })
      expect(summonTransition(s, 'files', { focusedOwner: 'files' })).toEqual({
        kind: 'hide',
        how: 'shelf-collapse',
        side,
      })
    }
  })
})

describe('可见性查询本身(唯一那一只)', () => {
  it('dock 不是「看不见」而是「不在场」', () => {
    expect(isItemVisible(state(), 'files')).toBe(false)
    expect(occluderOf(state(), 'files')).toBeNull()
  })

  it('架子:活动 tab + 展开着才算露脸', () => {
    const base = at('files', { kind: 'edge', side: 'right' })
    expect(isItemVisible(state({ ...base, ...shelfWith('right', ['files'], 'files') }), 'files'))
      .toBe(true)
    expect(
      isItemVisible(state({ ...base, ...shelfWith('right', ['files'], 'files', true) }), 'files'),
    ).toBe(false)
    expect(
      isItemVisible(state({ ...base, ...shelfWith('right', ['a', 'files'], 'a') }), 'files'),
    ).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { focusFollowTarget } from '../focus-follow'
import { initialStageState } from '../transitions'
import type { Placement, StageState } from '../types'

/**
 * **「挪到哪,焦点跟到哪」的判据**(09-03 R2,设计 §3.5 规则 3 与 §11 拍点 2)。
 *
 * 这一组钉的是 `stage/focus-follow.ts` 文件头那张三档表逐条成立。判据是纯的
 * (前后两份状态 → 跟去哪一格),所以它测得起来 —— 而落焦那一半在真机门里
 * (`gate:focus` 场景 9:拼舞台 → 钉右边 → 撕浮窗,每步之后焦点都在那块面里)。
 *
 * 反证纪律逐条写在用例里。
 */

const state = (over: Partial<StageState> = {}): StageState => ({
  ...initialStageState,
  ...over,
})

const at = (id: string, placement: Placement): Partial<StageState> => ({
  placements: { [id]: placement },
})

describe('三档:开 / 挪 / 收', () => {
  it('dock → 任何形态 = **打开**:没人点名就不跟(指针点瓦焦点留在瓦上)', () => {
    const before = state()
    const after = state(at('files', { kind: 'stage' }))
    // 反证:把 `id !== openedByKeyboard` 那半句删掉 → 这里会答 stage-layer,
    // 于是点一下 Dock 瓦焦点就被从瓦上拽走(连按两下不再是「开、关」)。
    expect(focusFollowTarget(before, after)).toBeNull()
  })

  it('dock → 任何形态 + **键盘点了名** = 跟(§3.5 规则 2)', () => {
    const before = state()
    const after = state(at('files', { kind: 'stage' }))
    expect(focusFollowTarget(before, after, 'files')).toEqual({
      scope: 'stage-layer',
      owner: 'files',
    })
    // 点的是别人的名 → 与没点一样。
    expect(focusFollowTarget(before, after, 'search')).toBeNull()
  })

  it('形态 A → 形态 B = **挪动**,跟着那块面走', () => {
    const before = state(at('files', { kind: 'stage' }))
    const after = state(at('files', { kind: 'float' }))
    expect(focusFollowTarget(before, after)).toEqual({ scope: 'float-layer', owner: 'files' })
  })

  it('换边也算挪动(左 → 右不是同一个位置)', () => {
    const before = state(at('files', { kind: 'edge', side: 'left' }))
    const after = state(at('files', { kind: 'edge', side: 'right' }))
    // 反证:`samePlace` 里那句 side 的比较删掉 → 换边不跟,焦点留在旧那条架子里。
    expect(focusFollowTarget(before, after)).toEqual({ scope: 'shelf-layer', owner: 'files' })
  })

  it('任何形态 → dock = **收起**,不跟(那块面没了,归还是树的事)', () => {
    const before = state(at('files', { kind: 'float' }))
    const after = state()
    expect(focusFollowTarget(before, after)).toBeNull()
    // 同一个键把它收回去时点的那次名也不算数:表里根本没有它了。
    expect(focusFollowTarget(before, after, 'files')).toBeNull()
  })

  it('一格都没动 → null(设置类的写入走同一条路,零代价)', () => {
    const before = state(at('files', { kind: 'float' }))
    expect(focusFollowTarget(before, state(at('files', { kind: 'float' })))).toBeNull()
  })
})

describe('程序置顶一扇已经开着的浮窗(设计 §5 最后一行)', () => {
  it('键盘点了名 + 前后都是 float = 那一下是置顶,焦点进那扇窗', () => {
    const before = state(at('files', { kind: 'float' }))
    const after = state(at('files', { kind: 'float' }))
    /*
     * 反证:把那一段删掉 → 按 ⌘ 键把一扇开着的浮窗提到最上面之后键盘还在原处
     * (`togglePlacement` 对开着的浮窗走的正是 `focusFloat` 那一支)。
     */
    expect(focusFollowTarget(before, after, 'files')).toEqual({
      scope: 'float-layer',
      owner: 'files',
    })
  })

  it('**指针**置顶不点名,所以走不到这儿(点击本身落焦)', () => {
    const before = state(at('files', { kind: 'float' }))
    const after = state(at('files', { kind: 'float' }))
    expect(focusFollowTarget(before, after)).toBeNull()
  })

  it('别的形态不吃这一条(只有浮窗有「置顶」这回事)', () => {
    const before = state(at('files', { kind: 'edge', side: 'right' }))
    const after = state(at('files', { kind: 'edge', side: 'right' }))
    expect(focusFollowTarget(before, after, 'files')).toBeNull()
  })
})

describe('架子切 tab(§11 拍点 2:用户已拍「进」)', () => {
  const shelf = (side: 'left' | 'right', activeId: string | null): Partial<StageState> => ({
    shelves: {
      ...initialStageState.shelves,
      [side]: { ...initialStageState.shelves[side], activeId },
    },
  })

  it('活动 tab 换人 → 焦点进新那一层(placements 一格没变)', () => {
    const before = state(shelf('right', 'files'))
    const after = state(shelf('right', 'sessions'))
    // 反证:把那段 SIDES 循环删掉 → 切 tab 之后焦点留在原处(旧层随即 inert,
    // 于是路径缩到宿主,键盘落在一块看不见的面的祖先上)。
    expect(focusFollowTarget(before, after)).toEqual({
      scope: 'shelf-layer',
      owner: 'sessions',
    })
  })

  it('架子空掉(activeId 变 null)不跟 —— 没有可跟的东西', () => {
    const before = state(shelf('right', 'files'))
    expect(focusFollowTarget(before, state(shelf('right', null)))).toBeNull()
  })
})

describe('架子从细梁展开(S1 召唤三态补的那一档,设计 §14 第二行)', () => {
  const collapsed = (side: 'left' | 'right', activeId: string, on: boolean): Partial<StageState> => ({
    placements: { [activeId]: { kind: 'edge', side } },
    shelves: {
      ...initialStageState.shelves,
      [side]: { ...initialStageState.shelves[side], activeId, collapsed: on },
    },
  })

  it('键盘点了名 + 收着 → 展开 = 焦点进那一层(placements 一格没变)', () => {
    const before = state(collapsed('right', 'files', true))
    const after = state(collapsed('right', 'files', false))
    /*
     * 反证:把 focus-follow 里那一段删掉 → 召唤一块收在细梁里的面,架子展开了
     * 而键盘还在原处。下面那条通用的「切 tab」看的是 `activeId` 变没变,
     * 这一形它一个字都答不出(活动 tab 从头到尾都是 files)。
     */
    expect(focusFollowTarget(before, after, 'files')).toEqual({
      scope: 'shelf-layer',
      owner: 'files',
    })
  })

  it('**指针**点那颗收展钮不点名 → 不跟(顺手展开看一眼不该抢走键盘)', () => {
    const before = state(collapsed('right', 'files', true))
    const after = state(collapsed('right', 'files', false))
    expect(focusFollowTarget(before, after)).toBeNull()
  })

  it('反向(展开 → 收起)不跟:那是把面藏起来,没有可跟的东西', () => {
    const before = state(collapsed('left', 'files', false))
    const after = state(collapsed('left', 'files', true))
    expect(focusFollowTarget(before, after, 'files')).toBeNull()
  })

  it('点的是别人的名 → 与没点一样', () => {
    const before = state(collapsed('right', 'files', true))
    const after = state(collapsed('right', 'files', false))
    expect(focusFollowTarget(before, after, 'sessions')).toBeNull()
  })
})

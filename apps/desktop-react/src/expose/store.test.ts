import { beforeEach, describe, expect, it } from 'vitest'
import { EXPOSE_PER_SPACE, useExposeStore } from './store'
import { ALL_SCOPE, projectScope } from './scopes'
import { spreadSpace, stashSpace } from '../workspace/per-space'
import { DEFAULT_SPACE_ID } from '../workspace/types'
import { useStageStore } from '../stage/store'
import { initialStageState } from '../stage/transitions'
import { initialExposeState } from './transitions'
import { SESSIONS_ITEM_ID } from '../stage/items'
import { seedSessionsSource } from '../data/__fixtures__/sessions'

/**
 * ── 08-30 用户报障:钉到左边的会话面,选一条会话它整个消失了 ────────────────
 *
 * 「进入会话」之后这块面收不收,按**形态**分岔(用户拍板):舞台 / 浮窗是瞬态形,
 * 选完即走,收回 Dock 是正确谢幕;钉在边上(edge)是常驻形——用户把它固定成了
 * 工作面,选会话是它的日常动作,收掉等于把刚安置好的家具搬走。
 *
 * 分岔判据只活在 store 壳的 enterSession 里(纯函数仍不认识 Placement),
 * 这组测试钉的就是那一个分岔:修前「钉住仍被收」那条必红。
 */
describe('enterSession × 形态:瞬态收、钉住留', () => {
  beforeEach(() => {
    useStageStore.setState({ ...initialStageState })
    useExposeStore.setState({ ...initialExposeState, view: { mode: 'overview' } })
    seedSessionsSource()
  })

  it('钉在边上(edge):进会话后这块面留在原地,不收回 Dock', () => {
    useStageStore.getState().openAs(SESSIONS_ITEM_ID, { kind: 'edge', side: 'left' })
    useExposeStore.getState().enterSession('os-expose')
    expect(useStageStore.getState().placements[SESSIONS_ITEM_ID]).toEqual({ kind: 'edge', side: 'left' })
    expect(useExposeStore.getState().currentSessionId).toBe('os-expose')
  })

  it('舞台(stage):进会话后照旧收回 Dock —— 瞬态形的旧语义一字不变', () => {
    useStageStore.getState().openAs(SESSIONS_ITEM_ID, { kind: 'stage' })
    useExposeStore.getState().enterSession('os-expose')
    expect(SESSIONS_ITEM_ID in useStageStore.getState().placements).toBe(false)
  })

  it('浮窗(float):同瞬态口径,进会话收回 Dock', () => {
    useStageStore.getState().openAs(SESSIONS_ITEM_ID, { kind: 'float' })
    useExposeStore.getState().enterSession('os-expose')
    expect(SESSIONS_ITEM_ID in useStageStore.getState().placements).toBe(false)
  })
})


/**
 * ── 持久化 v2(09-04)────────────────────────────────────────────────────
 * 折叠组随项目组一起退役,家具换成范围与展开的房间。这一组钉两件事:
 * ①存量档案(v1)迁上来**不许带着旧键**,②两格家具按工作区各持一份。
 *
 * `migrate` 不是导出符号(它长在 persist 配置里),所以这里走**真路**:
 * 把一份 v1 档案写进 localStorage,再让 store 自己 rehydrate 一次。
 */
describe('onething.expose 持久化 v2', () => {
  const STORE_KEY = 'onething.expose'

  beforeEach(() => {
    localStorage.clear()
  })

  it('v1 → v2:丢掉 collapsedGroups,两格家具回出厂', () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        version: 1,
        state: { byWorkspace: { [DEFAULT_SPACE_ID]: { collapsedGroups: ['/Users/dev/code/x'] } } },
      }),
    )
    useExposeStore.persist.rehydrate()
    const state = useExposeStore.getState()
    expect(state.scope).toEqual(ALL_SCOPE)
    expect(state.expandedRooms).toEqual([])
    expect(JSON.stringify(state.byWorkspace)).not.toContain('collapsedGroups')
  })

  it('v0(没有版本号的平铺档)照旧迁得动:先折进默认空间,再丢掉那一格', () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ state: { collapsedGroups: ['/a'] } }),
    )
    useExposeStore.persist.rehydrate()
    expect(useExposeStore.getState().scope).toEqual(ALL_SCOPE)
    expect(JSON.stringify(useExposeStore.getState().byWorkspace)).not.toContain('collapsedGroups')
  })

  it('v2 档案原样摊开(范围与展开表都还在)', () => {
    const scope = projectScope('/Users/dev/code/start-electron')
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        version: 2,
        state: { byWorkspace: { [DEFAULT_SPACE_ID]: { scope, expandedRooms: ['rm-1'] } } },
      }),
    )
    useExposeStore.persist.rehydrate()
    expect(useExposeStore.getState().scope).toEqual(scope)
    expect(useExposeStore.getState().expandedRooms).toEqual(['rm-1'])
  })

  it('两格家具按工作区各持一份:换个空间摊开的是那个空间自己那一份', () => {
    const store = useExposeStore.getState()
    const mine = { scope: projectScope('/p/a'), expandedRooms: ['rm-a'] }
    const theirs = { scope: projectScope('/p/b'), expandedRooms: [] }
    const table = { a: mine, b: theirs }
    expect(spreadSpace({ ...table }, EXPOSE_PER_SPACE, 'a')).toEqual(mine)
    expect(spreadSpace({ ...table }, EXPOSE_PER_SPACE, 'b')).toEqual(theirs)
    // 没进过的空间摊开的是**出厂那一份**(全部 + 一间房都没展开)。
    expect(spreadSpace({ ...table }, EXPOSE_PER_SPACE, 'never-been')).toEqual(
      EXPOSE_PER_SPACE.factory(),
    )
    // pick 只挑那两格 —— 别的状态(焦点 / 搜索词 / 当前会话)不算家具。
    expect(EXPOSE_PER_SPACE.pick({ ...store, ...mine })).toEqual(mine)
    expect(EXPOSE_PER_SPACE.factory()).toEqual({ scope: ALL_SCOPE, expandedRooms: [] })
    // 收进账:当前空间(默认那个)多出一格,别人的两格原样在。
    const stashed = stashSpace({ ...store, ...mine }, table, EXPOSE_PER_SPACE)
    expect(Object.keys(stashed).sort()).toEqual(['a', 'b', DEFAULT_SPACE_ID].sort())
    expect(stashed[DEFAULT_SPACE_ID]).toEqual(mine)
    expect(stashed.b).toEqual(theirs)
  })
})

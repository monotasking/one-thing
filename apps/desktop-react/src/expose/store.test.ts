import { beforeEach, describe, expect, it } from 'vitest'
import { useExposeStore } from './store'
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpaceRecord } from '@shared/ipc/spaces'
import { configureSpacesPort } from '../../data/spaces-port'
import { useWorkspaceStore } from '../store'
import { DEFAULT_SPACE_ID } from '../types'
import {
  bindPerSpace,
  foldFlatIntoDefaultSpace,
  spreadSpace,
  stashSpace,
  swapSpace,
  type PerSpaceSpec,
  type PerSpaceState,
} from '../per-space'

/**
 * 「家具按工作区各持一份」的原语(T-W1)。这一组守的是**换装本身**,
 * 与哪一个 store 无关 —— 五个消费面共用它,它错一次就是五处一起错。
 *
 * 三件事:
 *  ① 收 / 摊 / 换装的语义(尤其**次序**:先收旧的再摊新的);
 *  ② 首进某空间 = 出厂布局,**不看别的空间**;
 *  ③ 迁移:存量那一份扁平档案原样折进默认空间,零丢失、幂等。
 */

interface Furniture {
  shelf: string
}
interface Fake extends PerSpaceState<Furniture> {
  shelf: string
}

const SPEC: PerSpaceSpec<Fake, Furniture> = {
  pick: (s) => ({ shelf: s.shelf }),
  factory: () => ({ shelf: '出厂' }),
}

const DEFAULT: SpaceRecord = { id: DEFAULT_SPACE_ID, name: '默认', createdAt: 0 }
const WORK: SpaceRecord = { id: 'ws-work', name: '工作', createdAt: 100 }

async function loadSpaces(): Promise<void> {
  configureSpacesPort({
    ready: async () => undefined,
    list: vi.fn(async () => ({ success: true, spaces: [DEFAULT, WORK] })),
    create: vi.fn(async () => ({ success: false, error: 'not stubbed' })),
    update: vi.fn(async () => ({ success: true })),
    remove: vi.fn(async () => ({ success: true, removed: true })),
  })
  await useWorkspaceStore.getState().load()
}

beforeEach(() => {
  useWorkspaceStore.getState().reset()
})

afterEach(() => {
  useWorkspaceStore.getState().reset()
})

describe('收 / 摊', () => {
  it('收:把当前空间那一格写成 pick(state),别的格原样', () => {
    const ledger = stashSpace({ shelf: '新的', byWorkspace: {} }, { 'ws-a': { shelf: '旧的' } }, SPEC, 'ws-b')
    expect(ledger).toEqual({ 'ws-a': { shelf: '旧的' }, 'ws-b': { shelf: '新的' } })
  })

  it('摊:账上有就是它', () => {
    expect(spreadSpace({ 'ws-a': { shelf: '甲' } }, SPEC, 'ws-a')).toEqual({ shelf: '甲' })
  })

  it('摊:**账上没有 = 出厂布局**,不去看别的空间的', () => {
    expect(spreadSpace({ 'ws-a': { shelf: '甲' } }, SPEC, 'ws-b')).toEqual({ shelf: '出厂' })
  })
})

describe('换装', () => {
  it('先收旧的再摊新的 —— 次序即语义', () => {
    const out = swapSpace({ shelf: '甲摆的', byWorkspace: {} }, SPEC, 'ws-b', 'ws-a')
    // 旧空间那一格记下的是**换装前**屏幕上那一份。
    expect(out.byWorkspace['ws-a']).toEqual({ shelf: '甲摆的' })
    // 新空间没摆过 → 出厂。
    expect(out.shelf).toBe('出厂')
  })

  /*
   * 这一条是这个原语最容易写反的那一格,所以单独钉:反过来(先摊后收)的话,
   * 收进账的会是**刚摊开的那一份**,旧空间的布局当场蒸发 —— 现场是「切走再切回来
   * 布局没了」,而它在单测里只差一个语句次序。
   */
  it('旧空间的布局**不会**被新空间那一份覆盖', () => {
    const first = swapSpace({ shelf: '甲摆的', byWorkspace: {} }, SPEC, 'ws-b', 'ws-a')
    const back = swapSpace({ ...first, shelf: '乙摆的' }, SPEC, 'ws-a', 'ws-b')
    expect(back.byWorkspace['ws-a']).toEqual({ shelf: '甲摆的' })
    expect(back.byWorkspace['ws-b']).toEqual({ shelf: '乙摆的' })
    // 切回去看到的正是当初摆的那一份。
    expect(back.shelf).toBe('甲摆的')
  })

  it('一次 set 的全部内容:账与摊开的字段一起给,中间没有「新账配旧家具」那一帧', () => {
    const out = swapSpace({ shelf: '甲摆的', byWorkspace: {} }, SPEC, 'ws-b', 'ws-a')
    expect(Object.keys(out).sort()).toEqual(['byWorkspace', 'shelf'])
  })
})

describe('bindPerSpace', () => {
  it('切空间当场换装;切回来原样', async () => {
    await loadSpaces()
    const state: Fake = { shelf: '默认里摆的', byWorkspace: {} }
    const store = {
      getState: () => state,
      setState: (patch: Partial<Fake>) => Object.assign(state, patch),
    }
    const stop = bindPerSpace(store, SPEC)

    useWorkspaceStore.getState().switchTo('ws-work')
    expect(state.shelf).toBe('出厂')

    state.shelf = '工作里摆的'
    useWorkspaceStore.getState().switchTo(DEFAULT_SPACE_ID)
    expect(state.shelf).toBe('默认里摆的')

    useWorkspaceStore.getState().switchTo('ws-work')
    expect(state.shelf).toBe('工作里摆的')
    stop()
  })

  it('退订之后不再换装;**幂等** —— 退两次不抛也不漏', async () => {
    await loadSpaces()
    const state: Fake = { shelf: '原样', byWorkspace: {} }
    const stop = bindPerSpace(
      { getState: () => state, setState: (p: Partial<Fake>) => Object.assign(state, p) },
      SPEC,
    )
    stop()
    stop()
    useWorkspaceStore.getState().switchTo('ws-work')
    expect(state.shelf).toBe('原样')
  })
})

describe('迁移:扁平档案 → 默认空间那一格', () => {
  it('摘走家具那几格,**别的原样留在顶层**(它们是跨空间的偏好)', () => {
    const out = foldFlatIntoDefaultSpace<Furniture>(
      { shelf: '老档摆的', dockEdge: 'bottom', locale: 'zh' },
      ['shelf'],
      DEFAULT_SPACE_ID,
    )
    expect(out).toEqual({
      dockEdge: 'bottom',
      locale: 'zh',
      byWorkspace: { [DEFAULT_SPACE_ID]: { shelf: '老档摆的' } },
    })
  })

  it('已经有账的档案原样放行 —— 迁移必须幂等', () => {
    const already = { byWorkspace: { 'ws-a': { shelf: '甲' } } }
    expect(foldFlatIntoDefaultSpace<Furniture>(already, ['shelf'], DEFAULT_SPACE_ID)).toBe(already)
  })

  it('一格家具都没摘到 = 不造一格空的出来(与「从来没摆过」是同一件事)', () => {
    const out = foldFlatIntoDefaultSpace<Furniture>({ dockEdge: 'bottom' }, ['shelf'], DEFAULT_SPACE_ID)
    expect(out).toEqual({ dockEdge: 'bottom' })
    expect('byWorkspace' in out).toBe(false)
  })
})

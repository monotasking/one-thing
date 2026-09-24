import { beforeEach, describe, expect, it } from 'vitest'
import {
  foldLegacyStageFurniture,
  regionsFromLegacyFurniture,
  resetLegacyStageFold,
  stashLegacyStageResidency,
} from '../legacy-furniture'
import { migrateStagePersisted, STAGE_PERSIST_VERSION, emptyShelves } from '../transitions'
import { useWorkbenchStore } from '../../workbench/store'
import { refId } from '../../workbench/kinds'
import { leavesOf } from '../../workbench/tree'
import { DEFAULT_SPACE_ID } from '../../workspace/types'
import type { PaneNode } from '../../workbench/tree'
import type { Placement, ShelfSide } from '../types'

/**
 * **v8 → v9:住处从 `onething.stage` 搬进 `onething.workbench`**(W4)。
 *
 * 这一次搬家有两头,两头各有各的判据:
 *  · **摘**那一头(`migrateStagePersisted` 的 v9 段):`placements` 整格没了,
 *    每条架子只剩几何(`thickness` / `collapsed`);而且**一格都没碰到就原样交回**
 *    (引用恒等 —— 幂等在这一族档案上的机器化判据,与 v8 那一段同口径);
 *  · **接**那一头(`regionsFromLegacyFurniture` + `foldLegacyStageFurniture`):
 *    每条架子的 tabs 折成**那棵单叶树**,`activeId` 翻成叶内下标,每扇浮窗折成
 *    一棵 `float:<瓦 id>` 的单叶树。
 *
 * 交接为什么走**回调**而不是「事后再读一遍 localStorage」:一份 v0 的档案里根本
 * 没有 `shelves`(那时的钉栏是一格 `pinnedId`,v3 那段才翻成架子)。判词全文在
 * `stage/legacy-furniture.ts` 的文件头 —— 那一版是这一批第一次写错、被这组用例
 * 之外的推演抓回来的。
 */

/**
 * 一份 v8 的家具:两条架子各 3 个 tab + 一扇浮窗 + 三条记忆。
 *
 * 那扇浮窗**2026-09-13 从 `providers` 换成了 `notifications`**:`providers` 那块瓦
 * 当天退役,v11 会把它从档案里逐格清掉 —— 拿一块被后一段迁移清掉的瓦当这一组
 * 用例的样本,量的就不再是「v8 → v9 住处搬家」这件事了。换的只是样本 id,
 * 这一组的判据一个字没动。v11 自己那一段的判据在 `migrate-v11.test.ts`。
 */
function v8Furniture() {
  const shelves = emptyShelves() as unknown as Record<ShelfSide, Record<string, unknown>>
  return {
    placements: {
      files: { kind: 'edge', side: 'right' },
      diff: { kind: 'edge', side: 'right' },
      terminal: { kind: 'edge', side: 'right' },
      browser: { kind: 'edge', side: 'left' },
      search: { kind: 'edge', side: 'left' },
      sessions: { kind: 'edge', side: 'left' },
      notifications: { kind: 'float' },
    } as Record<string, Placement>,
    floats: { notifications: { x: 40, y: 60, w: 880, h: 520 } },
    floatOrder: ['notifications'],
    shelves: {
      ...shelves,
      right: { tabs: ['files', 'diff', 'terminal'], activeId: 'diff', thickness: 420, collapsed: false },
      left: { tabs: ['browser', 'search', 'sessions'], activeId: 'sessions', thickness: 360, collapsed: true },
    },
    memory: {
      files: { kind: 'edge', side: 'right', index: 0 },
      notifications: { kind: 'float', rect: { x: 40, y: 60, w: 880, h: 520 } },
      apps: { kind: 'cover' },
    },
  }
}

/** 一份 v8 的存量档案(家具按空间各持一份,那是 v6 之后的形)。 */
const v8Archive = () => ({ byWorkspace: { [DEFAULT_SPACE_ID]: v8Furniture() }, dockEdge: 'left' })

/** 迁一次,把交接单收下来。 */
function migrate(archive: unknown, version = 8) {
  const handed = new Map<string | null, Record<string, unknown>>()
  const out = migrateStagePersisted(archive, version, (id, f) => {
    handed.set(id, f)
  }) as Record<string, unknown>
  return { out, handed }
}

const tabsOf = (tree: PaneNode | undefined) =>
  tree && tree.kind === 'leaf' ? tree.tabs.map(refId) : []

beforeEach(() => {
  resetLegacyStageFold()
  useWorkbenchStore.getState().reset()
})

describe('v8 → v9:摘那一头', () => {
  it('住处整格摘干净:没有 placements,架子只剩厚度与收起态', () => {
    const { out } = migrate(v8Archive())
    const space = (out.byWorkspace as Record<string, Record<string, unknown>>)[DEFAULT_SPACE_ID]
    expect('placements' in space).toBe(false)
    const shelves = space.shelves as Record<ShelfSide, Record<string, unknown>>
    expect(shelves.right).toEqual({ thickness: 420, collapsed: false })
    expect(shelves.left).toEqual({ thickness: 360, collapsed: true })
    // 几何那一半一个字不动:浮窗矩形、置顶序、位置记忆都还在 stage 的档案里。
    expect(space.floats).toEqual({ notifications: { x: 40, y: 60, w: 880, h: 520 } })
    expect(space.floatOrder).toEqual(['notifications'])
    expect(Object.keys(space.memory as object).sort()).toEqual(['apps', 'files', 'notifications'])
    // 偏好留在顶层(它不是家具)。
    expect(out.dockEdge).toBe('left')
  })

  it('**再迁一次是恒等变换**:已经是 v9 的档案原样交回(引用恒等)', () => {
    const { out } = migrate(v8Archive())
    expect(migrateStagePersisted(out, STAGE_PERSIST_VERSION)).toBe(out)
    // 把版本号说小一号再迁,v9 那段照跑一遍,而它一格都碰不到 → 交回同一个对象。
    const again = migrateStagePersisted(out, 8) as Record<string, unknown>
    const space = (again.byWorkspace as Record<string, Record<string, unknown>>)[DEFAULT_SPACE_ID]
    expect('placements' in space).toBe(false)
    expect((space.shelves as Record<string, unknown>).right).toEqual({
      thickness: 420,
      collapsed: false,
    })
  })
})

describe('v8 → v9:接那一头', () => {
  it('每条架子折成一棵单叶树,tab 次序原样,activeId 翻成叶内下标', () => {
    const { handed } = migrate(v8Archive())
    const regions = regionsFromLegacyFurniture(handed.get(DEFAULT_SPACE_ID), leafId())
    expect(Object.keys(regions).sort()).toEqual(['edge:left', 'edge:right', 'float:notifications'])

    const right = regions['edge:right']
    expect(tabsOf(right)).toEqual(['panel:files', 'panel:diff', 'panel:terminal'])
    expect(right.kind === 'leaf' && right.active).toBe(1)

    const left = regions['edge:left']
    expect(tabsOf(left)).toEqual(['panel:browser', 'panel:search', 'panel:sessions'])
    expect(left.kind === 'leaf' && left.active).toBe(2)
  })

  it('每扇浮窗折成一棵 `float:<瓦 id>` 的单叶树 —— 窗 id 就是瓦 id,矩形表因此不用改', () => {
    const { handed } = migrate(v8Archive())
    const regions = regionsFromLegacyFurniture(handed.get(DEFAULT_SPACE_ID), leafId())
    expect(tabsOf(regions['float:notifications'])).toEqual(['panel:notifications'])
  })

  it('活动 tab 已经不在名单上 → 落在末位,不留悬空下标', () => {
    const regions = regionsFromLegacyFurniture(
      { shelves: { bottom: { tabs: ['a', 'b'], activeId: 'gone' } } },
      leafId(),
    )
    const bottom = regions['edge:bottom']
    expect(bottom.kind === 'leaf' && bottom.active).toBe(1)
  })

  it('一格 tab 都没有的边不折出树来(空树会让架子画出一条空带子)', () => {
    expect(regionsFromLegacyFurniture({ shelves: { bottom: { tabs: [] } } }, leafId())).toEqual({})
    expect(regionsFromLegacyFurniture(undefined, leafId())).toEqual({})
  })
})

describe('v8 → v9:折进拼贴台那本账', () => {
  it('整本账都折(不只当前空间),而且 hidden 逐格对得上', () => {
    const { handed } = migrate({
      byWorkspace: { [DEFAULT_SPACE_ID]: v8Furniture(), 'ws-b': v8Furniture() },
    })
    for (const [space, furniture] of handed) stashLegacyStageResidency(space, furniture)
    foldLegacyStageFurniture(leafId())

    const store = useWorkbenchStore.getState()
    // 当前空间那一份摊在活状态上;别的空间那一份落在账里。
    expect(Object.keys(store.regions).sort()).toEqual([
      'center',
      'edge:left',
      'edge:right',
      'float:notifications',
    ])
    expect(tabsOf(store.regions['edge:right'])).toEqual([
      'panel:files',
      'panel:diff',
      'panel:terminal',
    ])
    expect(Object.keys(store.byWorkspace['ws-b'].regions).sort()).toEqual([
      'edge:left',
      'edge:right',
      'float:notifications',
    ])
    // 折叠不造隐藏项:这一次搬的是「摆在哪」,不是「藏起来的那些」。
    expect(store.hidden).toEqual([])
  })

  it('**幂等**:同一次运行里再折一次,树一格都不多', () => {
    const { handed } = migrate(v8Archive())
    for (const [space, furniture] of handed) stashLegacyStageResidency(space, furniture)
    foldLegacyStageFurniture(leafId())
    const first = useWorkbenchStore.getState().regions
    foldLegacyStageFurniture(leafId())
    expect(useWorkbenchStore.getState().regions).toBe(first)
  })

  it('已经有树的区域不覆盖 —— 树是新的、交接是旧的时候听树的', () => {
    const { handed } = migrate(v8Archive())
    for (const [space, furniture] of handed) stashLegacyStageResidency(space, furniture)
    // 先摆一棵右架子(模拟「第一次折完已经落了盘」)。
    useWorkbenchStore.getState().moveRef({ kind: 'panel', key: 'music' }, 'edge:right')
    foldLegacyStageFurniture(leafId())
    expect(tabsOf(useWorkbenchStore.getState().regions['edge:right'])).toEqual(['panel:music'])
  })

  it('交接单是空的(档案里一格住处都没有)→ 一棵树都不长', () => {
    const before = useWorkbenchStore.getState().regions
    foldLegacyStageFurniture(leafId())
    expect(useWorkbenchStore.getState().regions).toBe(before)
  })

  it('空交接不进账:一格 tab 都没有的家具不该让拼贴台白折一次', () => {
    stashLegacyStageResidency(DEFAULT_SPACE_ID, { placements: {}, shelves: emptyShelves() })
    const before = useWorkbenchStore.getState().regions
    foldLegacyStageFurniture(leafId())
    expect(useWorkbenchStore.getState().regions).toBe(before)
  })
})

/** 一台可读的叶号发生器(用例里不需要跨启动不撞,只需要看得懂)。 */
function leafId(): () => string {
  let n = 0
  return () => `leaf-${(n += 1)}`
}

/** 断言用:一棵树里有几片叶(单叶那一形是这一次搬家的全部形状)。 */
export const leafCountOf = (tree: PaneNode) => leavesOf(tree).length

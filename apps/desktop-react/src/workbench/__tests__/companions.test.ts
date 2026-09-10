import { beforeEach, describe, expect, it } from 'vitest'
import { refId, registerContentKind, resetContentKinds } from '../kinds'
import { CENTER_REGION, edgeRegion } from '../regions'
import {
  migrateWorkbenchPersisted,
  useWorkbenchStore,
  WORKBENCH_PER_SPACE,
  WORKBENCH_PERSIST_VERSION,
} from '../store'
import { leavesOf, pinnedIdsOf, refIdsOf } from '../tree'
import type { CompanionEnv, ContentRef } from '../kinds'
import type { PaneLeafNode, PaneNode } from '../tree'

/**
 * **伴随面**(C3,正本 `apps/desktop-react/docs/session-continuity-2026-09.md` §3)。
 *
 * 与 `preview-tab.test.ts` / `replace-ref.test.ts` 逐字同一条纪律:被测的是
 * **核心层**,所以这一组里一个「目录」「文件」的字都不该出现。夹具三种:
 *  · `home`   —— 一种自述了 `resident` 的内容(会话叶的替身,**不是**伴随面);
 *  · `tree`   —— 一种**会继承**的伴随面(`seed` 按 `env.workdir` 现铸,
 *                没有 workdir 就答 null);
 *  · `sheet`  —— 一种**不继承**的伴随面(`companion: {}`,查看器的替身);
 *  · `board`  —— 一种**按 ref 挑**的伴随面(`matches`),它就是给 `diff` 留的那个口。
 */

const home = (key: string): ContentRef => ({ kind: 'home', key })
const treeRef = (key: string): ContentRef => ({ kind: 'tree', key })
const sheet = (key: string): ContentRef => ({ kind: 'sheet', key })
const board = (key: string): ContentRef => ({ kind: 'board', key })

const env = (sessionId: string, workdir: string | null): CompanionEnv => ({ sessionId, workdir })

beforeEach(() => {
  resetContentKinds()
  registerContentKind({
    id: 'home',
    singleton: false,
    resident: { region: CENTER_REGION, seed: () => 'main' },
    title: (ref) => ({ text: ref.key }),
    icon: () => 'House',
    render: () => null,
  })
  registerContentKind({
    id: 'tree',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'FolderTree',
    render: () => null,
    companion: { seed: (row) => (row.workdir ? treeRef(row.workdir) : null) },
  })
  registerContentKind({
    id: 'sheet',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'File',
    render: () => null,
    companion: {},
  })
  registerContentKind({
    id: 'board',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'LayoutGrid',
    render: () => null,
    // 「这一种下面只有一格算」—— 给 `panel:diff` 留的那个口的等价形。
    companion: { matches: (ref) => ref.key === 'changes' },
  })
  useWorkbenchStore.getState().reset()
  useWorkbenchStore.getState().seed()
})

const st = () => useWorkbenchStore.getState()
const center = (): PaneNode => st().regions[CENTER_REGION]
const centerLeaf = (): PaneLeafNode => leavesOf(center())[0]
const centerIds = (): string[] => refIdsOf(center())

/** 中央区那片常驻叶的 id —— 伴随面开在它旁边,与真机上「一条标签条」同形。 */
const hostLeaf = () => centerLeaf().id

describe('swapCompanions:四条规则', () => {
  it('有记录 → 逐格放回原位次,活动格照记录点亮', () => {
    const leaf = hostLeaf()
    st().openRef(treeRef('/a'), { region: CENTER_REGION, leafId: leaf })
    st().openRef(sheet('/a/one.txt'), { region: CENTER_REGION, leafId: leaf })
    // 让「最后看的」落在目录那一格上,而不是刚开出来的文件。
    st().activateTab(leaf, centerIds().indexOf(refId(treeRef('/a'))))
    const before = centerIds()

    st().swapCompanions('A', 'B', env('B', null))
    expect(centerIds()).toEqual([refId(home('main'))])

    st().swapCompanions('B', 'A', env('A', null))
    expect(centerIds()).toEqual(before)
    expect(centerLeaf().tabs[centerLeaf().active]).toEqual(treeRef('/a'))
  })

  it('没记录 → 继承**种类**不继承内容:目录跟过去,文件不跟', () => {
    const leaf = hostLeaf()
    st().openRef(treeRef('/a'), { region: CENTER_REGION, leafId: leaf })
    st().openRef(sheet('/a/one.txt'), { region: CENTER_REGION, leafId: leaf })

    st().swapCompanions('A', 'B', env('B', '/b'))
    expect(centerIds()).toEqual([refId(home('main')), refId(treeRef('/b'))])
  })

  it('进场会话没 workdir → 什么都不开', () => {
    st().openRef(treeRef('/a'), { region: CENTER_REGION, leafId: hostLeaf() })
    st().swapCompanions('A', 'B', env('B', null))
    expect(centerIds()).toEqual([refId(home('main'))])
  })

  it('`matches` 挑出来的那一格算伴随面,同一种里别的不算', () => {
    const leaf = hostLeaf()
    st().openRef(board('changes'), { region: CENTER_REGION, leafId: leaf })
    st().openRef(board('settings'), { region: CENTER_REGION, leafId: leaf })

    st().swapCompanions('A', 'B', env('B', null))
    // `board:settings` 不是伴随面 —— 它是一块普通的面,留在原地。
    expect(centerIds()).toEqual([refId(home('main')), refId(board('settings'))])
  })
})

describe('swapCompanions:边角', () => {
  it('钉住的那一格不收 —— 也不算进离场那条会话的记录', () => {
    const leaf = hostLeaf()
    st().openRef(treeRef('/a'), { region: CENTER_REGION, leafId: leaf })
    st().openRef(sheet('/a/one.txt'), { region: CENTER_REGION, leafId: leaf })
    st().setTabPinned(leaf, centerIds().indexOf(refId(treeRef('/a'))), true)

    st().swapCompanions('A', 'B', env('B', null))
    // 钉住的目录留在屏幕上;没钉的文件被收走了。
    expect(centerIds()).toEqual([refId(home('main')), refId(treeRef('/a'))])
    expect(st().sessionCompanions.A.seats.map((seat) => seat.ref)).toEqual([sheet('/a/one.txt')])
  })

  it('两条会话同一个 workdir:各记各的,树上同一格只放一份', () => {
    const leaf = hostLeaf()
    st().openRef(treeRef('/same'), { region: CENTER_REGION, leafId: leaf })
    // 甲离场 → 乙继承同一个 workdir(于是两条记的是同一格内容)。
    st().swapCompanions('A', 'B', env('B', '/same'))
    expect(centerIds()).toEqual([refId(home('main')), refId(treeRef('/same'))])
    st().swapCompanions('B', 'A', env('A', '/same'))

    expect(st().sessionCompanions.B.seats.map((seat) => seat.ref)).toEqual([treeRef('/same')])
    // 甲的记录放回来,树上仍旧只有一格(不变量 1:一个内容在一个区域里只出现一次)。
    expect(centerIds()).toEqual([refId(home('main')), refId(treeRef('/same'))])
  })

  it('关掉一格伴随面 = 切回来不会再冒出来(空记录 ≠ 没记录)', () => {
    const leaf = hostLeaf()
    st().openRef(treeRef('/a'), { region: CENTER_REGION, leafId: leaf })
    st().swapCompanions('A', 'B', env('B', null))
    st().swapCompanions('B', 'A', env('A', null))
    // 回到甲,把那格关掉。
    st().closeTab(leaf, centerIds().indexOf(refId(treeRef('/a'))))
    st().swapCompanions('A', 'B', env('B', null))
    expect(st().sessionCompanions.A).toEqual({ seats: [], active: null })

    // 再切回甲:**记着一张空表**,所以既不放回也不按种类继承。
    st().swapCompanions('B', 'A', env('A', '/a'))
    expect(centerIds()).toEqual([refId(home('main'))])
  })

  it('删除会话 → 记录一起删', () => {
    st().openRef(treeRef('/a'), { region: CENTER_REGION, leafId: hostLeaf() })
    st().swapCompanions('A', 'B', env('B', null))
    expect(Object.keys(st().sessionCompanions)).toEqual(['A'])

    st().forgetCompanions(['A'])
    expect(st().sessionCompanions).toEqual({})
    // 一条都没删到 = 引用恒等(不惊动订阅者)。
    const ledger = st().sessionCompanions
    st().forgetCompanions(['A', 'ghost'])
    expect(st().sessionCompanions).toBe(ledger)
  })

  it('并排两片叶:伴随面按**环境会话**换,焦点叶一个字不动', () => {
    // 架子上劈两片叶:目录留在原叶,文件被拉到新那一片(会话叶在中央区)。
    st().openRef(treeRef('/a'), { region: edgeRegion('right') })
    const shelf = leavesOf(st().regions[edgeRegion('right')])[0].id
    st().openRef(sheet('/a/one.txt'), { region: edgeRegion('right'), leafId: shelf })
    st().splitLeaf(shelf, 'row', sheet('/a/one.txt'))
    expect(leavesOf(st().regions[edgeRegion('right')])).toHaveLength(2)
    // 焦点停在中央区那片会话叶上 —— 换会话不该把它挪走。
    st().setFocusLeaf(hostLeaf())
    const focus = st().focusLeafId

    st().swapCompanions('A', 'B', env('B', '/b'))
    expect(st().focusLeafId).toBe(focus)
    // 两片叶上的伴随面都被收走了,继承出来的那一格落在**目录离场时坐的那一片**。
    const shelfIds = refIdsOf(st().regions[edgeRegion('right')])
    expect(shelfIds).toEqual([refId(treeRef('/b'))])
  })

  it('幂等 / 空表不动:同一条会话、没有伴随面时一个字都不写', () => {
    const regions = st().regions
    const ledger = st().sessionCompanions
    st().swapCompanions('A', 'A', env('A', '/a'))
    expect(st().regions).toBe(regions)
    st().swapCompanions('A', 'B', env('B', null))
    expect(st().regions).toBe(regions)
    // 甲名下确实记了一条空的(那与「从来没记过」不是一句话),所以账**换了身份**。
    expect(st().sessionCompanions).not.toBe(ledger)
    const after = st().sessionCompanions
    /*
     * 逐字相同的一条记录再写一遍 = 引用恒等。**从甲再离场一次**(去丙)——
     * 不能走「切回甲再离开」:进场那一拍会按不变量把甲那条销掉(判词在
     * `store.swapCompanions` ③),回来的当然是一条新记录。
     */
    st().swapCompanions('A', 'C', env('C', null))
    expect(st().sessionCompanions).toBe(after)
  })
})

describe('钉住:树侧', () => {
  it('setTabPinned 开合幂等,读的时候滤掉指不着的残渣', () => {
    const leaf = hostLeaf()
    st().openRef(treeRef('/a'), { region: CENTER_REGION, leafId: leaf })
    const at = centerIds().indexOf(refId(treeRef('/a')))

    st().setTabPinned(leaf, at, true)
    expect(pinnedIdsOf(centerLeaf())).toEqual([refId(treeRef('/a'))])
    const pinnedTree = center()
    // 再钉一次 = 恒等(引用都不换)。
    st().setTabPinned(leaf, at, true)
    expect(center()).toBe(pinnedTree)

    // 关掉那一格 → 名单跟着落掉,不留残渣。
    st().closeTab(leaf, at)
    expect(centerLeaf().pinned).toBeUndefined()
  })

  it('钉住随家具落盘(与预览格那一格相反)', () => {
    const leaf = hostLeaf()
    st().openRef(treeRef('/a'), { region: CENTER_REGION, leafId: leaf })
    st().setTabPinned(leaf, centerIds().indexOf(refId(treeRef('/a'))), true)
    st().previewTab(leaf, centerIds().indexOf(refId(treeRef('/a'))))

    const picked = WORKBENCH_PER_SPACE.pick(st())
    const savedLeaf = leavesOf(picked.regions[CENTER_REGION])[0]
    expect(savedLeaf.pinned).toEqual([refId(treeRef('/a'))])
    expect(savedLeaf.previewIndex).toBeUndefined()
    expect(picked.sessionCompanions).toBe(st().sessionCompanions)
  })
})

describe('persist v4 → v5', () => {
  const v4 = () => ({
    byWorkspace: {
      default: {
        regions: { center: { kind: 'leaf', id: 'l1', tabs: [{ kind: 'home', key: 'main' }], active: 0 } },
        hidden: [],
        pairRatios: {},
        recentRoots: [],
      },
    },
  })

  it('老档案补一格空表,别的一个字不动', () => {
    const out = migrateWorkbenchPersisted(v4(), 4) as Record<string, Record<string, Record<string, unknown>>>
    expect(out.byWorkspace.default.sessionCompanions).toEqual({})
    expect(out.byWorkspace.default.regions).toEqual(v4().byWorkspace.default.regions)
  })

  it('幂等 + 引用恒等:跑过一遍的再跑一遍逐字相同、且原样交回同一个对象', () => {
    const once = migrateWorkbenchPersisted(v4(), 4) as Record<string, unknown>
    const twice = migrateWorkbenchPersisted(once, 4)
    expect(twice).toBe(once)
    // 今天版本号的那一份不再迁移。
    expect(migrateWorkbenchPersisted(once, WORKBENCH_PERSIST_VERSION)).toBe(once)
  })
})

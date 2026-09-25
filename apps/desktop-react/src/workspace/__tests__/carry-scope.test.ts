import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpaceRecord } from '@shared/ipc/spaces'
import { configureSpacesPort } from '../../data/spaces-port'
import { useWorkspaceStore } from '../store'
import { DEFAULT_SPACE_ID } from '../types'
import { startPerSpaceLayout, stopPerSpaceLayout } from '../layout-scope'
import { STAGE_PER_SPACE, useStageStore } from '../../stage/store'
import { GLOBAL_ITEMS, SESSION_ITEMS, STAGE_ITEMS, findItem } from '../../stage/items'
import { PANEL_KIND, panelRef } from '../../stage/panel-ref'
import {
  WORKBENCH_PER_SPACE,
  useWorkbenchStore,
} from '../../workbench/store'
import { registerContentKind, refId, resetContentKinds } from '../../workbench/kinds'
import { CENTER_REGION, edgeRegion, floatRegion } from '../../workbench/regions'
import * as T from '../../workbench/tree'
import type { ContentRef } from '../../workbench/kinds'

/**
 * **全局瓦携带,接线那一半**(S1,正本 `apps/desktop-react/docs/dock-scope-2026-09.md` §2)。
 *
 * 上一组(`workbench/__tests__/carry.test.ts`)守的是两只纯函数;这一组守的是
 * 「真的接上了」—— 换一次空间,app 级的那块瓦连区域、连浮窗 rect、连位置记忆一起
 * 跟着人走,而空间自己的那些一格不许串。用户原话:「切工作区时,『工作区』这块瓦
 * 该在哪一段就还在哪一段,两个工作区里它不能一个在这一个在那」。
 *
 * ── 夹具:**真的瓦表 + 一份最小的 `panel` 自述** ──────────────────────────
 * 不 import `content/kinds` 那个 barrel(它的 import 闭包会拖进整棵 React 内容树)。
 * 这里照 `content/kinds/panel.tsx` 那一行原样登记一遍 `level` 自述:
 * **答案来自真的 `STAGE_ITEMS`**,所以「哪几块瓦是 app 级」这件事这一组是真在核的。
 */

const DEFAULT: SpaceRecord = { id: DEFAULT_SPACE_ID, name: '默认', createdAt: 0 }
const WORK: SpaceRecord = { id: 'ws-work', name: '工作', createdAt: 100 }

/** §2.2 表上那三块 app 级的瓦之一 —— 用户点名的那一块。 */
const APP_TILE = 'workspace'
/** 一块普通的 space 级瓦。 */
const SPACE_TILE = 'search'

const RIGHT = edgeRegion('right')

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

const wb = () => useWorkbenchStore.getState()
const stage = () => useStageStore.getState()
const switchTo = (id: string) => useWorkspaceStore.getState().switchTo(id)

/** 这一格此刻在哪个区域(哪棵树都不在 = null)。 */
function regionOf(ref: ContentRef): string | null {
  const at = T.locateSeatIn(wb().regions, refId(ref))
  return at ? at.region : null
}

beforeEach(async () => {
  resetContentKinds()
  registerContentKind({
    id: PANEL_KIND,
    singleton: true,
    // 与 `content/kinds/panel.tsx` 逐字同一句(判词在那儿)。
    level: (ref) => findItem(ref.key)?.level ?? 'space',
    title: (ref) => ({ text: ref.key }),
    icon: () => 'LayoutGrid',
    render: () => null,
  })
  useWorkspaceStore.getState().reset()
  localStorage.clear()
  useWorkbenchStore.getState().reset()
  useStageStore.setState({ ...STAGE_PER_SPACE.factory(), byWorkspace: {} })
  await loadSpaces()
  startPerSpaceLayout()
})

afterEach(() => {
  stopPerSpaceLayout()
  useWorkspaceStore.getState().reset()
  useWorkbenchStore.getState().reset()
  resetContentKinds()
})

describe('拼贴树:app 级的格随人走,space 级的留下', () => {
  it('在 A 钉到右架子 → 切到 B **还在右架子**;space 级那一块留在 A', () => {
    wb().openRef(panelRef(APP_TILE), { region: RIGHT })
    wb().openRef(panelRef(SPACE_TILE), { region: RIGHT })
    expect(regionOf(panelRef(APP_TILE))).toBe(RIGHT)

    switchTo('ws-work')
    expect(regionOf(panelRef(APP_TILE))).toBe(RIGHT)
    expect(regionOf(panelRef(SPACE_TILE))).toBeNull()

    switchTo(DEFAULT_SPACE_ID)
    expect(regionOf(panelRef(APP_TILE))).toBe(RIGHT)
    expect(regionOf(panelRef(SPACE_TILE))).toBe(RIGHT)
  })

  it('**在 B 关掉它,切回 A 它也不在** —— 这是「先剥后携」那一句的全部意义', () => {
    wb().openRef(panelRef(APP_TILE), { region: RIGHT })
    switchTo('ws-work')

    const at = T.locateSeatIn(wb().regions, refId(panelRef(APP_TILE)))!
    wb().closeTab(at.leafId, at.index)
    expect(regionOf(panelRef(APP_TILE))).toBeNull()

    // A 的账上还留着上一次离场时那一格 **旧影**;不剥的话它会在这里变回来。
    switchTo(DEFAULT_SPACE_ID)
    expect(regionOf(panelRef(APP_TILE))).toBeNull()
  })

  it('切两次不会攒出两份(单例的定义在它那一层上照旧成立)', () => {
    wb().openRef(panelRef(APP_TILE), { region: RIGHT })
    switchTo('ws-work')
    switchTo(DEFAULT_SPACE_ID)
    switchTo('ws-work')
    const all = Object.values(wb().regions).flatMap((tree) => T.refIdsOf(tree))
    expect(all.filter((id) => id === refId(panelRef(APP_TILE)))).toHaveLength(1)
  })

  it('浮窗里那一格 → 换空间照旧在**一扇浮窗**里(区域没了当场建回来)', () => {
    const region = floatRegion(APP_TILE)
    wb().openRef(panelRef(APP_TILE), { region })
    switchTo('ws-work')
    expect(regionOf(panelRef(APP_TILE))).toBe(region)
  })
})

describe('开机不剥', () => {
  it('水合 / 首进某空间走的是 `spreadSpace`,碰不到 `carry` —— 账上那一格原样摊开', () => {
    // 账里塞一份「上次退出时 app 级瓦钉在右架子」的档案,再走一次 merge。
    const leaf = T.makeLeaf('L-boot', [panelRef(APP_TILE)])
    const furniture = {
      ...WORKBENCH_PER_SPACE.factory(),
      regions: { [CENTER_REGION]: T.makeLeaf('L-c'), [RIGHT]: leaf },
    }
    const merged = {
      ...useWorkbenchStore.getState(),
      byWorkspace: { [DEFAULT_SPACE_ID]: furniture },
    }
    // `spreadSpace` 就是 merge 与首进某空间共用的那一句(判词在 per-space.ts)。
    useWorkbenchStore.setState({ ...merged, ...furniture })
    expect(regionOf(panelRef(APP_TILE))).toBe(RIGHT)
  })
})

describe('隐藏表里 app 级的 ref 同样携带', () => {
  it('藏起来的那一格跟着走;换个空间不该替人把它变回来', () => {
    wb().openRef(panelRef(APP_TILE), { region: RIGHT })
    const at = T.locateSeatIn(wb().regions, refId(panelRef(APP_TILE)))!
    wb().hideTab(at.leafId, at.index)
    expect(wb().hidden.map((e) => refId(e.ref))).toContain(refId(panelRef(APP_TILE)))

    switchTo('ws-work')
    expect(wb().hidden.map((e) => refId(e.ref))).toContain(refId(panelRef(APP_TILE)))
    // 它是**藏着**的,不是在树上 —— 携带没有顺手替人撤销那一次操作。
    expect(regionOf(panelRef(APP_TILE))).toBeNull()
  })

  it('space 级那一格的隐藏记录留在原空间', () => {
    wb().openRef(panelRef(SPACE_TILE), { region: RIGHT })
    const at = T.locateSeatIn(wb().regions, refId(panelRef(SPACE_TILE)))!
    wb().hideTab(at.leafId, at.index)

    switchTo('ws-work')
    expect(wb().hidden.map((e) => refId(e.ref))).not.toContain(refId(panelRef(SPACE_TILE)))
    switchTo(DEFAULT_SPACE_ID)
    expect(wb().hidden.map((e) => refId(e.ref))).toContain(refId(panelRef(SPACE_TILE)))
  })
})

describe('形态机那一半:浮窗 rect 与位置记忆', () => {
  it('float 连 rect 一起搬 —— 在 A 是那个角那么大,到 B 还是', () => {
    stage().openAs(APP_TILE, { kind: 'float' })
    const rect = { ...stage().floats[APP_TILE]! }
    stage().resizeFloat(APP_TILE, { ...rect, w: rect.w + 77 })
    const moved = { ...stage().floats[APP_TILE]! }

    switchTo('ws-work')
    expect(stage().floats[APP_TILE]).toEqual(moved)
    expect(stage().floatOrder).toContain(APP_TILE)
  })

  it('memory 里 app 级那几条携带,space 级那几条留在原空间', () => {
    stage().openAs(APP_TILE, { kind: 'float' })
    stage().openAs(SPACE_TILE, { kind: 'float' })
    expect(Object.keys(stage().memory).sort()).toEqual([APP_TILE, SPACE_TILE].sort())

    switchTo('ws-work')
    expect(stage().memory[APP_TILE]).toBeDefined()
    expect(stage().memory[SPACE_TILE]).toBeUndefined()
    expect(stage().floats[SPACE_TILE]).toBeUndefined()

    switchTo(DEFAULT_SPACE_ID)
    expect(stage().memory[SPACE_TILE]).toBeDefined()
  })

  it('在 B 把它关回 Dock,切回 A 它照旧收着(**先剥后携**在这一侧同样成立)', () => {
    stage().openAs(APP_TILE, { kind: 'float' })
    switchTo('ws-work')
    stage().closeToDock(APP_TILE)
    // 「开着的浮窗有哪几扇」是树的投影(产地 `stage/residency.ts`),关回 Dock 就没了。
    expect(stage().floatOrder).not.toContain(APP_TILE)

    switchTo(DEFAULT_SPACE_ID)
    // A 账上那条置顶序是**旧影**,不剥的话它会在这里把窗子变回来。
    expect(stage().floatOrder).not.toContain(APP_TILE)
    expect(regionOf(panelRef(APP_TILE))).toBeNull()
    /*
     * `floats[id]` 那格矩形**留着是对的**:它是位置记忆(判词在
     * `store.ensureFloatRect` 上「收起来再开还在老位置」),不是「此刻开着几扇窗」。
     * 携带搬的正是这一份记忆 —— 下次在任何空间里再把它浮出来,还是那个身量。
     */
    expect(stage().floats[APP_TILE]).toBeDefined()
  })
})

describe('全屏:换空间先退,那一格落回原叶', () => {
  it('app 级的格全屏着换空间 → `full` 清零,而它还在原来那个区域', () => {
    wb().openRef(panelRef(APP_TILE), { region: RIGHT })
    const at = T.locateSeatIn(wb().regions, refId(panelRef(APP_TILE)))!
    wb().enterFull(panelRef(APP_TILE), { region: RIGHT, leafId: at.leafId, index: at.index })
    expect(wb().full).not.toBeNull()

    switchTo('ws-work')
    expect(wb().full).toBeNull()
    expect(regionOf(panelRef(APP_TILE))).toBe(RIGHT)
  })
})

describe('伴随面的账不被携带碰(session-continuity §3.4 末条)', () => {
  it('换工作区:伴随面的记录随空间收放,携带一个字都不写它', () => {
    const record = { seats: [], active: null }
    useWorkbenchStore.setState({ sessionCompanions: { 's-a': record } })
    wb().openRef(panelRef(APP_TILE), { region: RIGHT })

    switchTo('ws-work')
    // 新空间是它自己那一本(出厂 = 空);而 app 级瓦照旧跟过来了。
    expect(wb().sessionCompanions).toEqual({})
    expect(regionOf(panelRef(APP_TILE))).toBe(RIGHT)

    switchTo(DEFAULT_SPACE_ID)
    expect(wb().sessionCompanions['s-a']).toEqual(record)
  })
})

describe('Dock 分隔线的分组:逐字同今天(拍点 1)', () => {
  /*
   * 分组读的是 `dockGroup`(纯视觉),**不是** `level`(作用域)。这一条钉的正是
   * 「改名不改行为」:照 `level` 画的话分组会变成
   * 「files diff terminal browser search sessions providers music notifications ｜
   *   workspace settings apps」—— 那是一次用户可感知的变化,而缺省 = 保持旧行为。
   */
  it('两组的成员与次序,与 09-10 之前一字不差', () => {
    expect(SESSION_ITEMS.map((i) => i.id)).toEqual(['files', 'diff', 'terminal'])
    expect(GLOBAL_ITEMS.map((i) => i.id)).toEqual([
      // 2026-09-13:`providers` 那一块瓦退役(模型服务并进设置页),所以这张名单
      // 短了一格。**次序与别的成员一个字没动** —— 这一条钉的是「改一块瓦不许
      // 顺手重排 Dock」。
      // 2026-09-17:「我的清单」(`todo`,待办 T3)一格插在音乐之后;别的成员与次序一个字没动。
      // 2026-09-25:内存监视器(`memory`)一格插在待办之后;同上,别的一个字没动。
      'browser', 'search', 'sessions', 'notifications',
      'workspace', 'music', 'todo', 'memory', 'settings', 'apps',
    ])
  })

  it('两组合起来就是整张表(一块瓦不许两边都不在)', () => {
    expect([...SESSION_ITEMS, ...GLOBAL_ITEMS]).toHaveLength(STAGE_ITEMS.length)
  })

  it('app 级只有 §2.2 表上那三块 —— 其余全 space(拍点 2:通知也是 space)', () => {
    expect(STAGE_ITEMS.filter((i) => i.level === 'app').map((i) => i.id))
      /*
       * B2:`browser` 从 `space` 升到 `app`(方案 §2.2-4)—— 一格网页与「你此刻
       * 在做哪个项目」无关,切工作区不该让它消失。次序 = `STAGE_ITEMS` 的声明序,
       * 而浏览器那一行排在这三块之前。
       */
      .toEqual(['browser', 'workspace', 'settings', 'apps'])
    expect(findItem('notifications')?.level).toBe('space')
  })
})

/*
 * ── 反证(真跑过,拆掉即红)─────────────────────────────────────────────
 * ① 拆掉 `WORKBENCH_PER_SPACE.carry` 里那句 `T.stripByLevel`(进场不剥)→
 *    「在 B 关掉它,切回 A 它也不在」当场红:A 账上那格旧影会把它变回来。
 * ② 把 `kinds.residencyLevelOf` 改成恒答 `'space'` → 这一组里每一条携带断言全红。
 */

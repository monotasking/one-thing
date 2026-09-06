import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusTree } from '../../focus/registry'
import { openStageItem, summonStageItem } from '../open-item'
import { useStageStore } from '../store'
import { initialStageState } from '../transitions'
import { useWorkbenchStore } from '../../workbench/store'
import { seedStage } from '../../test/stage-fixture'
import { panelRef } from '../panel-ref'
import { refId } from '../../workbench/kinds'
/*
 * A9 那一组要真的进一次全屏,而 `workbench.enterFull` 先问 `canGoFull(ref)` ——
 * 那句判据读的是**内容种类表**(种类自述 `fullable`)。种类是模块级注册,
 * 所以这只用例得把它们装上;别的组不需要,但装上对它们也是恒等的。
 */
import '../../content/kinds'
import type { StageState } from '../types'

/**
 * **一台机器,两个入口 —— 逐字相同**(W7-p 裁定 6,审计 A 的 A7/A8)。
 *
 * ── 病历 ──────────────────────────────────────────────────────────────────
 * 「点 Dock 瓦这一下什么意思」从前是**第二台机器**(`placement.clickDockIcon` 的
 * 四条 if),与召唤那四态讲两种语言。真机现场:同一扇浮窗已经在最上面时,
 * 点瓦答「再置顶一次」= 屏幕一动不动(用户以为点坏了),按快捷键答「送焦点」;
 * 再来一下,点瓦还是零反馈,按键把它收起来。用户只有一套心智。
 *
 * ── 这一组守什么 ──────────────────────────────────────────────────────────
 * 不是「两条路各自对不对」(那是 `summon.test.ts` 那张状态表的事),而是
 * **两条路从同一份状态出发,落在同一份状态上**。所以每一条的做法都一样:
 * 摆一份现场 → 走鼠标那条 → 拓一份快照 → 把现场原样摆回来 → 走键盘那条 →
 * 两份快照逐字比。
 *
 * 反证:把 `stage/store.clickDockIcon` 改回 `landFull(orchestrate(P.clickDockIcon(...)))`
 * (或在 `open-item.ts` 里把 `openStageItem` 写成第二只函数),浮窗那两条当场红。
 */

/**
 * 比什么:形态机整份活状态 + 拼贴台那两格账。**不挑字段** —— 挑字段就是给分叉留门。
 *
 * 叶 id 按**出场次序**换成 `L1 / L2 …`:`nextLeafId()` 是单调计数器(判词在
 * `workbench/ids`),两次摆同一份现场必然拿到两串不同的 id,而那个差别与「两条路
 * 落在同一处没有」半点关系。换的是名字,不是结构 —— 两棵树形状一有差别,
 * 编号立刻跟着错位,这一句因此没有放过任何东西。
 */
function snapshot() {
  const st = useStageStore.getState()
  const wb = useWorkbenchStore.getState()
  const seen = new Map<string, string>()
  const text = JSON.stringify({
    placements: st.placements,
    shelves: st.shelves,
    floats: st.floats,
    floatOrder: st.floatOrder,
    memory: st.memory,
    stageId: st.stageId,
    flashPinned: st.flashPinned,
    flashSide: st.flashSide,
    regions: wb.regions,
    full: wb.full,
  })
  return text.replace(/leaf-[a-z0-9]+-\d+/g, (id) => {
    if (!seen.has(id)) seen.set(id, `L${seen.size + 1}`)
    return seen.get(id)!
  })
}

/* ── 效果那一层(W7-p 修一轮裁定 4)─────────────────────────────────────────
 *
 * 状态快照证得了「落在同一处」,证不了「用同一副动作、同一个次序落过去」——
 * 而分叉正是从次序开始的:同一份最终状态,一条路先展架子再点名 tab、另一条反过来,
 * 在屏幕上是两种手感(先看见隔壁那格内容闪一下)。裁定 4 那几处真实分叉里有两处
 * (第三态同步 `activateScope` vs 排在提交之后;第二态送不送焦点)**状态快照完全
 *看不见**,所以这一组把比对扩到**调用了哪些 store 动作、什么次序**。
 */

/** 记进日志的那几口 —— 召唤四态能碰到的全部落点,一个不落。 */
const WATCHED = [
  'toggleShelfCollapsed',
  'activateShelfTab',
  'closeToDock',
  'closeFloat',
  'focusFloat',
  'openAs',
] as const

/**
 * 跑一趟并记下**效果**:store 动作(带参数)按调用序,加上落焦那一句。
 *
 * 落焦排在 React 提交之后(`focus/after-commit` 那副队列),所以要 `await` 一拍
 * 微任务才记得到 —— 那一拍正是队列里的第一站(判词在那只文件上)。
 */
async function effectsOf(run: () => void): Promise<string[]> {
  const log: string[] = []
  const before = useStageStore.getState()
  const restore: Record<string, unknown> = {}
  const patch: Record<string, unknown> = {}
  for (const name of WATCHED) {
    const original = before[name] as (...args: unknown[]) => unknown
    restore[name] = original
    patch[name] = (...args: unknown[]) => {
      log.push(`${name}(${JSON.stringify(args)})`)
      return original(...args)
    }
  }
  useStageStore.setState(patch as Partial<ReturnType<typeof useStageStore.getState>>)
  const focusSpy = vi.spyOn(focusTree, 'activateScope').mockImplementation((scope, opts) => {
    log.push(`focus(${scope}#${opts?.owner ?? ''})`)
    return true
  })
  try {
    run()
    await Promise.resolve()
    return log
  } finally {
    useStageStore.setState(restore as Partial<ReturnType<typeof useStageStore.getState>>)
    focusSpy.mockRestore()
  }
}

/** 同一份现场跑两条路,答两份快照 + 两份效果日志。`focused` = 焦点在不在这块瓦里。 */
async function bothEntries(id: string, seed: Partial<StageState>, focused = false) {
  const spy = vi.spyOn(focusTree, 'isOwnerActive').mockImplementation((owner) => focused && owner === id)
  try {
    seedStage(seed)
    // 鼠标那条:Dock 的瓦 / 「所有应用」里那格都调它。
    const clickEffects = await effectsOf(() => openStageItem(id))
    const byClick = snapshot()
    seedStage(seed)
    // 键盘那条:`toggle:<面>` 那族命令调它。
    const keyEffects = await effectsOf(() => summonStageItem(id))
    return { byClick, byKey: snapshot(), clickEffects, keyEffects }
  } finally {
    spy.mockRestore()
  }
}

beforeEach(() => {
  useStageStore.setState({ ...initialStageState })
  useWorkbenchStore.setState({ full: null })
})

afterEach(() => {
  useStageStore.setState({ ...initialStageState })
})

describe('点瓦与快捷键是同一件事', () => {
  /**
   * 第一条是**结构**的:两个名字指着同一只函数。它比下面每一条状态断言都强 ——
   * 状态断言只能证「今天这几格现场一样」,这一条证的是「**没有第二份实现**
   * 可供下一个人只改其中一条」。
   */
  it('两个入口在源码层面就是同一只函数(判词在 open-item.ts)', () => {
    expect(openStageItem).toBe(summonStageItem)
  })

  it('① 在 Dock 里(没打开)—— 两条都按记忆开出来', async () => {
    const { byClick, byKey, clickEffects, keyEffects } = await bothEntries('files', {
      memory: { files: { kind: 'float', rect: { x: 120, y: 80, w: 640, h: 480 } } },
    })
    expect(byClick).toBe(byKey)
    expect(clickEffects).toEqual(keyEffects)
    expect(useStageStore.getState().placements.files?.kind).toBe('float')
  })

  it('② 钉在架子上、架子收着 —— 两条都展开并点名', async () => {
    const seed: Partial<StageState> = {
      shelves: {
        ...initialStageState.shelves,
        right: { ...initialStageState.shelves.right, tabs: ['sessions', 'files'], activeId: 'sessions', collapsed: true },
      },
    }
    const { byClick, byKey, clickEffects, keyEffects } = await bothEntries('files', seed)
    expect(byClick).toBe(byKey)
    expect(clickEffects).toEqual(keyEffects)
    // 第二态的效果**逐字**钉住(裁定 4:分流表只有一份,所以次序也只有一份):
    // 先点名那一格 → 再展开整条架子 → 最后把键盘送进去。
    expect(clickEffects).toEqual([
      'activateShelfTab(["right","files"])',
      'toggleShelfCollapsed(["right"])',
      'focus(shelf-layer#files)',
    ])
    expect(useStageStore.getState().shelves.right.collapsed).toBe(false)
    expect(useStageStore.getState().shelves.right.activeId).toBe('files')
    // 闪一下那一格从前只有鼠标那条有(它长在 `clickDockIcon` 的架子支上)。
    expect(useStageStore.getState().flashPinned).toBe(1)
  })

  it('③ 浮窗已经在最上面、焦点不在里面 —— 两条都只送焦点,形态一个字不动', async () => {
    const seed: Partial<StageState> = { placements: { files: { kind: 'float' } } }
    const { byClick, byKey, clickEffects, keyEffects } = await bothEntries('files', seed, false)
    expect(byClick).toBe(byKey)
    expect(clickEffects).toEqual(keyEffects)
    /*
     * **只有落焦一句,而且排在提交之后**(裁定 4)。反证:把 `itemSummonTarget.focus`
     * 换回同步的 `focusTree.activateScope`,`await Promise.resolve()` 之前它就已经
     * 记下了 —— 那时这条仍旧绿,所以这一条真正钉住的是「一句、而且是那一句」;
     * 时机那一半由 `gate:focus` 与 `focus-follow-settle` 那两组真机/时序用例守。
     */
    expect(clickEffects).toEqual(['focus(float-layer#files)'])
    /*
     * 这一条正是 A7 的原始现场:从前点瓦走 `focusFloatIn`(把它挪到 floatOrder
     * 末位 —— 它已经在末位,于是零反馈),按键走 `focus`。今天两条都是后者。
     */
    expect(useStageStore.getState().placements.files?.kind).toBe('float')
  })

  it('④ 浮窗在最上面、焦点就在里面 —— 两条都收起来(A8:点瓦从前永远收不掉)', async () => {
    const seed: Partial<StageState> = { placements: { files: { kind: 'float' } } }
    const { byClick, byKey, clickEffects, keyEffects } = await bothEntries('files', seed, true)
    expect(byClick).toBe(byKey)
    expect(clickEffects).toEqual(keyEffects)
    expect(clickEffects).toEqual(['closeToDock(["files"])'])
    expect(useStageStore.getState().placements.files?.kind ?? 'dock').toBe('dock')
  })

  it('④ 之二 钉在架子上、看得见、焦点在里面 —— 两条都收整条架子(不是关掉它)', async () => {
    const seed: Partial<StageState> = {
      shelves: {
        ...initialStageState.shelves,
        right: { ...initialStageState.shelves.right, tabs: ['files'], activeId: 'files', collapsed: false },
      },
    }
    const { byClick, byKey, clickEffects, keyEffects } = await bothEntries('files', seed, true)
    expect(byClick).toBe(byKey)
    expect(clickEffects).toEqual(keyEffects)
    // 收的是**整条架子**,不是 `closeToDock` —— 效果日志把这句话钉死。
    expect(clickEffects).toEqual(['toggleShelfCollapsed(["right"])'])
    expect(useStageStore.getState().shelves.right.collapsed).toBe(true)
    // 收的是架子,那块瓦仍旧钉在上面。
    expect(useStageStore.getState().shelves.right.tabs).toEqual(['files'])
  })

  it('store 上那一口 `clickDockIcon` 也只是转发(AppShell 的小丸与 Dock 的两处仍在叫它)', () => {
    seedStage({ placements: { files: { kind: 'float' } } })
    useStageStore.getState().clickDockIcon('files')
    const byStoreDoor = snapshot()
    seedStage({ placements: { files: { kind: 'float' } } })
    summonStageItem('files')
    expect(byStoreDoor).toBe(snapshot())
  })
})

/**
 * **第三个入口:一格内容**(W7-p 修一轮裁定 4)。
 *
 * `summonItem`(瓦)与 `summonRef`(内容)从前各写了一套 `switch` —— 判据一份、
 * **效果两份**,而且当场就已经分叉(第三态一边同步 `activateScope`、一边排在
 * 提交之后;第二态一边送焦点、一边只留一格没人读的点名)。今天两条都经
 * `applySummonAction` 那唯一一张表,所以「同一块瓦、同一份现场,从两个入口召唤」
 * 必须落在同一处。
 *
 * 反证:把 `store.summonRef` 的分流改回它自己那套 `switch`,第三态那条当场红
 * (效果日志里少一句 `focus`,或者多一句同步的)。
 */
describe('瓦这个入口与内容那个入口是同一台机器', () => {
  const pinnedRight = (collapsed: boolean): Partial<StageState> => ({
    shelves: {
      ...initialStageState.shelves,
      right: {
        ...initialStageState.shelves.right,
        tabs: ['sessions', 'files'],
        activeId: 'sessions',
        collapsed,
      },
    },
  })

  /** 同一份现场,一边按瓦召唤、一边按它那格内容召唤。 */
  async function itemVsRef(id: string, seed: Partial<StageState>, focused = false) {
    const spy = vi.spyOn(focusTree, 'isOwnerActive').mockImplementation(
      (owner) => focused && (owner === id || owner === refId(panelRef(id))),
    )
    try {
      seedStage(seed)
      const itemEffects = await effectsOf(() => useStageStore.getState().summonItem(id))
      const byItem = snapshot()
      seedStage(seed)
      const refEffects = await effectsOf(() => void useStageStore.getState().summonRef(panelRef(id)))
      return { byItem, byRef: snapshot(), itemEffects, refEffects }
    } finally {
      spy.mockRestore()
    }
  }

  it('② 收着的架子:两个入口都展开、点名、闪一下,落在同一份状态上', async () => {
    const { byItem, byRef } = await itemVsRef('files', pinnedRight(true))
    expect(byItem).toBe(byRef)
    expect(useStageStore.getState().shelves.right.collapsed).toBe(false)
    expect(useStageStore.getState().shelves.right.activeId).toBe('files')
  })

  it('③ 看得见、焦点不在里面:两个入口都只送焦点,形态一个字不动', async () => {
    const seed = pinnedRight(false)
    const { byItem, byRef, itemEffects, refEffects } = await itemVsRef('files', seed, false)
    // 露脸的本来是 sessions,所以这一下是第二态(点名 + 落焦)。两条落在同一处。
    expect(byItem).toBe(byRef)
    /*
     * 效果那一层两条**都只有一句落焦**,而且都排在提交之后 —— 分叉正是在这里:
     * 从前瓦那条是同步的 `activateScope`、内容那条是 after-commit,
     * 而状态快照对这个差别一无所知。
     */
    expect(itemEffects.filter((e) => e.startsWith('focus('))).toHaveLength(1)
    expect(refEffects.filter((e) => e.startsWith('focus('))).toHaveLength(1)
  })

  it('④ 看得见、焦点在里面:两个入口都收整条架子', async () => {
    const { byItem, byRef, itemEffects, refEffects } = await itemVsRef('files', {
      shelves: {
        ...initialStageState.shelves,
        right: { ...initialStageState.shelves.right, tabs: ['files'], activeId: 'files', collapsed: false },
      },
    }, true)
    expect(byItem).toBe(byRef)
    expect(itemEffects).toEqual(['toggleShelfCollapsed(["right"])'])
    expect(refEffects).toEqual(['toggleShelfCollapsed(["right"])'])
  })
})

/**
 * **A9:全屏铺着时召唤别的瓦 —— 先退全屏,再照常召唤**(W7-p 裁定 6 的 A9;
 * 修一轮裁定 8 补的这一格覆盖)。
 *
 * 真机现场:全屏铺着,按 ⌘ 数字召唤另一块面,那块面开在全屏层**底下** ——
 * 屏幕上什么都没变、焦点也没进去,用户按了一下得到的是「没反应」。
 *
 * 这一组同时钉住裁定 2 的另一半:退全屏**把原住处放回**,而「放回」不需要动作 ——
 * 全屏期间树一个字没动,所以那条架子始终在。
 *
 * 反证:把 `store.summonItem` 里那句无条件的 `exitFullIfOpen()` 拆掉 → 第一条红
 * (全屏层还在);把 `placement.placeAs` 的 full 支里的 `detachItem` 加回去 →
 * 第二条红(退出后右架子空了)。
 */
describe('A9 全屏中召唤别的瓦', () => {
  it('先退全屏(原住处原样留着),那块瓦再按四态开出来', () => {
    seedStage({
      shelves: {
        ...initialStageState.shelves,
        right: { ...initialStageState.shelves.right, tabs: ['diff'], activeId: 'diff', collapsed: false },
      },
    })
    useWorkbenchStore.getState().enterFull(panelRef('diff'))
    expect(useWorkbenchStore.getState().full).not.toBeNull()

    summonStageItem('browser')

    expect(useWorkbenchStore.getState().full).toBeNull()
    // 裁定 2:全屏不摘树,所以 diff 的原住处(右架子)原样留着。
    expect(useStageStore.getState().shelves.right.tabs).toEqual(['diff'])
    expect(useStageStore.getState().memory.diff).toBeUndefined()
    /*
     * 被召唤的那块瓦按第一态开出来 —— 落点走 `resolveOpen` 的解析序,
     * `browser` 既没有记忆也没有出厂档,所以落在全局默认档(浮窗)。
     * 用它而不用 `files`:后者是**启动瓦**,`summonStageItem` 对它走的是另一支
     * (先问它代表哪格内容),那一支与 A9 要量的东西无关。
     */
    expect(useStageStore.getState().placements.browser?.kind).toBe('float')
  })

  it('召唤的正是**正在全屏**的那一块 —— 收起来(第四态在全屏这一形上的样子)', () => {
    seedStage({
      shelves: {
        ...initialStageState.shelves,
        right: { ...initialStageState.shelves.right, tabs: ['diff'], activeId: 'diff', collapsed: false },
      },
    })
    useWorkbenchStore.getState().enterFull(panelRef('diff'))
    summonStageItem('diff')
    expect(useWorkbenchStore.getState().full).toBeNull()
    // 退出即回原住处 —— 它从来没离开过。
    expect(useStageStore.getState().shelves.right.tabs).toEqual(['diff'])
  })
})

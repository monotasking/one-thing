import { beforeEach, describe, expect, it } from 'vitest'
import {
  normalizeHiddenShape,
  normalizeRegionShapes,
  useWorkbenchStore,
} from '../store'
import { contentKindList, registerContentKind } from '../kinds'
import { CENTER_REGION } from '../regions'

/**
 * **A1:重启不许丢布局**(W7-p 裁定 1,审计 A 的 A1 —— 真机上钉右 + 钉左 + 一扇
 * 浮窗,关窗再起,三处全没了)。
 *
 * ── 这只文件为什么**不 import `content/kinds`** ────────────────────────────
 * 那不是省事,那是**夹具本身**:病根就是「水合那一刻种类表还空着」。vitest 一个
 * 文件一份模块图,所以这只文件里的种类表天生是空的 —— 与 `main.tsx` 里
 * `import App`(闭包经过 workbench/store)排在 `import './content/kinds'` 之前
 * 的那一刻**逐字同构**。谁哪天在这里补一句 `import '../../content/kinds'`,
 * 这一组就再也证不了任何事情了。
 *
 * ── 两条,一条一个时刻 ──────────────────────────────────────────────────
 *  ① **水合**(persist 的 merge,种类表空):四条边与浮窗的区域**原样留下**;
 *  ② **`seed()`**(`startWorkbench()`,种类表已装好):这时才按种类清洗。
 */

const KEY = 'onething.workbench'
const doc = (key: string) => ({ kind: 'doc', key })
const alien = (key: string) => ({ kind: 'from-the-future', key })

/** 一份「用户摆好了家具」的档案:中央 + 右架子 + 一扇浮窗 + 一格隐藏。 */
function persisted(tabs: { kind: string; key: string }[] = [doc('a')]) {
  return JSON.stringify({
    version: 3,
    state: {
      byWorkspace: {
        default: {
          regions: {
            [CENTER_REGION]: { kind: 'leaf', id: 'L-center', tabs, active: 0 },
            'edge:right': { kind: 'leaf', id: 'L-right', tabs: [doc('r')], active: 0 },
            'edge:left': { kind: 'leaf', id: 'L-left', tabs: [doc('l')], active: 0 },
            'float:w1': { kind: 'leaf', id: 'L-float', tabs: [doc('f')], active: 0 },
          },
          hidden: [{ ref: doc('h'), returnTo: { region: CENTER_REGION, leafId: 'L-center', index: 0 } }],
          pairRatios: {},
          recentRoots: [],
        },
      },
    },
  })
}

beforeEach(() => {
  localStorage.clear()
})

describe('水合:种类表还空着的那一刻,只洗形状', () => {
  it('四条边与浮窗的区域原样留下,中央区那片叶连 id 都不换', async () => {
    // 前提本身是这只夹具的第一条断言:这里的种类表是空的(见文件头)。
    expect(contentKindList()).toEqual([])
    localStorage.setItem(KEY, persisted())
    await useWorkbenchStore.persist.rehydrate()
    const { regions } = useWorkbenchStore.getState()
    /*
     * 反证:把 merge 里那两句换回 `normalizeRegions` / `normalizeHidden`
     * (它们第一句就是拿 `isKnownContentKind` 去筛)→ 这四条全红,
     * 中央区塌成一片 `nextLeafId()` 的新叶(真机上随后 partialize 回写,
     * 用户摆了半年的家具当场被这份塌过的覆盖)。
     */
    expect(regions['edge:right']).toEqual({ kind: 'leaf', id: 'L-right', tabs: [doc('r')], active: 0 })
    expect(regions['edge:left']).toEqual({ kind: 'leaf', id: 'L-left', tabs: [doc('l')], active: 0 })
    expect(regions['float:w1']).toEqual({ kind: 'leaf', id: 'L-float', tabs: [doc('f')], active: 0 })
    expect(regions[CENTER_REGION]).toEqual({ kind: 'leaf', id: 'L-center', tabs: [doc('a')], active: 0 })
  })

  it('隐藏表同理:形状对就留着,不问种类', async () => {
    localStorage.setItem(KEY, persisted())
    await useWorkbenchStore.persist.rehydrate()
    expect(useWorkbenchStore.getState().hidden.map((h) => h.ref)).toEqual([doc('h')])
  })

  it('结构级那一遍确实不认识种类:一格来自未来的标签也留着', () => {
    const out = normalizeRegionShapes({
      [CENTER_REGION]: { kind: 'leaf', id: 'L1', tabs: [alien('x')], active: 0 },
    })
    expect(out[CENTER_REGION]).toEqual({ kind: 'leaf', id: 'L1', tabs: [alien('x')], active: 0 })
    expect(normalizeHiddenShape([{ ref: alien('x'), returnTo: { region: CENTER_REGION, leafId: 'L1', index: 0 } }]))
      .toHaveLength(1)
  })

  it('中央区永远在 —— 那是结构,不是种类', () => {
    expect(normalizeRegionShapes({})[CENTER_REGION]).toBeTruthy()
  })
})

describe('seed():种类表装好之后才按种类清洗', () => {
  it('登记过的留下、真认不得的剔掉 —— 而且那一遍在这一刻才发生', async () => {
    localStorage.setItem(KEY, persisted([doc('a'), alien('x')]))
    await useWorkbenchStore.persist.rehydrate()
    // 水合那一遍两格都在(它不问种类)。
    expect(useWorkbenchStore.getState().regions[CENTER_REGION]).toMatchObject({
      tabs: [doc('a'), alien('x')],
    })
    registerContentKind({
      id: 'doc',
      singleton: false,
      title: () => ({ text: 'doc' }),
      icon: () => 'File',
      render: () => null,
    })
    useWorkbenchStore.getState().seed()
    const center = useWorkbenchStore.getState().regions[CENTER_REGION]
    expect(center).toMatchObject({ tabs: [doc('a')] })
  })
})

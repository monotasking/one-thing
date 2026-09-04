import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  contentKindList,
  contentKindOf,
  isKnownContentKind,
  isSingletonContentKind,
  refId,
} from './kinds'
import { nextLeafId, nextSplitId } from './ids'
import { CENTER_REGION } from './regions'
import * as T from './tree'
import {
  spreadSpace,
  stashSpace,
  type PerSpaceSpec,
  type PerSpaceState,
} from '../workspace/per-space'
import type { ContentRef, ContentRefId } from './kinds'
import type { RegionId } from './regions'
import type { PaneLeafNode, PaneLocation, PaneNode } from './tree'

/**
 * **拼贴台的账**(设计 `apps/desktop-react/docs/workbench-2026-09.md` §1.3 / §2.3)。
 *
 * ── 它为什么另开一个持久化槽,而不是并进 `onething.stage` ────────────────
 * 两条判例摆在那儿(裁定原文):stage 那一槽有**换装次序**(per-space 的收 / 摊)
 * 与「迁移会被在飞实例的写盘绕过」两个坑,再往里塞一棵树等于把两件事的失败面
 * 焊在一起。所以 `onething.workbench` 自己一个 version、自己的 merge、
 * 自己在 merge 里跑一遍幂等的 `sanitize`(存量档案里的未知种类当场剔掉)。
 *
 * ── 这只文件里一个内容种类名都没有 ──────────────────────────────────────
 * 出厂布局不是写死的「中央区第一片叶装聊天」,而是**问表**:哪一种自述了
 * `resident: { region, key }`,就在那个区域里摆一格(`seedResidents`)。
 * 「最后一片不可关」同理:问的是「这个区域里这一种还剩几个」。
 * 于是加一种内容 = 它自己的模块 + 一行登记,这只文件一个字不改。
 *
 * ── 播种为什么是一句显式的 `startWorkbench()`,不是模块作用域里的副作用 ──
 * 播种要读种类表,而种类表由 `content/kinds` 那个 barrel 填 —— 那个 barrel 的
 * import 闭包会经过 `content/index.tsx` → `content/FilesPanel` → **这只 store**。
 * 在模块作用域里去够它就是一条现成的 import 环(`workspace/layout-scope.ts`
 * 文件头记着同一种病的真机现场:启动即 TDZ 崩溃)。所以照那条判例:模块只导出
 * 规格与动作,接线由 `main.tsx` 在 `import './content/kinds'` **之后**显式做一次。
 *
 * ── 面板内那一档为什么不在树里 ──────────────────────────────────────────
 * 设计 §2.1 明写:「**面板内**保留:它是 `FilesPanel` 自己那条分栏,不进树,
 * 语义不变」。所以 `panelPath` 是这里的一格**瞬态**字段(不落盘、不进家具账):
 * 它是「此刻分栏里在看哪个文件」,与「用户摆好的家具」不是一件事。
 */

/** 打开着但不显示的一格,记着它该回哪儿(设计 §2.3)。 */
export interface HiddenEntry {
  ref: ContentRef
  returnTo: PaneLocation
}

/** 跟着工作区走的那一份(T0 拍点 3:树按 Workspace 记)。 */
export interface WorkbenchFurniture {
  /**
   * 每个区域一棵树。W1-a 只点亮 `center` 一格;**W4 起四条边与每一扇浮窗也各一棵**
   * (`edge:<side>` / `float:<id>`,见 `./regions.ts`)。于是「一条架子上有什么」
   * 与「一扇浮窗里有什么」在这里是**唯一**的事实,形态机那边的 `placements` /
   * `shelves[side].tabs` 降格成它的投影(产地在 `stage/residency.ts`)。
   */
  regions: Record<string, PaneNode>
  hidden: HiddenEntry[]
}

export interface WorkbenchState extends PerSpaceState<WorkbenchFurniture> {
  regions: Record<string, PaneNode>
  hidden: HiddenEntry[]
  /**
   * 焦点叶 —— 「新标签开在哪一片」的答案。**瞬态**(不落盘):它是「此刻在哪」,
   * 不是「摆好的东西」,与 stage 摘掉舞台那条 placement 同一条判据。
   */
  focusLeafId: string | null
  /** 文件面板那条分栏此刻在看哪个文件。**不在树里**(见文件头)。瞬态。 */
  panelPath: string | null

  /** 出厂播种 + 洗一遍存量。幂等,由 `startWorkbench()` 调。 */
  seed(): void
  /**
   * 打开一块内容。`preview` = 预览 tab(单击那条路,§2.1 拍点 ①);
   * 缺省固定。已经开着的话只激活并把焦点叶指过去 —— 不重复插。
   */
  openRef(ref: ContentRef, opts?: { region?: RegionId; leafId?: string; preview?: boolean }): void
  activateTab(leafId: string, index: number): void
  /** 「保留」:把预览 tab 固定下来。 */
  pinTab(leafId: string, index: number): void
  /**
   * 关掉一格(**不问 `beforeClose`** —— 那一问是界面那一层的事,见 `PaneLeaf`)。
   * 关不掉(常驻那一种的最后一格)时什么都不做。
   */
  closeTab(leafId: string, index: number): void
  /** 藏起来一格:从叶里摘掉、记 `returnTo`,实例留着。 */
  hideTab(leafId: string, index: number): void
  /**
   * **把一格搬到另一个区域**(W4)。从它此刻在的那棵树里摘掉,插进目标区域;
   * 目标区域还没有树就当场建一棵单叶的。**实例一路留着** —— 搬家不是关闭,
   * 所以既不问 `beforeClose` 也不 `dispose`(判据与 `hideTab` 同一条)。
   *
   * `at` 是**叶内下标**(位置记忆放回原位那一路要它);缺席 = 排到末尾。
   */
  moveRef(ref: ContentRef, region: RegionId, opts?: { at?: number }): void
  /**
   * **把一格从所有树里摘掉,什么都不留**(W4)。既不记隐藏也不 dispose ——
   * 它是「收回 Dock」那条路的树侧动作:瓦的家在 Dock 上,离开树就是回家了,
   * 它的位置由**位置记忆**(`stage`)接着记,不需要隐藏表再记一遍。
   */
  detachRef(id: ContentRefId): void
  /**
   * **把一个区域里的每一格都藏起来**(W4;浮窗那颗 ✕ 走的就是它,设计 §2.2:
   * 「浮窗 ✕ = 把里面的 tab 全部**隐藏**,不是关闭 —— 窗子没了,内容还在」)。
   * 每一格各记自己的 `returnTo`,所以「隐藏的标签 ⋯」里点回来的是原来那个位置。
   */
  hideRegion(region: RegionId): void
  /** 从隐藏表里请回来。回不去(那片叶没了)就落在焦点叶上。 */
  restoreHidden(id: ContentRefId): void
  /** 把一格隐藏的真的关掉(叶檐「隐藏的标签 ⋯」里那颗 ✕)。 */
  dropHidden(id: ContentRefId): void
  /** 分屏:把这片叶切成两片。`ref` 缺席 = 把活动 tab 拉到新的那一片去。 */
  splitLeaf(leafId: string, dir: 'row' | 'col', ref?: ContentRef, before?: boolean): void
  setSplitRatio(splitId: string, ratio: number): void
  setFocusLeaf(leafId: string): void
  openInPanel(path: string): void
  closePanel(): void
  /** 只给测试:用例之间归零。 */
  reset(): void
}

/** 出厂:一棵空的中央树。播种(`seed`)会把常驻那些摆进去。 */
function factoryFurniture(): WorkbenchFurniture {
  return { regions: { [CENTER_REGION]: T.makeLeaf(nextLeafId()) }, hidden: [] }
}

export const WORKBENCH_PER_SPACE: PerSpaceSpec<WorkbenchState, WorkbenchFurniture> = {
  pick: (s) => ({ regions: s.regions, hidden: s.hidden }),
  factory: factoryFurniture,
}

/* ── 纯函数半边:每一条判据都可以脱开 React 测 ─────────────────────────── */

const SANITIZE_OPTIONS: T.SanitizeOptions = {
  known: isKnownContentKind,
  singleton: isSingletonContentKind,
}

/**
 * 洗一棵树 + 播种常驻的那些。**幂等**,merge / 换装 / `startWorkbench` 三处共用。
 *
 * 播种是**问表**不是写死:哪一种自述了 `resident`,就在那个区域里补一格
 * (已经有了就不补)。核心层因此不认识任何一种内容。
 */
export function normalizeRegions(regions: Record<string, PaneNode>): Record<string, PaneNode> {
  const out: Record<string, PaneNode> = {}
  for (const [region, tree] of Object.entries(regions ?? {})) {
    const clean = T.sanitize(tree, SANITIZE_OPTIONS)
    if (clean) out[region] = clean
  }
  for (const kind of contentKindList()) {
    const resident = kind.resident
    if (!resident) continue
    const ref: ContentRef = { kind: kind.id, key: resident.key }
    const tree = out[resident.region]
    if (tree && T.locateRef(tree, resident.region, refId(ref))) continue
    if (!tree) {
      out[resident.region] = T.makeLeaf(nextLeafId(), [ref], 0, null)
      continue
    }
    // 常驻那一格补在**第一片叶的最前面**:它是这个区域的家,不是后来加的一格。
    const first = T.leavesOf(tree)[0]
    out[resident.region] = first
      ? T.insertTab(tree, first.id, ref, { at: 0, activate: first.tabs.length === 0 })
      : T.makeLeaf(nextLeafId(), [ref], 0, null)
  }
  // 中央区永远在(设计 §1.3)。
  if (!out[CENTER_REGION]) out[CENTER_REGION] = T.makeLeaf(nextLeafId())
  return out
}

/** 洗一遍隐藏表:未知种类剔掉、重复的只留第一条。 */
export function normalizeHidden(hidden: HiddenEntry[]): HiddenEntry[] {
  const seen = new Set<ContentRefId>()
  const out: HiddenEntry[] = []
  for (const entry of hidden ?? []) {
    if (!entry?.ref || typeof entry.ref.kind !== 'string' || typeof entry.ref.key !== 'string') continue
    if (!isKnownContentKind(entry.ref.kind)) continue
    const id = refId(entry.ref)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(entry)
  }
  return out
}

/**
 * 这一格关得掉 / 藏得掉吗。**判据问的是种类的自述**,不是种类的名字
 * (T0 拍点 2 的落地,理由写在 `ContentKind.resident` 上)。
 */
export function canDetachTab(tree: PaneNode, leafId: string, index: number): boolean {
  const leaf = T.findLeaf(tree, leafId)
  const ref = leaf?.tabs[index]
  if (!ref) return false
  if (!contentKindOf(ref.kind)?.resident) return true
  return T.countKind(tree, ref.kind) > 1
}

/** 焦点叶:指名的那一片还在就用它,否则用这个区域的第一片。 */
export function focusLeafOf(tree: PaneNode, focusLeafId: string | null): PaneLeafNode {
  const named = focusLeafId ? T.findLeaf(tree, focusLeafId) : null
  return named ?? T.leavesOf(tree)[0] ?? T.makeLeaf(nextLeafId())
}

/** 这片叶住在哪个区域。答不出 = 这个 id 不在任何一棵树上。 */
export function regionOfLeafIn(
  regions: Record<string, PaneNode>,
  leafId: string,
): RegionId | null {
  for (const [region, tree] of Object.entries(regions)) {
    if (T.findLeaf(tree, leafId)) return region as RegionId
  }
  return null
}

/** 这个 refId 此刻在哪个区域(哪棵树都不在 = null)。 */
export function regionOfRefIn(
  regions: Record<string, PaneNode>,
  id: ContentRefId,
): RegionId | null {
  for (const [region, tree] of Object.entries(regions)) {
    if (T.locateRef(tree, region as RegionId, id)) return region as RegionId
  }
  return null
}

/**
 * **这个区域里藏着的那些**(W4;叶檐那格「隐藏的标签 ⋯」只列本区域的)。
 *
 * W1-a 留的账正是这一条:那格菜单当时列的是**全部**隐藏项,于是右架子的檐上
 * 会列出中央区藏起来的文件 —— 点回去,它出现在你看不见的另一块地方。
 * 「回哪儿去」这件事本来就记在 `returnTo.region` 上,按它分组是它自己的读法。
 */
export function hiddenInRegion(
  hidden: readonly HiddenEntry[],
  region: RegionId | null,
): HiddenEntry[] {
  if (!region) return []
  return hidden.filter((entry) => entry.returnTo.region === region)
}

/**
 * 一条路径此刻的**三态**(设计 §2.3:实心 = 显示中,空心 = 隐藏,无 = 没开)。
 * 文件树行那颗点的**唯一产地** —— 渲染层不再自己判一次。
 */
export function openStateOf(
  state: Pick<WorkbenchState, 'regions' | 'hidden' | 'panelPath'>,
  ref: ContentRef,
): 'shown' | 'hidden' | null {
  const id = refId(ref)
  for (const [region, tree] of Object.entries(state.regions)) {
    if (T.locateRef(tree, region as RegionId, id)) return 'shown'
  }
  if (state.panelPath !== null && refId({ kind: ref.kind, key: state.panelPath }) === id) return 'shown'
  if (state.hidden.some((entry) => refId(entry.ref) === id)) return 'hidden'
  return null
}

/* ── store ────────────────────────────────────────────────────────────── */

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set, get) => {
      /** 改一个区域的树。剪空了就重新播种(中央区永远至少有一片叶)。 */
      const writeRegion = (region: RegionId, next: PaneNode | null): void => {
        set((s) => {
          const pruned = next ? T.prune(next) : null
          const regions = { ...s.regions }
          if (pruned) regions[region] = pruned
          else delete regions[region]
          return { regions: normalizeRegions(regions) }
        })
      }

      return {
        ...factoryFurniture(),
        byWorkspace: {},
        focusLeafId: null,
        panelPath: null,

        seed: () =>
          set((s) => ({ regions: normalizeRegions(s.regions), hidden: normalizeHidden(s.hidden) })),

        openRef: (ref, opts = {}) => {
          const region = opts.region ?? CENTER_REGION
          const s = get()
          /*
           * **区域还没有树就当场建一棵**(W4)。W1-a 时这里是 `if (!tree) return`
           * —— 那时只有中央区那一棵,而它出厂就在。W4 起边与浮窗也是区域,而
           * 「这条边此刻空着」正是最常见的一种情况:第一格插进去的同时把树建起来,
           * 空区域于是不必先有一个「空树」占着(空树会让架子画出一条空带子)。
           */
          const tree = s.regions[region] ?? T.makeLeaf(nextLeafId())
          const kind = contentKindOf(ref.kind)
          if (kind?.regions && !kind.regions.includes(region)) return
          const id = refId(ref)
          // 单例已经开着 = 激活它,不再插一格(单例的定义就是全应用一份)。
          const at = kind?.singleton ? T.locateRef(tree, region, id) : null
          if (at) {
            set({ regions: { ...s.regions, [region]: T.activate(tree, at.leafId, at.index) }, focusLeafId: at.leafId })
            return
          }
          /*
           * **单例住在别的区域**(W4 起才可能:边与浮窗也是区域了)。
           * 「全应用一份」这句话是跨区域的 —— 不先摘掉,一块瓦就会在右架子和
           * 一扇浮窗里各活一份,而它们背后是同一个实例。
           */
          const elsewhere = kind?.singleton ? regionOfRefIn(s.regions, id) : null
          const regions = elsewhere && elsewhere !== region
            ? withoutRef(s.regions, id)
            : s.regions
          const base = regions[region] ?? tree
          // 藏着的那一份被重新打开 = 请回来(实例还在,草稿与滚动位不该丢)。
          const hidden = s.hidden.filter((entry) => refId(entry.ref) !== id)
          const leaf = opts.leafId ? T.findLeaf(base, opts.leafId) : focusLeafOf(base, s.focusLeafId)
          if (!leaf) return
          set({
            regions: { ...regions, [region]: T.insertTab(base, leaf.id, ref, { preview: opts.preview === true }) },
            hidden: hidden.length === s.hidden.length ? s.hidden : hidden,
            focusLeafId: leaf.id,
          })
        },

        moveRef: (ref, region, opts = {}) => {
          const s = get()
          const id = refId(ref)
          const kind = contentKindOf(ref.kind)
          if (kind?.regions && !kind.regions.includes(region)) return
          const regions = withoutRef(s.regions, id)
          const tree = regions[region] ?? T.makeLeaf(nextLeafId())
          const leaf = focusLeafOf(tree, null)
          set({
            regions: { ...regions, [region]: T.insertTab(tree, leaf.id, ref, { at: opts.at }) },
            // 藏着的那一份被搬出来 = 它不再是「藏着的」(实例一路留着)。
            hidden: s.hidden.filter((entry) => refId(entry.ref) !== id),
            focusLeafId: leaf.id,
          })
        },

        detachRef: (id) => {
          const s = get()
          if (!regionOfRefIn(s.regions, id)) return
          set({ regions: withoutRef(s.regions, id) })
        },

        hideRegion: (region) => {
          const s = get()
          const tree = s.regions[region]
          if (!tree) return
          /*
           * **先按原状把每一格的位置折下来,再一次性摘掉**。次序即语义:
           * 逐格摘会让后面那些的下标一路往前塌,记下的就是塌过的位置 ——
           * 藏起来再一个个请回来,三格会挤成一摞(与 `closeShelf` 那条判例同型)。
           */
          const entries: HiddenEntry[] = []
          for (const leaf of T.leavesOf(tree)) {
            leaf.tabs.forEach((ref, index) => {
              entries.push({ ref, returnTo: { region, leafId: leaf.id, index } })
            })
          }
          if (entries.length === 0) return
          const fresh = new Set(entries.map((entry) => refId(entry.ref)))
          const regions = { ...s.regions }
          delete regions[region]
          set({
            hidden: [...s.hidden.filter((entry) => !fresh.has(refId(entry.ref))), ...entries],
            regions: pruneRegions(regions),
          })
        },

        activateTab: (leafId, index) =>
          set((s) => {
            const region = regionOfLeaf(s.regions, leafId)
            if (!region) return s
            return {
              regions: { ...s.regions, [region]: T.activate(s.regions[region], leafId, index) },
              focusLeafId: leafId,
            }
          }),

        pinTab: (leafId, index) =>
          set((s) => {
            const region = regionOfLeaf(s.regions, leafId)
            if (!region) return s
            return { regions: { ...s.regions, [region]: T.pinTab(s.regions[region], leafId, index) } }
          }),

        closeTab: (leafId, index) => {
          const s = get()
          const region = regionOfLeaf(s.regions, leafId)
          if (!region) return
          const tree = s.regions[region]
          if (!canDetachTab(tree, leafId, index)) return
          const ref = T.findLeaf(tree, leafId)?.tabs[index]
          writeRegion(region, T.removeTab(tree, leafId, index))
          // **关掉 = 丢实例**(隐藏不丢)。种类自己清它自己的状态。
          if (ref) contentKindOf(ref.kind)?.dispose?.(ref)
        },

        hideTab: (leafId, index) => {
          const s = get()
          const region = regionOfLeaf(s.regions, leafId)
          if (!region) return
          const tree = s.regions[region]
          if (!canDetachTab(tree, leafId, index)) return
          const ref = T.findLeaf(tree, leafId)?.tabs[index]
          if (!ref) return
          const id = refId(ref)
          set({
            hidden: [
              ...s.hidden.filter((entry) => refId(entry.ref) !== id),
              { ref, returnTo: { region, leafId, index } },
            ],
          })
          writeRegion(region, T.removeTab(tree, leafId, index))
        },

        restoreHidden: (id) => {
          const s = get()
          const entry = s.hidden.find((row) => refId(row.ref) === id)
          if (!entry) return
          const region = entry.returnTo.region
          /*
           * **区域没了就把它建回来**(W4)。W1-a 时这里回落中央区,理由是那时
           * 只有中央区一棵树 —— 别的区域根本不存在。W4 之后「区域没了」恰恰是
           * 最常见的一种回程:关一扇浮窗 = 把里面的标签全藏起来,那扇窗当场
           * 就没了(树空了整格删掉)。回落中央区等于「点『隐藏的标签 ⋯』里那一行,
           * 它出现在另一块地方」——而 `returnTo.region` 记的就是它该回哪儿。
           *
           * 浮窗那一路白拿几何:`floats[id]` 那张矩形表从来不擦(它是记忆),
           * 所以窗建回来还在老位置;`floatOrder` 由投影自己补上末位。
           */
          const tree = s.regions[region] ?? T.makeLeaf(nextLeafId())
          // 回原来那片叶;那片叶已经没了就落在这个区域的焦点叶上(结构归还同一条口径)。
          const leaf = T.findLeaf(tree, entry.returnTo.leafId) ?? focusLeafOf(tree, s.focusLeafId)
          set({
            hidden: s.hidden.filter((row) => refId(row.ref) !== id),
            regions: {
              ...s.regions,
              [region]: T.insertTab(tree, leaf.id, entry.ref, { at: entry.returnTo.index }),
            },
            focusLeafId: leaf.id,
          })
        },

        dropHidden: (id) => {
          const s = get()
          const entry = s.hidden.find((row) => refId(row.ref) === id)
          if (!entry) return
          set({ hidden: s.hidden.filter((row) => refId(row.ref) !== id) })
          contentKindOf(entry.ref.kind)?.dispose?.(entry.ref)
        },

        splitLeaf: (leafId, dir, ref, before) => {
          const s = get()
          const region = regionOfLeaf(s.regions, leafId)
          if (!region) return
          const fresh = nextLeafId()
          const next = T.splitLeaf(
            s.regions[region],
            leafId,
            dir,
            fresh,
            nextSplitId(),
            ref ?? null,
            { before },
          )
          if (next === s.regions[region]) return
          set({ regions: { ...s.regions, [region]: next }, focusLeafId: fresh })
        },

        setSplitRatio: (splitId, ratio) =>
          set((s) => {
            for (const [region, tree] of Object.entries(s.regions)) {
              const next = T.setRatio(tree, splitId, ratio)
              if (next !== tree) return { regions: { ...s.regions, [region]: next } }
            }
            return s
          }),

        setFocusLeaf: (leafId) =>
          set((s) => (s.focusLeafId === leafId ? s : { focusLeafId: leafId })),

        openInPanel: (path) => set({ panelPath: path }),
        closePanel: () => set({ panelPath: null }),

        reset: () =>
          set({ ...factoryFurniture(), byWorkspace: {}, focusLeafId: null, panelPath: null }),
      }
    },
    {
      name: 'onething.workbench',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      /*
       * merge 是**同步**的、发生在 store 建出来那一刻,所以第一帧画的就是这个空间
       * 的布局(理由与 stage 的 merge 逐字相同)。这里额外跑一遍 `sanitize` ——
       * 迁移可以被在飞实例的写盘绕过(旧值配新版本号落盘,migrate 不再跑),
       * 而 merge 每次都跑,所以「洗干净」这件事只能挂在这里。
       *
       * 此刻种类表可能还是空的(播种要等 `startWorkbench()`),所以这一遍洗的
       * 结果只是「形状合法」;`sanitize` 幂等,第二遍在播种时补上剔除与去重。
       */
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<WorkbenchState>
        const merged: WorkbenchState = { ...current, ...saved }
        merged.byWorkspace = (merged.byWorkspace ?? {}) as WorkbenchState['byWorkspace']
        Object.assign(merged, spreadSpace(merged.byWorkspace, WORKBENCH_PER_SPACE))
        merged.regions = normalizeRegions(merged.regions ?? {})
        merged.hidden = normalizeHidden(merged.hidden ?? [])
        // 瞬态那三格永远从零开始(它们不落盘,但 merge 收到的 current 里有)。
        merged.focusLeafId = null
        merged.panelPath = null
        return merged
      },
      partialize: (s) => ({ byWorkspace: stashSpace(s, s.byWorkspace, WORKBENCH_PER_SPACE) }),
    },
  ),
)

/** 这片叶住在哪个区域。 */
const regionOfLeaf = regionOfLeafIn

/**
 * 剪一遍每棵树:空叶剪掉、空区域整格删掉,中央区**永远留一棵**(设计 §1.3)。
 *
 * 它与 `normalizeRegions` 的分工是一句话:**这只不问种类表**。搬家 / 摘掉 / 整区
 * 隐藏这三条路只动结构,而 `sanitize` 要读种类注册表 —— 在还没 `import
 * './content/kinds'` 的宿主(用例)里,那一遍会把每一格都当未知种类剔掉。
 * 洗存量档案是入口那一次的事(merge / seed),不是每一次动作的事。
 */
function pruneRegions(regions: Record<string, PaneNode>): Record<string, PaneNode> {
  const out: Record<string, PaneNode> = {}
  for (const [region, tree] of Object.entries(regions)) {
    const pruned = T.prune(tree)
    if (pruned) out[region] = pruned
  }
  if (!out[CENTER_REGION]) out[CENTER_REGION] = T.makeLeaf(nextLeafId())
  return out
}

/** 把一个 refId 从**每一棵**树里摘掉,然后剪一遍。 */
function withoutRef(
  regions: Record<string, PaneNode>,
  id: ContentRefId,
): Record<string, PaneNode> {
  const next: Record<string, PaneNode> = {}
  for (const [region, tree] of Object.entries(regions)) {
    let cleaned = tree
    for (const leaf of T.leavesOf(tree)) {
      const at = leaf.tabs.findIndex((tab) => refId(tab) === id)
      if (at >= 0) cleaned = T.removeTab(cleaned, leaf.id, at)
    }
    next[region] = cleaned
  }
  return pruneRegions(next)
}

/**
 * 播种 + 洗一遍。**由 `main.tsx` 在 `import './content/kinds'` 之后调一次**
 * (理由见文件头:模块作用域里去够种类表是一条现成的 import 环)。幂等。
 */
export function startWorkbench(): void {
  useWorkbenchStore.getState().seed()
}

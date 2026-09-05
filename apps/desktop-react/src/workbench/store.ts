import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  composeContent,
  contentKindList,
  contentKindOf,
  flattenContent,
  isCompositeContent,
  isKnownContentKind,
  isSingletonContentKind,
  partsOfContent,
  refId,
  sameRef,
} from './kinds'
import { nextLeafId, nextSplitId } from './ids'
import { foldRegionsInPersisted, rewriteRefsInPersisted } from './persist-migrate'
import { CENTER_REGION } from './regions'
/*
 * **这一句是这只文件里唯一一条指向内容层的边,而且它一个种类名都读不到**:
 * 翻译表住在内容层(`content/legacy-refs.ts` —— 种类名的地盘),走档案那一遍
 * 住在 `./persist-migrate.ts`(它知道档案长什么形、却不知道种类)。两半合起来
 * 才是「存量档案里那一格 `chat:main` 怎么变成今天的会话叶」,而这里只是把它们
 * 接上。`content/legacy-refs.ts` 的 import 闭包只到 `content/session-ref.ts` →
 * `workbench/{kinds,tree,regions}`,一条环都不成。
 */
import { rewriteLegacyContentRef } from '../content/legacy-refs'
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
 * `resident: { region, seed() }`,就在那个区域里摆一格(key 由那一种现铸)。
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

/**
 * **真全屏那一格瞬态**(W2,设计 §1.3 / §4.1)。
 *
 * 「这一块内容铺满整扇窗口」。它**不是一种落点**:树一个字没动,那一格 tab 仍旧
 * 住在它原来那片叶里,全屏只是把它**投影**到最上面那一层(`components/FullLayer`)。
 * 所以退出是零成本的 —— 没有「搬回去」这回事,只是不再投影。
 *
 * `from` 是**这一次是从哪儿进来的**:
 *  · 那一格住在某棵树里(文件 / 钉在架子上的瓦…)→ 它当时的位置。退出即回原位,
 *    而「回原位」本身不需要动作:它从来没离开过。这一格是给**焦点归还**用的
 *    (退出时把键盘送回原叶原 tab),不是给搬家用的;
 *  · **哪棵树都不在** → `null`。今天唯一的产地是「打开方式 = 全屏」的那些瓦
 *    (`stage/placement.placeAs` 的 full 那一支先把它从每棵树里摘干净),
 *    于是退出全屏 = 它回到 Dock(投影缺席即 dock)。这一路 `FullLayer` 自己画内容
 *    ——没有任何一片叶持有它,判词写在那只组件上。
 */
export interface FullState {
  ref: ContentRef
  from: PaneLocation | null
}

/** `toggleFull` 这一下做了什么。UI 那一层据此决定要不要说话(拒绝那一档要出提示)。 */
export type ToggleFullResult = 'entered' | 'exited' | 'refused' | 'none'

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
  /**
   * **两格标签里那条分隔杆停在哪**(W6-a,设计 `workbench-tabs-2026-09.md` §6)。
   * 键 = 那一格复合内容的 refId,值 = 左格占的百分比(与 `ui/Splitter` 同一个
   * 量纲,不是 0–1 的小数)。
   *
   * 它是**家具**(用户摆出来的比例应该活过一次重启),但它不住在树上:树上那一格
   * 只是一个普通的 ref,而「这一格宽多少」是它自己的一件事。随家具落盘、随家具
   * 换空间;`sanitize` 那一遍把已经不在任何一棵树上的键清掉(不清的话,一个
   * 关掉又重开的两格标签会读到上一次的比例 —— 那反而是对的;真正要清的是
   * **再也不会回来**的那些,否则这张表只涨不落)。
   */
  pairRatios: Record<ContentRefId, number>
  /**
   * **最近打开过的目录**(W6-a,设计 §3)。绝对路径,**最近的在前**,最多 20 条。
   * 「目录」那块启动瓦的右键菜单读它;按工作区各持一份(与树同一条:一个空间
   * 里翻过哪些目录是这个空间的事)。
   */
  recentRoots: string[]
}

export interface WorkbenchState extends PerSpaceState<WorkbenchFurniture> {
  regions: Record<string, PaneNode>
  hidden: HiddenEntry[]
  pairRatios: Record<ContentRefId, number>
  recentRoots: string[]
  /**
   * 焦点叶 —— 「新标签开在哪一片」的答案。**瞬态**(不落盘):它是「此刻在哪」,
   * 不是「摆好的东西」,与 stage 摘掉舞台那条 placement 同一条判据。
   */
  focusLeafId: string | null
  /** 文件面板那条分栏此刻在看哪个文件。**不在树里**(见文件头)。瞬态。 */
  panelPath: string | null
  /**
   * **此刻正在拖**(W3 的两个坑之一)。瞬态,不落盘。
   *
   * 它是一道**闸**:拖拽的落点判据吃的是「起拖时量的那一份几何」(裁定 4),
   * 而几何只在树不变的前提下成立。拖拽期间用户自己动不了树(指针被 capture 住),
   * 但**异步**的那些动得了 —— 一份文件读完了要插一格 tab、一条会话切换了要
   * 换常驻格。那一格插进去,屏幕上的叶全部重排,而手上那份几何还是旧的:
   * 高亮画在 A,松手落在 B。
   *
   * 所以起拖时把改**树形**的那几口闸上(落定 / 取消解)。被闸掉的那一下就是
   * 真的没发生 —— 这是诚实的代价,写在这里而不是靠自觉:一次拖拽通常不到两秒,
   * 而「高亮说的和松手做的不是一件事」是不可接受的。
   */
  dragging: boolean
  /**
   * 铺满整扇窗的那一格(W2)。**瞬态**:不落盘、不进 per-space 的 `pick`、
   * 换空间清零(接线在 `workspace/layout-scope.ts`)。
   *
   * 它与 `focusLeafId` / `panelPath` 同一条判据 —— 它是「此刻在看什么」,
   * 不是「用户摆好的东西」。全屏跨重启不恢复是有意的:一台重开的机器该先给你
   * 看见它的全貌。
   */
  full: FullState | null

  /** 出厂播种 + 洗一遍存量。幂等,由 `startWorkbench()` 调。 */
  seed(): void
  /**
   * 打开一块内容。已经开着的话只激活并把焦点叶指过去 —— 不重复插。
   * (W6-a:`preview` 那一档退役,判词写在 `tree.insertTab` 上。)
   */
  openRef(ref: ContentRef, opts?: { region?: RegionId; leafId?: string }): void
  activateTab(leafId: string, index: number): void
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
  /**
   * 分屏:把这片叶切成两片。`ref` 缺席 = 把活动 tab 拉到新的那一片去。
   *
   * **中央区不受理**(W6-a 的单叶政策):那里一格标签最多两格,而那件事由
   * `pairRefs` 说 —— 一条 tab 条上再长出第二片叶正是这次要收掉的东西。
   * 架子与浮窗照旧(设计 §12:那两处的「分屏 ▸」不删)。
   */
  splitLeaf(leafId: string, dir: 'row' | 'col', ref?: ContentRef, before?: boolean): void
  setSplitRatio(splitId: string, ratio: number): void
  /**
   * **二合一**(W6-a,设计 §2.1 / §6):把 `ref` 并进 `leafId` 里第 `hostIndex`
   * 格的 `side` 侧,换出一格**复合内容**顶在原位。
   *
   * 签名钉死(W6-b 的拖拽落定要照这个形调):收的是**叶 + 下标 + ref + 哪一侧**,
   * 不收「哪两个 refId」—— 同一格内容可能在别处也开着,而这一下说的是
   * 「屏幕上这一格」。
   *
   * 四条判据,一条都不在这里点种类的名:
   *  · `ref` 与 host 是同一格 → 空动作(拖回自己身上不是一次并);
   *  · `ref` 自己就是复合的 → **拒绝**(设计 §6「不允许」:两格的标签不能再并);
   *  · host 已经是复合的 → 换掉那一侧,**被换下来的那一格落在它后面成为一格
   *    普通标签**(见下面实现处的判词);
   *  · 并不出来(`composeContent` 答 null)→ 什么都不做。
   *
   * `ref` 本来在别处开着 = **搬**,不是复制(不变量 1:一个内容在一个区域里
   * 只出现一次)。
   */
  pairRefs(leafId: string, hostIndex: number, ref: ContentRef, side: 'left' | 'right'): void
  /**
   * **拆开**(设计 §6):第 `index` 格若是复合的,右格拆成**紧邻其后**的一格
   * 新标签,左格留在原位,活动格仍旧停在原位那一格。
   * 不是复合的 = 空动作(引用恒等)。
   */
  unpairAt(leafId: string, index: number): void
  /** 两格标签里那条分隔杆落定。`ratio` = 左格占的百分比,钳在 20–80。 */
  setPairRatio(id: ContentRefId, ratio: number): void
  /** 记一条「最近打开过的目录」。已经在表上的提到最前;最多留 20 条。 */
  rememberRoot(path: string): void
  setFocusLeaf(leafId: string): void
  /** 起拖 / 落定:开合上面那道闸。 */
  setDragging(on: boolean): void
  /**
   * **把一格搬进指定的那一片叶**(W3 落定那条路)。
   *
   * 与 `moveRef` 的分工是一句话:那一只说的是「搬到哪个**区域**」(落在那个
   * 区域的焦点叶上),这一只说的是「搬到哪**一片叶**」—— 一个区域里可能有好
   * 几片(分屏之后),而拖拽的落点恰恰是「屏幕上这一块」。
   *
   * 摘干净再插,**一次 `set`**(同一事务):先 `removeTab` 再 `insertTab` 分两
   * 次写的话,中间那一拍屏幕上会少一格,而订阅者(顶栏标签组 / 焦点跟随)
   * 会把它读成「关掉了一格」。
   */
  moveRefIntoLeaf(ref: ContentRef, leafId: string, opts?: { at?: number }): void
  /**
   * **同一片叶里换个位子**(W3-b 裁定 4 的落定 + 裁定 8 的「左移 / 右移」;
   * W5-b 合树接缝 a 把它接上)。`from` / `to` 都是对着**换之前那张表**量的下标。
   *
   * ── 它为什么是一口新的口,而不是 `moveRefIntoLeaf` 的一种用法 ────────────
   * 因为「搬进这片叶」与「在这片叶里换位子」有一处**看得见**的分叉:
   * **预览那一格的身份**。W3-b 落地时 `workbench/store.ts` 正在并行批 W5-b 的
   * 改动面上,所以 `drop-commit.reorderTab` 借道 `moveRefIntoLeaf`(摘干净再插),
   * 而摘的那一下 `removeTab` 会把 `preview` 清成 null —— 换一格预览 tab 的位子
   * 等于**顺手把它固定下来**,那是用户没要过的一次「保留」。留账写在
   * `reorderTab` 的判词里,这一口就是那笔账的了结。
   *
   * 判据本体是纯函数 `tree.moveTab`(它自己收 splice 的下标偏移,并且把
   * `preview` 随那一格搬过去)。这里只负责**一次 `set`**:同叶换序不跨区域,
   * 所以不必再问 `kind.regions` —— 区域一个字都没变。
   */
  moveTab(leafId: string, from: number, to: number): void
  /**
   * **原位换一格 ref**(W5-b 裁定 1)。同一片叶、同一个下标、活动格不动 ——
   * 换的只是「这一格代表谁」。判据本体是纯函数 `tree.replaceRef`(判词在那儿)。
   *
   * 两个调用方,都是「这片叶换一条会话」的两种说法:列表里点一行(切换)、
   * 首开草稿态发出第一句话之后把 `session:new` 绑成真 id。两者都**不许**走
   * 「关一格再开一格」——那条路会把叶剪掉重建,整台聊天区连同兄弟叶一起重挂。
   *
   * 这一种自述了 `regions` 而目标区域不在里面时是空动作(与 `openRef` 同一句闸)。
   */
  replaceRef(leafId: string, from: ContentRef, to: ContentRef): void
  /**
   * **把「背后那个东西已经没了」的格子扫掉**(W5-b 裁定 5)。
   *
   * `alive(ref)` 由发起那一拍注入(会话列表首达 / `onSessionsRemoved`)——
   * 判词写在 `tree.SanitizeOptions.alive` 上:这一口问的是**这一个**,而
   * 那本账住在数据源那一侧,树自己答不出。
   *
   * 死格的下场分两档,判据仍旧是**种类自述**、不是核心层点名:
   *  · 它是常驻那一种在这个区域里的**最后一格** → 原位换成种类新播的那一格
   *    (`resident.seed()` —— 会话那一种会答保留键,因为死掉的那条不在名册上了);
   *  · 其余 → 整格摘掉(隐藏表里的那些同理)。
   *
   * 一格都没扫掉时**引用恒等**(不惊动任何订阅者)。
   */
  sweepRefs(alive: (ref: ContentRef) => boolean): void
  /**
   * **进全屏**(W2)。`from` 缺席读作「问树」—— 它此刻在哪棵树的哪一格,
   * 就记哪一格;哪棵树都不在就是 `null`(那一路由 `FullLayer` 自己画)。
   *
   * 这一种自述 `fullable: false`(今天只有 chat)时是**空动作**:拒绝那一句话
   * 由 `toggleFull` 说,因为只有它是用户按键的落点 —— 而这一口还有别的调用方
   * (Dock 的「打开方式 = 全屏」),对它们「静默不做」才是对的。
   */
  enterFull(ref: ContentRef, from?: PaneLocation | null): void
  /** 退全屏。没开着是空动作(引用恒等,不惊动订阅者)。 */
  exitFull(): void
  /**
   * **正铺着全屏就收起来**(W2×W3 合树接缝 b)。答「刚才真收了没有」。
   *
   * 它是「收全屏」这句话的**唯一产地**:三处调用方各有各的判据,但收这个动作
   * 只此一份 —— Dock 上再点一下那块正铺满的瓦(`stage/store.clickDockIcon`)、
   * 召唤四态的第四格(`summonItem`),以及**拖拽落定**(`drop-commit.dropRef`)。
   * 前两处先问「是不是这一块」再收(那是 toggle);落定不问是哪一块 —— 树在
   * 全屏底下变了形,再让那层盖着就是「用户看不见自己刚做的事」。
   */
  exitFullIfOpen(): boolean
  /**
   * ⌘⇧↩ 的落点:**焦点叶的活动 tab** 进 / 出全屏。
   * 已经开着 = 退出(同一个键再按一次收回去);那一格不许全屏 = `'refused'`。
   */
  toggleFull(): ToggleFullResult
  openInPanel(path: string): void
  closePanel(): void
  /** 只给测试:用例之间归零。 */
  reset(): void
}

/** 出厂:一棵空的中央树。播种(`seed`)会把常驻那些摆进去。 */
function factoryFurniture(): WorkbenchFurniture {
  return {
    regions: { [CENTER_REGION]: T.makeLeaf(nextLeafId()) },
    hidden: [],
    pairRatios: {},
    recentRoots: [],
  }
}

export const WORKBENCH_PER_SPACE: PerSpaceSpec<WorkbenchState, WorkbenchFurniture> = {
  pick: (s) => ({
    regions: s.regions,
    hidden: s.hidden,
    pairRatios: s.pairRatios,
    recentRoots: s.recentRoots,
  }),
  factory: factoryFurniture,
}

/**
 * **单叶政策**(W6-a,设计 §2.1):这些区域里的树永远只有一片叶。
 *
 * 今天只有中央区。架子与浮窗**不在表上** —— 设计 §12 明写那两处仍可经右键
 * 「分屏 ▸」得到多叶(W4 的能力不删)。它是一张表而不是一句 `=== CENTER_REGION`,
 * 是因为「哪些区域收成一条标签条」是一件会变的**政策**,而它只该有一个产地:
 * 运行期那一遍(`normalizeRegions`)与存量档案那一遍(persist v3)读同一张表。
 */
export const SINGLE_LEAF_REGIONS: readonly string[] = [CENTER_REGION]

/** 两格标签那条分隔杆的量纲与钳制(与 `ui/Splitter` 的 value 同一个:百分比)。 */
export const PAIR_RATIO_DEFAULT = 50
export const PAIR_RATIO_MIN = 20
export const PAIR_RATIO_MAX = 80

/** 最近目录表留多少条(设计 §3)。 */
export const RECENT_ROOTS_MAX = 20

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
    if (clean) out[region] = foldIfSingleLeafRegion(region, clean)
  }
  for (const kind of contentKindList()) {
    const resident = kind.resident
    if (!resident) continue
    /*
     * **key 由那一种自己现铸**(W5-b 裁定 2)。W1 这里读的是一格死的
     * `resident.key`;会话多开之后「出厂那一片摆哪条会话」只有那一种答得出,
     * 而且答案随时刻变(冷启动 = 保留键,换空间 = 那个空间的当前会话)。
     * 核心层照旧不知道这个字符串是什么 —— 它只是把答案放进树。
     */
    const tree = out[resident.region]
    /*
     * 「已经有了」问的是**这个区域里还有没有同种的**,不是「有没有这一个」
     * (W5-b:`key` 不再是死的 `main`,同一种的两格 key 各不相同)。判据与
     * `canDetachTab` 那句「关掉之后这个区域里还剩不剩同种的」逐字同源 ——
     * 少了这一条,一棵已经装着 `session:abc` 的树会在每次播种时再补一格
     * `session:new` 进去。
     */
    if (tree && countKindDeep(tree, kind.id) > 0) continue
    const ref: ContentRef = { kind: kind.id, key: resident.seed() }
    if (!tree) {
      out[resident.region] = T.makeLeaf(nextLeafId(), [ref], 0)
      continue
    }
    // 常驻那一格补在**第一片叶的最前面**:它是这个区域的家,不是后来加的一格。
    const first = T.leavesOf(tree)[0]
    out[resident.region] = first
      ? T.insertTab(tree, first.id, ref, { at: 0, activate: first.tabs.length === 0 })
      : T.makeLeaf(nextLeafId(), [ref], 0)
  }
  // 中央区永远在(设计 §1.3)。
  if (!out[CENTER_REGION]) out[CENTER_REGION] = T.makeLeaf(nextLeafId())
  return out
}

/**
 * 单叶政策那一句(见 `SINGLE_LEAF_REGIONS`)。不在表上的区域原样交回,
 * 已经是一片叶的也原样交回(引用恒等 —— 这一句每次 normalize 都会跑)。
 */
function foldIfSingleLeafRegion(region: string, tree: PaneNode): PaneNode {
  return SINGLE_LEAF_REGIONS.includes(region) ? T.foldLeaves(tree) : tree
}

/**
 * **这个区域里这一种还剩几个 —— 看进复合标签里**(W6-a)。
 *
 * `tree.countKind` 数的是**标签**,而这句话问的是**内容**:一格 `pair` 标签里
 * 装着的那条会话当然算在场。少了这一句,把最后一条会话与一个文件并成两格之后,
 * 播种会认为「这个区域里没有会话了」,当场再补一格空会话进来。
 *
 * 摊开那一句是**种类自述**(`flattenContent` → `ContentKind.composite.parts`),
 * 所以这只文件照旧一个种类名都不认识。
 */
function countKindDeep(tree: PaneNode, kind: string): number {
  let n = 0
  for (const leaf of T.leavesOf(tree)) {
    for (const tab of leaf.tabs) {
      for (const part of flattenContent(tab)) if (part.kind === kind) n += 1
    }
  }
  return n
}

/**
 * 洗一遍两格标签的比例表:**已经不在任何一棵树上的键清掉**。
 * 一格都没清掉时**引用恒等**(不惊动订阅者)。
 */
export function normalizePairRatios(
  regions: Record<string, PaneNode>,
  pairRatios: Record<ContentRefId, number>,
): Record<ContentRefId, number> {
  const live = new Set<ContentRefId>()
  for (const tree of Object.values(regions)) {
    for (const leaf of T.leavesOf(tree)) for (const tab of leaf.tabs) live.add(refId(tab))
  }
  const out: Record<ContentRefId, number> = {}
  let dropped = false
  for (const [id, ratio] of Object.entries(pairRatios ?? {})) {
    if (!live.has(id)) {
      dropped = true
      continue
    }
    out[id] = clampPairRatio(ratio)
  }
  if (!dropped && Object.keys(out).length === Object.keys(pairRatios ?? {}).length) {
    // 值也一格没钳到才算恒等 —— 钳到了就得交新的(存量档案里可能有 0 或 NaN)。
    if (Object.entries(out).every(([id, v]) => pairRatios[id] === v)) return pairRatios
  }
  return out
}

export function clampPairRatio(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : PAIR_RATIO_DEFAULT
  return Math.min(PAIR_RATIO_MAX, Math.max(PAIR_RATIO_MIN, Math.round(n)))
}

/** 洗一遍最近目录表:非字符串 / 空串剔掉、去重、封顶。 */
export function normalizeRecentRoots(roots: unknown): string[] {
  if (!Array.isArray(roots)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const row of roots) {
    if (typeof row !== 'string' || row.length === 0 || seen.has(row)) continue
    seen.add(row)
    out.push(row)
    if (out.length >= RECENT_ROOTS_MAX) break
  }
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
  /*
   * 复合那一格问的是**它装着的那几格**:`pair(会话, 文件)` 里的会话同样受
   * 「这个区域里最后一格常驻的关不掉」那条保护(判词与 `countKindDeep` 同源)。
   */
  const kinds = new Set(flattenContent(ref).map((part) => part.kind))
  const guarded = [...kinds].filter((id) => contentKindOf(id)?.resident)
  if (guarded.length === 0) return true
  return guarded.every((id) => countKindDeep(tree, id) > 1)
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

/* ── 全屏那一格的三条纯判据(W2)────────────────────────────────────────── */

/**
 * 这一格**进不进得了全屏**。判据是**种类自述**(`ContentKind.fullable`),
 * 不是核心层按名字点人 —— 与 `canDetachTab` 问 `resident` 同一条法。
 * 认不得的种类当**进不了**:说不出自己是谁的东西不该铺满整扇窗。
 */
export function canGoFull(ref: ContentRef): boolean {
  const kind = contentKindOf(ref.kind)
  return kind !== undefined && kind.fullable !== false
}

/**
 * 全屏那一格**此刻在哪个区域**(哪棵树都不在 = null,那是「从 Dock 进来的」那一路)。
 * 三个消费者共用它:哪片叶去投影、哪些宿主层该 `inert`、以及下面那条站得住判据。
 */
export function fullRegionOf(
  state: Pick<WorkbenchState, 'regions' | 'full'>,
): RegionId | null {
  if (!state.full) return null
  return regionOfRefIn(state.regions, refId(state.full.ref))
}

/**
 * **这一层此刻被全屏盖住了吗**(W2)。宿主层(架子 / 浮窗 / 舞台)与每一片叶
 * 都问这一句,答 true 就 `inert`(DOM 与树各说一遍)。
 *
 * 判据一句话:**全屏开着,而装着它的不是这个区域**。装着它的那个区域要留活口
 * —— 它那片叶正是把内容投影上去的那一片,内容的 DOM 就住在全屏层里。
 * `region === null`(问的是舞台这种没有区域的宿主)在全屏期间一律盖住。
 */
export function occludedByFull(
  state: Pick<WorkbenchState, 'regions' | 'full'>,
  region: RegionId | null,
): boolean {
  if (!state.full) return false
  return region === null || fullRegionOf(state) !== region
}

/**
 * 全屏那一格**还站不站得住**:它原来住在树里(`from !== null`),而那一格已经
 * 被关掉 / 藏起来 / 整区收掉了 —— 此刻没有任何一片叶能把它投影上去,全屏层就会
 * 变成一块空白。所以那一刻当场退出。
 *
 * `from === null` 那一路天生站得住:它本来就不在任何树里,由全屏层自己画。
 */
export function fullStillStands(
  full: FullState | null,
  regions: Record<string, PaneNode>,
): boolean {
  if (!full) return true
  if (full.from === null) return true
  return regionOfRefIn(regions, refId(full.ref)) !== null
}

/* ── store ────────────────────────────────────────────────────────────── */

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set, get) => {
      /**
       * **拖拽期间树形冻住**(W3;判词整段写在 `WorkbenchState.dragging` 上)。
       *
       * 只闸**改树形**的那几口 —— 切 tab(`activateTab`)、固定预览(`pinTab`)、
       * 拖分隔杆(`setSplitRatio`)、指焦点叶不改叶的**存在与位置**,它们在拖拽
       * 中发生也不会让起拖时量的那份几何过期。`moveRefIntoLeaf` 不在闸内:
       * 它**就是**落定那条路,落定前那一句 `setDragging(false)` 已经把闸开了,
       * 再闸它一次只会让「松手没反应」变成一种可能。
       */
      const frozen = (): boolean => get().dragging

      /** 改一个区域的树。剪空了就重新播种(中央区永远至少有一片叶)。 */
      const writeRegion = (region: RegionId, next: PaneNode | null): void => {
        set((s) => {
          const pruned = next ? T.prune(next) : null
          const regions = { ...s.regions }
          if (pruned) regions[region] = pruned
          else delete regions[region]
          const clean = normalizeRegions(regions)
          return {
            regions: clean,
            pairRatios: normalizePairRatios(clean, s.pairRatios),
            ...fullPatch(s, clean),
          }
        })
      }

      return {
        ...factoryFurniture(),
        byWorkspace: {},
        focusLeafId: null,
        panelPath: null,
        dragging: false,
        full: null,

        seed: () =>
          set((s) => {
            const regions = normalizeRegions(s.regions)
            return {
              regions,
              hidden: normalizeHidden(s.hidden),
              pairRatios: normalizePairRatios(regions, s.pairRatios),
              recentRoots: normalizeRecentRoots(s.recentRoots),
            }
          }),

        openRef: (ref, opts = {}) => {
          if (frozen()) return
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
            regions: { ...regions, [region]: T.insertTab(base, leaf.id, ref) },
            hidden: hidden.length === s.hidden.length ? s.hidden : hidden,
            focusLeafId: leaf.id,
          })
        },

        moveRef: (ref, region, opts = {}) => {
          if (frozen()) return
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
          if (frozen()) return
          const s = get()
          if (!regionOfRefIn(s.regions, id)) return
          const regions = withoutRef(s.regions, id)
          set({ regions, ...fullPatch(s, regions) })
        },

        hideRegion: (region) => {
          if (frozen()) return
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
          const pruned = pruneRegions(regions)
          set({
            hidden: [...s.hidden.filter((entry) => !fresh.has(refId(entry.ref))), ...entries],
            regions: pruned,
            ...fullPatch(s, pruned),
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

        closeTab: (leafId, index) => {
          if (frozen()) return
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
          if (frozen()) return
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
          if (frozen()) return
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
          if (frozen()) return
          const s = get()
          const region = regionOfLeaf(s.regions, leafId)
          if (!region) return
          /*
           * **单叶政策**(W6-a):中央区不受理分屏。这一句挡在这里而不是只挡在
           * 菜单上,是因为分屏有第二个发起方 —— 拖到内容区四带那条落定
           * (`drop-commit.dropIntoLeaf`)。少了它,`normalizeRegions` 会在下一次
           * 写树时把那一刀折回去,而中间那一帧屏幕上真的分了屏:用户看见的是
           * 一次「闪了一下又弹回来」。判词与那张政策表写在 `SINGLE_LEAF_REGIONS` 上。
           */
          if (SINGLE_LEAF_REGIONS.includes(region)) return
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

        setDragging: (on) => set((s) => (s.dragging === on ? s : { dragging: on })),

        moveRefIntoLeaf: (ref, leafId, opts = {}) => {
          const s = get()
          const region = regionOfLeaf(s.regions, leafId)
          if (!region) return
          const kind = contentKindOf(ref.kind)
          if (kind?.regions && !kind.regions.includes(region)) return
          const id = refId(ref)
          /*
           * **一次 set**:先从每棵树里摘干净(`withoutRef` 自带剪枝),再插进目标
           * 叶。摘完之后那片叶有可能已经不在了(它只装着被搬的这一格,摘完被剪掉)
           * —— 那时这一下就是空动作,原样交回,而不是往一棵没有它的树里插。
           */
          const regions = withoutRef(s.regions, id)
          const tree = regions[region]
          if (!tree || !T.findLeaf(tree, leafId)) return
          set({
            regions: { ...regions, [region]: T.insertTab(tree, leafId, ref, { at: opts.at }) },
            // 搬出来的那一份不再是「藏着的」(实例一路留着,与 `moveRef` 同一句)。
            hidden: s.hidden.filter((entry) => refId(entry.ref) !== id),
            focusLeafId: leafId,
          })
        },

        moveTab: (leafId, from, to) => {
          const s = get()
          const region = regionOfLeaf(s.regions, leafId)
          if (!region) return
          const tree = s.regions[region]
          if (!tree) return
          const next = T.moveTab(tree, { leafId, index: from }, { leafId, at: to })
          // 引用恒等 = 这一下什么都没换(夹到两端 / 落点前后就是自己)——不惊动订阅者。
          if (next === tree) return
          set({ regions: { ...s.regions, [region]: next }, focusLeafId: leafId })
        },

        pairRefs: (leafId, hostIndex, ref, side) => {
          if (frozen()) return
          const s = get()
          const region = regionOfLeaf(s.regions, leafId)
          if (!region) return
          const kind = contentKindOf(ref.kind)
          if (kind?.regions && !kind.regions.includes(region)) return
          const host = T.findLeaf(s.regions[region], leafId)?.tabs[hostIndex]
          if (!host) return
          // 拖回自己身上不是一次并(不变量 3 的前半句)。
          if (sameRef(host, ref)) return
          // 两格的标签不能再并(设计 §6「不允许」)。
          if (isCompositeContent(ref)) return

          const hostParts = partsOfContent(host)
          /*
           * host 已经是两格 → 换掉那一侧。**被换下来的那一格不丢**:它落在这一格
           * 后面成为一格普通标签。
           *
           * 设计 §5 那张表写的是「替换『X 的右格』」—— 说的是这一格标签此后画谁,
           * 没说被换下来的那份内容该消失。真让它消失,一次拖拽就能把一个没保存的
           * 文件从屏幕上抹掉,而用户只是想换一边看看。所以「替换」在这里的落地是
           * **换出去**,不是**关掉**:实例一路留着,既不问 `beforeClose` 也不
           * `dispose`(判据与 `moveRef` / `hideTab` 同一条)。记档在交卷报里。
           */
          const evicted = hostParts ? (side === 'left' ? hostParts[0] : hostParts[1]) ?? null : null
          const left = side === 'left' ? ref : hostParts?.[0] ?? host
          const right = side === 'left' ? hostParts?.[1] ?? host : ref
          if (sameRef(left, right)) return
          const made = composeContent(left, right)
          if (!made) return

          /*
           * **搬,不是复制**(不变量 1):`ref` 本来在别处开着就先摘干净。
           * `withoutRef` 自带剪枝,所以摘完这片叶可能已经不在了(它只装着那一格),
           * 那时这一下是空动作 —— 与 `moveRefIntoLeaf` 同一句判。
           */
          const stripped = withoutRef(s.regions, refId(ref))
          const base = stripped[region]
          const leaf = base ? T.findLeaf(base, leafId) : null
          if (!base || !leaf) return
          const at = T.indexOfRef(leaf, host)
          if (at < 0) return
          let next = T.replaceRef(base, leafId, host, made)
          // 换下来的那一格排在它后面(不激活 —— 屏幕上活动的仍是刚并好的那一格)。
          if (evicted && !sameRef(evicted, ref)) {
            next = T.insertTab(next, leafId, evicted, { at: at + 1, activate: false })
          }
          const regions = { ...stripped, [region]: next }
          set({
            regions,
            // 并进来的那一份不再是「藏着的」(与 `moveRef` 同一句)。
            hidden: s.hidden.filter((entry) => refId(entry.ref) !== refId(ref)),
            pairRatios: normalizePairRatios(regions, s.pairRatios),
            focusLeafId: leafId,
            ...fullPatch(s, regions),
          })
        },

        unpairAt: (leafId, index) => {
          if (frozen()) return
          const s = get()
          const region = regionOfLeaf(s.regions, leafId)
          if (!region) return
          const tree = s.regions[region]
          const tab = T.findLeaf(tree, leafId)?.tabs[index]
          if (!tab) return
          const parts = partsOfContent(tab)
          if (!parts || parts.length < 2) return
          /*
           * 左格顶回原位、右格插在它后面、**活动格不动**(设计 §6:「焦点留在
           * 原标签」)。两步在**一次 `set`** 里:分两次写的话中间那一拍屏幕上
           * 少一格,而订阅者(投影 / 焦点跟随)会把它读成「关掉了一格」。
           */
        const swapped = T.replaceRef(tree, leafId, tab, parts[0])
          const next = T.insertTab(swapped, leafId, parts[1], { at: index + 1, activate: false })
          const regions = { ...s.regions, [region]: next }
          const ratios = { ...s.pairRatios }
          delete ratios[refId(tab)]
          set({
            regions,
            pairRatios: normalizePairRatios(regions, ratios),
            focusLeafId: leafId,
            ...fullPatch(s, regions),
          })
        },

        setPairRatio: (id, ratio) =>
          set((s) => {
            const next = clampPairRatio(ratio)
            if (s.pairRatios[id] === next) return s
            return { pairRatios: { ...s.pairRatios, [id]: next } }
          }),

        rememberRoot: (path) =>
          set((s) => {
            if (!path) return s
            if (s.recentRoots[0] === path) return s
            const next = [path, ...s.recentRoots.filter((row) => row !== path)]
            return { recentRoots: next.slice(0, RECENT_ROOTS_MAX) }
          }),

        replaceRef: (leafId, from, to) => {
          const s = get()
          const region = regionOfLeaf(s.regions, leafId)
          if (!region) return
          const kind = contentKindOf(to.kind)
          if (kind?.regions && !kind.regions.includes(region)) return
          const tree = s.regions[region]
          /*
           * **`from` 可能住在一格复合标签里**(W6-a):两格标签里那格会话被列表
           * 里点一行换掉时,树上根本没有一格 tab 叫这个名字。那时换的是**那格
           * 复合内容自己** —— 重新拼一格出来顶在原位,叶与下标一个字不动
           * (零重挂那条铁律在这里与原位换 ref 是同一句话)。
           */
          const inside = composedReplacement(tree, leafId, from, to)
          if (inside) {
            const regions = { ...s.regions, [region]: inside }
            set({ regions, pairRatios: normalizePairRatios(regions, s.pairRatios), focusLeafId: leafId })
            return
          }
          const next = T.replaceRef(tree, leafId, from, to)
          if (next === tree) return
          /*
           * 换进来的那一格可能**别处还开着一份**(在另一片叶里,或者藏着)。
           * 先摘干净再换是唯一能同时守住两条的次序:树上不许有两格同 refId,
           * 而这片叶自己那一格是**换**不是插 —— 反过来先换再摘会把刚换上去的
           * 那一格自己摘掉。
           *
           * `withoutRef` 自带剪枝,所以摘完这片叶可能已经不在了(它只装着那一格
           * 被摘的)—— 那时这一下是空动作,原样交回。
           */
          const elsewhere = { ...s.regions }
          const stripped = withoutRef(elsewhere, refId(to))
          const base = stripped[region]
          if (!base || !T.findLeaf(base, leafId)) {
            set({ regions: { ...s.regions, [region]: next }, focusLeafId: leafId })
            return
          }
          const merged = T.replaceRef(base, leafId, from, to)
          const regions = { ...stripped, [region]: merged }
          set({
            regions,
            // 换进来的那一份不再是「藏着的」(与 `moveRef` 同一句)。
            hidden: s.hidden.filter((entry) => refId(entry.ref) !== refId(to)),
            focusLeafId: leafId,
            ...fullPatch(s, regions),
          })
        },

        sweepRefs: (alive) => {
          const s = get()
          const regions: Record<string, PaneNode> = {}
          let changed = false
          for (const [region, tree] of Object.entries(s.regions)) {
            let next = tree
            for (const leaf of T.leavesOf(tree)) {
              for (const ref of leaf.tabs) {
                if (alive(ref)) continue
                const kind = contentKindOf(ref.kind)
                /*
                 * 常驻那一种在这个区域里的**最后一格**:原位换成它自己新播的
                 * 那一格(判据与 `canDetachTab` 同源 —— 问的是「还剩不剩同种的」,
                 * 不是「它是不是会话」)。摘掉再让 `normalizeRegions` 补一格
                 * 也能补出来,但那是**另一片叶**:原叶被剪掉、新叶换了 id,
                 * 整台聊天区连兄弟一起重挂,而用户只是删了一条会话。
                 */
                const last = kind?.resident && countKindDeep(next, ref.kind) <= 1
                const fresh = last && kind?.resident ? { kind: ref.kind, key: kind.resident.seed() } : null
                if (fresh && !alive(fresh)) {
                  // 新播的那一格自己也是死的 = 这一种此刻播不出活的来,整格摘掉。
                  next = removeRefFrom(next, refId(ref))
                } else if (fresh) {
                  next = T.replaceRef(next, leaf.id, ref, fresh)
                } else {
                  next = removeRefFrom(next, refId(ref))
                }
              }
            }
            if (next !== tree) changed = true
            regions[region] = next
          }
          const hidden = s.hidden.filter((entry) => alive(entry.ref))
          if (!changed && hidden.length === s.hidden.length) return
          // 摘掉的那些实例由种类自己清(与 `closeTab` / `dropHidden` 同一句)。
          for (const entry of s.hidden) {
            if (!alive(entry.ref)) contentKindOf(entry.ref.kind)?.dispose?.(entry.ref)
          }
          /*
           * 只剪枝、**不重新播种**:该补的那一格上面已经原位换好了,而
           * `normalizeRegions` 要读种类表 —— 清洗这条路是「动作」不是「入口」,
           * 与 `pruneRegions` 文件末尾那段分工判词逐字同源。
           */
          const clean = pruneRegions(regions)
          set({
            regions: clean,
            hidden: hidden.length === s.hidden.length ? s.hidden : hidden,
            ...fullPatch(s, clean),
          })
        },

        enterFull: (ref, from) => {
          const s = get()
          if (!canGoFull(ref)) return
          /*
           * `from` 缺席 = **问树**:它此刻在哪一格,退出时焦点就送回哪一格。
           * 递了 `null` 进来 = 调用方明说「它不在任何树里」(Dock 那条路)。
           */
          const at = from === undefined ? locateRefIn(s.regions, refId(ref)) : from
          if (s.full && refId(s.full.ref) === refId(ref) && s.full.from === at) return
          set({ full: { ref, from: at } })
        },

        exitFull: () => set((s) => (s.full === null ? s : { full: null })),

        exitFullIfOpen: () => {
          if (get().full === null) return false
          set({ full: null })
          return true
        },

        toggleFull: () => {
          const s = get()
          // 开着就退 —— **同一个键再按一次收回去**(设计 §4.1 那张表最后一行)。
          if (s.full) {
            set({ full: null })
            return 'exited'
          }
          /*
           * 进:取**焦点叶的活动 tab**。焦点叶就是「新标签开在哪一片」的那一格,
           * 所以「⌘⇧↩ 把哪一块铺满」与「⌘T 在哪儿开新的」问的是同一个答案 ——
           * 用户不必学两套心智。焦点叶所在的区域由 `regionOfLeafIn` 反查(它可能
           * 在中央、在架子、在浮窗里,三处一视同仁)。
           */
          const region = s.focusLeafId ? regionOfLeafIn(s.regions, s.focusLeafId) : CENTER_REGION
          const tree = s.regions[region ?? CENTER_REGION]
          if (!tree) return 'none'
          const leaf = focusLeafOf(tree, s.focusLeafId)
          const ref = leaf.tabs[leaf.active]
          if (!ref) return 'none'
          // 这一种自述进不了全屏(今天只有 chat)→ **结构化拒绝**,不静默。
          if (!canGoFull(ref)) return 'refused'
          set({
            full: {
              ref,
              from: { region: region ?? CENTER_REGION, leafId: leaf.id, index: leaf.active },
            },
          })
          return 'entered'
        },

        openInPanel: (path) => set({ panelPath: path }),
        closePanel: () => set({ panelPath: null }),

        reset: () =>
          set({
            ...factoryFurniture(),
            byWorkspace: {},
            focusLeafId: null,
            panelPath: null,
            dragging: false,
            full: null,
          }),
      }
    },
    {
      name: 'onething.workbench',
      /*
       * ── 版本账 ──────────────────────────────────────────────────────────
       * v1 = W1 的形(树按 Workspace 记,常驻那一格是 `chat:main`);
       * v2 = **W5-b 会话多开**:`chat` 这一种改名 `session`,`key` 从死的 `main`
       *      换成会话 id。存量档案里那一格由 `migrateChatToSession` 翻成
       *      `session:<seed>` —— 而 `seed` 此刻恒是保留键,因为「当前会话」
       *      **不跨启动持久化**(理由写在 expose 那一槽的 partialize 上:
       *      记一个可能已被删掉的 id,换来的是一个指向空气的标题);
       * v3 = **W6-a 单叶 + 预览退役**:中央区那棵树按阅读序折成一片叶(比例随
       *      split 节点一起丢掉),每一片叶身上那格 `preview` 抹掉。两件事一起
       *      走一遍,判词与幂等 / 引用恒等两条要求写在 `persist-migrate.ts` 上。
       *
       * **两级迁移串着跑**(v1 的档案要先翻名字再折叶):`migrate` 里按版本从低
       * 到高逐级过,不是 `if/else` 二选一 —— 一份 v1 档案跳过 v3 那一遍的话,
       * 它的中央区会带着一棵多叶树进 merge,而那时 `sanitize` 洗不掉它
       * (洗形状不是折叶,判词在 `normalizeRegions`)。
       */
      version: 3,
      migrate: (persisted, version) => {
        if (!persisted || typeof persisted !== 'object') return persisted
        let out = persisted as Record<string, unknown>
        if (version < 2) out = rewriteRefsInPersisted(out, rewriteLegacyContentRef)
        if (version < 3) out = foldRegionsInPersisted(out, SINGLE_LEAF_REGIONS)
        return out
      },
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
        merged.pairRatios = normalizePairRatios(merged.regions, merged.pairRatios ?? {})
        merged.recentRoots = normalizeRecentRoots(merged.recentRoots)
        // 瞬态那几格永远从零开始(它们不落盘,但 merge 收到的 current 里有)。
        merged.focusLeafId = null
        merged.panelPath = null
        merged.dragging = false
        merged.full = null
        return merged
      },
      partialize: (s) => ({ byWorkspace: stashSpace(s, s.byWorkspace, WORKBENCH_PER_SPACE) }),
    },
  ),
)

/** 这片叶住在哪个区域。 */
const regionOfLeaf = regionOfLeafIn

/** 这个 refId 此刻在哪一格(区域 + 叶 + 叶内下标)。哪棵树都不在 = null。 */
function locateRefIn(
  regions: Record<string, PaneNode>,
  id: ContentRefId,
): PaneLocation | null {
  for (const [region, tree] of Object.entries(regions)) {
    const at = T.locateRef(tree, region as RegionId, id)
    if (at) return at
  }
  return null
}

/**
 * **树动过之后,全屏那一格还站得住吗**(W2)。站得住就交回空补丁(一格不写,
 * 引用恒等照旧);站不住就当场清零。
 *
 * 它套在**每一条会让内容离开树的路**上(关 / 藏 / 整区隐藏 / 摘掉),而不是让
 * 全屏层自己去发现「我要投影的那一格没了」——那时屏幕上已经是一块空白了。
 */
function fullPatch(
  s: Pick<WorkbenchState, 'full'>,
  regions: Record<string, PaneNode>,
): { full?: null } {
  return fullStillStands(s.full, regions) ? {} : { full: null }
}

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

/**
 * **`from` 住在这片叶的某一格复合标签里时,把那一格重新拼出来**(W6-a)。
 *
 * 答 `null` = 「它不在任何一格复合标签里」,调用方照旧走普通那条 `tree.replaceRef`。
 * 拼不出来(`composeContent` 说这两格并不了)也答 `null` —— 那时什么都不做
 * 比拆掉一格标签更诚实。
 *
 * 一个种类名都不出现:摊开与重拼两句都是**种类自述**(`partsOfContent` /
 * `composeContent`)。
 */
function composedReplacement(
  tree: PaneNode,
  leafId: string,
  from: ContentRef,
  to: ContentRef,
): PaneNode | null {
  const leaf = T.findLeaf(tree, leafId)
  if (!leaf) return null
  for (const tab of leaf.tabs) {
    const parts = partsOfContent(tab)
    if (!parts || parts.length < 2) continue
    const at = parts.findIndex((part) => sameRef(part, from))
    if (at < 0) continue
    const next = [...parts]
    next[at] = to
    const made = composeContent(next[0], next[1])
    if (!made) return null
    return T.replaceRef(tree, leafId, tab, made)
  }
  return null
}

/** 把一个 refId 从**一棵**树里摘掉(不剪枝 —— 剪不剪由调用方决定)。 */
function removeRefFrom(tree: PaneNode, id: ContentRefId): PaneNode {
  let cleaned = tree
  for (const leaf of T.leavesOf(tree)) {
    const at = leaf.tabs.findIndex((tab) => refId(tab) === id)
    if (at >= 0) cleaned = T.removeTab(cleaned, leaf.id, at)
  }
  return cleaned
}

/** 把一个 refId 从**每一棵**树里摘掉,然后剪一遍。 */
function withoutRef(
  regions: Record<string, PaneNode>,
  id: ContentRefId,
): Record<string, PaneNode> {
  const next: Record<string, PaneNode> = {}
  for (const [region, tree] of Object.entries(regions)) {
    next[region] = removeRefFrom(tree, id)
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

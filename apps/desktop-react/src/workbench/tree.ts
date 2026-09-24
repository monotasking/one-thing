import { flattenContent, partsOfContent, refId, residencyLevelOf, sameRef } from './kinds'
import { regionReadRank } from './regions'
import type { ContentRef, ContentRefId, ResidencyLevel } from './kinds'
import type { RegionId } from './regions'

/** 分屏带朝哪一侧切(拖拽落点与落定共用这一个词)。 */
export type SplitSide = 'left' | 'right' | 'top' | 'bottom'

/**
 * **拼贴树**(设计 `apps/desktop-react/docs/workbench-2026-09.md` §1.2)—— 一个区域
 * 内部怎么摆。整只文件是**纯函数**:没有 React、没有 DOM、没有 store,
 * 而且**一个内容种类名都不出现**(`'file'` / `'chat'` / `'panel'` 全仓 grep
 * 在这只文件里零命中)。它只认 `ContentRef` 那两个字符串。
 *
 * 于是「加一种内容」不会到达这里,而树的每一条判据都能被表驱动地测。
 *
 * ── 结构共享:没变就交回同一个对象 ──────────────────────────────────────
 * 每一口都走 `mapLeaf` / `mapNode` 那条路:改到的那一支重建,没改到的**原样带过**。
 * 这是「分屏 / 并 tab / 关叶不重挂兄弟叶」那条零重挂断言的**结构前提** ——
 * 兄弟叶的节点对象引用不变,React 那一侧的 memo 才短路得掉。
 *
 * ── 空树不存在 ──────────────────────────────────────────────────────────
 * `prune` 可以把一棵树剪成 `null`(所有叶都空了)。**判断「空了怎么办」不是树的事**
 * —— 由 store 决定重新播种(中央区那棵永远至少有一片叶)。树只负责说实话。
 */

export interface PaneLeafNode {
  kind: 'leaf'
  id: string
  tabs: ContentRef[]
  /** 活动 tab 的下标。空叶时是 0(没有意义,但不留 `null` 让每个读者判一次)。 */
  active: number
  /**
   * **预览格的下标**(C2,设计 `apps/desktop-react/docs/session-continuity-2026-09.md`
   * §4.3)。缺席 = 这片叶此刻没有预览格。
   *
   * ── 它与 W6-a 删掉的那格 `preview: boolean` 不是同一件事 ──────────────────
   * 那一格是**每格一个布尔**,而且是文件那一种的语义(「点一个文件先塞进预览格」),
   * 用户 09-05 在真机上明确否决了它(「files 本身应该是一个可以打开多个的存在」)。
   * 这一格是**一片叶最多一格**的下标,而且它的语义由**打开方式**那档偏好决定
   * (`data/session-open-mode.ts`;缺省 `preview`)。判词写在那只文件与
   * `content/session-open.ts` 上 —— 这里只负责一件事:**跟着下标动**。
   *
   * ── 它不落盘 ────────────────────────────────────────────────────────────
   * `WORKBENCH_PER_SPACE.pick` 那一句 `stripPreviewIndex` 把它从家具账里剥掉
   * (判词在 store 的 `pick` 上)。所以重启 / 换工作区回来,预览格**转正** ——
   * 「随手翻翻」是一次会话内的事,不该跨越一次「我回来了」。
   *
   * 树自己**不认识**「预览」这个词的产品含义:它只知道「这片叶上有一格被标着,
   * 而插 / 摘 / 换序时这个下标要跟着走」。所以这只文件照旧一个种类名都不出现。
   */
  previewIndex?: number
  /**
   * **钉住的那几格**(C3,设计 `session-continuity-2026-09.md` §3.4)。缺席 = 一格都没钉。
   *
   * ── 它为什么记 `refId` 而不是像 `previewIndex` 那样记下标 ────────────────
   * 两者是同一层的两格标记(都住在叶上、都落盘 —— 除了预览那一格被 `pick` 剥掉),
   * 但它们答的问题不同:预览格**只有一个座**,而钉住是**一格一格**的;一张下标
   * 表要在每一次插 / 摘 / 换序里跟着重算,而那正是 `previewAfterInsert` /
   * `previewAfterRemove` 那两只小函数存在的理由 —— 复制一份多元素版出来,是给
   * 每一条改树的路各多一处能漏的账。`refId` 天生不动,而「这一格还在不在这片叶
   * 上」在**读**的那一刻一问便知(`pinnedIdsOf` 就是那道闸,与 `previewIndexOf`
   * 把越界读成「没有」逐字同一体例)。
   *
   * ── 搬走 = 不再钉住,这是有意的 ────────────────────────────────────────
   * 把一格钉住的标签拖到另一片叶去,源叶留下一个指不着任何 tab 的 id(读的时候
   * 被滤掉),目标叶上它不是钉住的。这与「拖走预览格 = 把它转正」是同一句话:
   * **标记说的是「这片叶上的这一格」,而不是「这份内容」**。
   *
   * ── 它落盘 ──────────────────────────────────────────────────────────────
   * 与 `previewIndex` 相反:`WORKBENCH_PER_SPACE.pick` 剥的只有预览那一格。
   * 「我把这棵目录树钉在这儿了」是**用户摆好的东西**,该活过一次重启 ——
   * 判据就是 `per-space.ts` 那句「它是不是用户在这个空间里摆好的东西」。
   */
  pinned?: readonly ContentRefId[]
}

export interface PaneSplitNode {
  kind: 'split'
  id: string
  /** row = 左右分;col = 上下分。 */
  dir: 'row' | 'col'
  /** a 支占的百分比(0–100),与 `ui/Splitter` 的 value 同一个量纲。 */
  ratio: number
  a: PaneNode
  b: PaneNode
}

export type PaneNode = PaneLeafNode | PaneSplitNode

/** 树里的一个位置。隐藏与全屏都靠它记「回哪儿」。 */
export interface PaneLocation {
  region: RegionId
  leafId: string
  index: number
}

export const DEFAULT_SPLIT_RATIO = 50

export function makeLeaf(id: string, tabs: ContentRef[] = [], active = 0): PaneLeafNode {
  return { kind: 'leaf', id, tabs, active }
}

/* ── 预览格:一片叶最多一格标记(C2)────────────────────────────────────── */

/**
 * 这片叶的预览格在第几。**越界 / 不是整数 / 缺席一律答 `undefined`** ——
 * 读者不必各判一遍,而一份被手改过的档案(或者将来某条漏了维护的路)只会
 * 「没有预览格」,不会画出一格指向空气的斜体标签。
 */
export function previewIndexOf(leaf: PaneLeafNode): number | undefined {
  const at = leaf.previewIndex
  if (at === undefined) return undefined
  if (!Number.isInteger(at) || at < 0 || at >= leaf.tabs.length) return undefined
  return at
}

/**
 * 换掉一片叶的预览标记。`undefined` = **把那一格键整个删掉**(不是留一个
 * `previewIndex: undefined`):这只文件的引用恒等是逐字段比对出来的,而多留一个
 * 谁都不读的键正是 persist v3 删 `preview` 时写下的那条判例。
 * 值没变时原样交回同一个对象。
 */
function withPreview(leaf: PaneLeafNode, next: number | undefined): PaneLeafNode {
  if (leaf.previewIndex === next) return leaf
  if (next === undefined) {
    const { previewIndex: _drop, ...rest } = leaf
    void _drop
    return rest
  }
  return { ...leaf, previewIndex: next }
}

/** 摘掉第 `removed` 格之后,预览标记落在哪。**摘掉的就是它 → 没有预览格了**。 */
function previewAfterRemove(at: number | undefined, removed: number): number | undefined {
  if (at === undefined || at === removed) return undefined
  return at > removed ? at - 1 : at
}

/** 在第 `inserted` 格插一格之后,预览标记落在哪(插在它身上或它前面就往后挪)。 */
function previewAfterInsert(at: number | undefined, inserted: number): number | undefined {
  if (at === undefined) return undefined
  return at >= inserted ? at + 1 : at
}

/**
 * **标一格为预览格**(一片叶最多一格,所以这是「换」不是「加」)。
 * 下标越界 / 叶不在 = 恒等。
 */
export function setPreviewIndex(node: PaneNode, leafId: string, index: number): PaneNode {
  return mapLeaf(node, leafId, (leaf) =>
    index < 0 || index >= leaf.tabs.length ? leaf : withPreview(leaf, index),
  )
}

/**
 * **转正**:清掉这片叶的预览标记。`index` 给了就只在它**恰好是**预览格时才清
 * ——「保留这一格」说的是这一格,不是「把这片叶的预览格清掉」;两者在一片装着
 * 两条会话的叶上不是一件事。不给 = 无条件清。
 */
export function clearPreviewIndex(node: PaneNode, leafId: string, index?: number): PaneNode {
  return mapLeaf(node, leafId, (leaf) => {
    const at = previewIndexOf(leaf)
    if (at === undefined) return withPreview(leaf, undefined)
    if (index !== undefined && index !== at) return leaf
    return withPreview(leaf, undefined)
  })
}

/**
 * **把整棵树上的预览标记剥掉**(落盘那一侧唯一的调用点:`WORKBENCH_PER_SPACE.pick`)。
 * 一格都没剥到时**原样交回同一个对象** —— 与 `persist-migrate` 那两条硬要求同源。
 */
export function stripPreviewIndex(node: PaneNode): PaneNode {
  if (node.kind === 'leaf') return withPreview(node, undefined)
  const a = stripPreviewIndex(node.a)
  const b = stripPreviewIndex(node.b)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

/* ── 钉住:一片叶上的一张 refId 名单(C3)────────────────────────────────── */

/**
 * 这片叶此刻真正钉着哪几格。**指不着任何一格 tab 的 id 一律不算** ——
 * 与 `previewIndexOf` 把越界读成「没有」逐字同一条:读者不必各判一遍,而一份
 * 被手改过的档案(或者一次把钉住的标签拖走之后留下的残渣)只会「少一格钉住」,
 * 不会让屏幕上画出一枚指向空气的图钉。**次序照 tab 的次序**,不照名单的次序:
 * 名单是一个集合,而屏幕上的东西有左右。
 */
export function pinnedIdsOf(leaf: PaneLeafNode): readonly ContentRefId[] {
  const raw = leaf.pinned
  if (!Array.isArray(raw) || raw.length === 0) return EMPTY_PINNED
  const want = new Set(raw.filter((id): id is ContentRefId => typeof id === 'string'))
  if (want.size === 0) return EMPTY_PINNED
  const out: ContentRefId[] = []
  for (const tab of leaf.tabs) {
    const id = refId(tab)
    if (want.has(id) && !out.includes(id)) out.push(id)
  }
  return out.length === 0 ? EMPTY_PINNED : out
}

/** 同一个空数组 —— 「没钉住」这句话在每一次读里都是同一个对象,memo 才短路得掉。 */
const EMPTY_PINNED: readonly ContentRefId[] = []

/** 这片叶第 `index` 格钉住了吗。越界 = false。 */
export function isPinnedAt(leaf: PaneLeafNode, index: number): boolean {
  const tab = leaf.tabs[index]
  return tab !== undefined && pinnedIdsOf(leaf).includes(refId(tab))
}

/**
 * 换掉一片叶的钉住名单。`undefined` / 空 = **把那一格键整个删掉**(不是留一个
 * 空数组):判据与 `withPreview` 逐字同一条 —— 引用恒等是逐字段比对出来的,
 * 而一份档案里躺着一个谁都不读的键是下一个人的陷阱。值没变时原样交回同一个对象。
 */
function withPinned(leaf: PaneLeafNode, next: readonly ContentRefId[] | undefined): PaneLeafNode {
  const now = leaf.pinned
  const empty = !next || next.length === 0
  if (empty) {
    if (now === undefined) return leaf
    const { pinned: _drop, ...rest } = leaf
    void _drop
    return rest
  }
  if (
    Array.isArray(now)
    && now.length === next.length
    && now.every((id, at) => id === next[at])
  ) return leaf
  return { ...leaf, pinned: next }
}

/**
 * 换完一批 tab 之后名单该剩什么。**摘掉的那一格顺带不再钉住** —— 不清的话,
 * 一格关掉又重开的同名内容会「自己带着图钉回来」,那是用户没做过的一次钉住。
 * 一格都没掉时原样交回同一个数组(引用恒等)。
 */
function pinnedAfterTabs(
  leaf: PaneLeafNode,
  tabs: readonly ContentRef[],
): readonly ContentRefId[] | undefined {
  const raw = leaf.pinned
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const live = new Set(tabs.map(refId))
  const next = raw.filter((id) => live.has(id))
  if (next.length === 0) return undefined
  return next.length === raw.length ? raw : next
}

/**
 * **钉住 / 取消钉住这片叶的第 `index` 格**。下标越界 / 叶不在 / 这一下什么都没换
 * = 恒等(整棵树原样交回,不惊动任何订阅者)。
 */
export function setPinnedAt(
  node: PaneNode,
  leafId: string,
  index: number,
  on: boolean,
): PaneNode {
  return mapLeaf(node, leafId, (leaf) => {
    const tab = leaf.tabs[index]
    if (!tab) return leaf
    const id = refId(tab)
    const now = pinnedIdsOf(leaf)
    // 已经是要的那个样子 —— **原样交回**,不顺手把名单里的残渣清掉:
    // 那是一次没人要过的写,而读那一头(`pinnedIdsOf`)本来就滤得干净。
    if (on === now.includes(id)) return leaf
    const next = on ? [...now, id] : now.filter((row) => row !== id)
    return withPinned(leaf, next)
  })
}

/* ── 查询 ─────────────────────────────────────────────────────────────── */

/** 按左→右 / 上→下的阅读序把叶摊平。顶栏标签组的排序(W1-b)读的就是这个序。 */
export function leavesOf(node: PaneNode): PaneLeafNode[] {
  if (node.kind === 'leaf') return [node]
  return [...leavesOf(node.a), ...leavesOf(node.b)]
}

export function findLeaf(node: PaneNode, leafId: string): PaneLeafNode | null {
  if (node.kind === 'leaf') return node.id === leafId ? node : null
  return findLeaf(node.a, leafId) ?? findLeaf(node.b, leafId)
}

/** 这片叶里这个 ref 在第几格。-1 = 不在。 */
export function indexOfRef(leaf: PaneLeafNode, ref: ContentRef): number {
  return leaf.tabs.findIndex((tab) => sameRef(tab, ref))
}

/** 整棵树里这个 refId 在哪儿。答不出 = 不在这棵树上。 */
export function locateRef(
  node: PaneNode,
  region: RegionId,
  id: ContentRefId,
): PaneLocation | null {
  for (const leaf of leavesOf(node)) {
    const at = leaf.tabs.findIndex((tab) => refId(tab) === id)
    if (at >= 0) return { region, leafId: leaf.id, index: at }
  }
  return null
}

/**
 * **一份 regions 的阅读序**(中央 → 四条边 → 浮窗)。判据在 `regions.regionReadRank`
 * 上,这只是那句话在「一张区域表」上的唯一写法 —— 三处查找、伴随面的收、
 * 携带的捡都读它,`Object.keys` 的次序从来不是判据。
 */
export function regionsInReadOrder(regions: Readonly<Record<string, PaneNode>>): string[] {
  return [...Object.keys(regions)].sort((a, b) => regionReadRank(a) - regionReadRank(b))
}

/* ── 座位:一格内容此刻坐在全壳的哪儿 ─────────────────────────────────────── */

/**
 * **一格内容的座位**(区域 + 叶 + 叶内下标 + 它是不是那片叶露脸的那一格)。
 *
 * `partIndex` 是 W7-p 修一轮裁定 2 加的那一格:`null` = 这一格标签**就是**它;
 * 0 / 1 / … = 它是那格**复合**标签(二合一)里的第几侧。调用方据此决定语义 ——
 * 「切过去」对哪一侧都成立(激活那格标签 + 焦点进那一侧的内容层),而「原位换 ref」
 * 那一族只对 `partIndex === null` 说得通(`replaceRef` 改的是顶层标签)。
 */
export interface RefSeat {
  region: RegionId
  leafId: string
  index: number
  /** 它是那片叶此刻露脸的那一格吗。 */
  active: boolean
  partIndex: number | null
}

/**
 * **全壳唯一的「这格内容坐在哪」**(W7-p 修一轮裁定 2)。
 *
 * ── 病历 ──────────────────────────────────────────────────────────────────
 * 从前有两只:`stage/summon.seatOfRefIn`(按顶层 `refId` 找)与
 * `content/session-open.seatOfRef`(同样只看顶层,而且不问区域次序)。两只都
 * **不摊复合**,于是「在右侧打开」造出一格 `pair:` 二合一之后,那条会话在两只
 * 眼里都不存在:sidebar 单击它 → 召唤答 `null` → 走「顶替焦点那片会话叶」,
 * 把中央区正看着的那条顶掉,而用户要的只是切到已经开着的那一格。
 *
 * 今天一只,而且**摊开复合**(`kinds.flattenContent` —— 核心层照旧一个种类名都
 * 不认识,复合怎么摊由那一种自述)。区域次序由 `regions.regionReadRank` 说
 * (中央 → 四条边 → 浮窗),判词在那儿。
 */
export function seatOfRefIn(
  regions: Readonly<Record<string, PaneNode>>,
  id: ContentRefId,
): RefSeat | null {
  for (const region of regionsInReadOrder(regions)) {
    const tree = regions[region]
    if (!tree) continue
    for (const leaf of leavesOf(tree)) {
      for (let at = 0; at < leaf.tabs.length; at += 1) {
        const tab = leaf.tabs[at]
        if (refId(tab) === id) {
          return { region: region as RegionId, leafId: leaf.id, index: at, active: leaf.active === at, partIndex: null }
        }
        // 复合那一格:摊开之后再比。摊的深度与「这个区域里这一种还剩几个」
        // 那条判据同源(`flattenContent`),所以二合一里的会话到处都算在场。
        const parts = flattenContent(tab)
        if (parts.length <= 1) continue
        const side = parts.findIndex((part) => refId(part) === id)
        if (side >= 0) {
          return { region: region as RegionId, leafId: leaf.id, index: at, active: leaf.active === at, partIndex: side }
        }
      }
    }
  }
  return null
}

/**
 * **这一种内容此刻有没有一格开着;有就给出读序最靠前的那一格**(W7-c 裁定 6)。
 *
 * 它与 `seatOfRefIn` 是同一族查找的两个粒度:那只回答「**这一格**坐在哪」,这只
 * 回答「**这一种**有没有人在场」。启动瓦的召唤要问的正是后者 —— 目录面板那块瓦
 * 在会话没绑目录时答不出 `dragRef`(它拖不出东西),但屏幕上可能正开着一棵别的
 * 目录树,而用户点那块瓦想要的是「让我看见目录」,不是「再开一个」。
 *
 * 判据与 `seatOfRefIn` 逐字同源:区域次序由 `regions.regionReadRank` 说
 * (中央 → 四条边 → 浮窗),复合那一格**摊开之后再比**(`kinds.flattenContent`,
 * 核心层照旧一个种类名都不认识)。
 */
export function firstRefOfKindIn(
  regions: Readonly<Record<string, PaneNode>>,
  kind: string,
): ContentRef | null {
  for (const region of regionsInReadOrder(regions)) {
    const tree = regions[region]
    if (!tree) continue
    for (const leaf of leavesOf(tree)) {
      for (const tab of leaf.tabs) {
        for (const part of flattenContent(tab)) {
          if (part.kind === kind) return part
        }
      }
    }
  }
  return null
}

/**
 * **这一种内容此刻住在哪片叶**(09-24「打开跟着它住的地方走」):焦点叶里有这一种就是它,
 * 否则按阅读序(中央 → 四条边 → 浮窗)第一片装着这一种的叶。一片都没有 = null。
 *
 * 与 `firstRefOfKindIn` 同一族查找,只是答的是**座位**不是 ref:用户把文件标签拖进了
 * 主区,下一份文件就该开在主区那片叶,而不是设置里写的右架子。复合那一格照旧摊开再比。
 */
export function leafHoldingKindIn(
  regions: Readonly<Record<string, PaneNode>>,
  focusLeafId: string | null,
  kind: string,
): { region: RegionId; leafId: string } | null {
  const holds = (leaf: PaneLeafNode) =>
    leaf.tabs.some((tab) => flattenContent(tab).some((part) => part.kind === kind))
  let first: { region: RegionId; leafId: string } | null = null
  for (const region of regionsInReadOrder(regions)) {
    const tree = regions[region]
    if (!tree) continue
    for (const leaf of leavesOf(tree)) {
      if (!holds(leaf)) continue
      const seat = { region: region as RegionId, leafId: leaf.id }
      if (leaf.id === focusLeafId) return seat
      first ??= seat
    }
  }
  return first
}

/** 整棵树上所有 refId,按阅读序。 */
export function refIdsOf(node: PaneNode): ContentRefId[] {
  return leavesOf(node).flatMap((leaf) => leaf.tabs.map(refId))
}

/** 这个区域里这一种还剩几个 tab(`ContentKind.required` 那条判据读它)。 */
export function countKind(node: PaneNode, kind: string): number {
  let n = 0
  for (const leaf of leavesOf(node)) for (const tab of leaf.tabs) if (tab.kind === kind) n += 1
  return n
}

/* ── 改写:全部走这两只,好让结构共享是结构保证 ─────────────────────────── */

/** 把某一片叶换成 `fn(leaf)` 的结果。答同一个对象 = 整棵树原样交回。 */
export function mapLeaf(
  node: PaneNode,
  leafId: string,
  fn: (leaf: PaneLeafNode) => PaneLeafNode,
): PaneNode {
  if (node.kind === 'leaf') {
    if (node.id !== leafId) return node
    const next = fn(node)
    return next === node ? node : next
  }
  const a = mapLeaf(node.a, leafId, fn)
  const b = mapLeaf(node.b, leafId, fn)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

/** 把某一片叶整个换成另一棵子树(分屏用)。 */
function replaceLeaf(node: PaneNode, leafId: string, next: PaneNode): PaneNode {
  if (node.kind === 'leaf') return node.id === leafId ? next : node
  const a = replaceLeaf(node.a, leafId, next)
  const b = replaceLeaf(node.b, leafId, next)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

/** 夹一下活动下标(空叶答 0)。 */
function clampActive(tabs: readonly ContentRef[], active: number): number {
  if (tabs.length === 0) return 0
  return Math.min(Math.max(0, active), tabs.length - 1)
}

/**
 * 插一个 tab 进某片叶。
 *
 * ── 预览 tab 已退役(W6-a,设计 `workbench-tabs-2026-09.md` §3)────────────
 * W1 这里有第三条支路:`preview: true` 时**就地替换**那片叶里既有的预览格。
 * 用户 09-05 在真机上明确否决了这条语义(「files 本身应该是一个可以打开多个的
 * 存在」),而真机复现同时抓到它带着一个 bug:已经在这片叶里的 ref 提前返回,
 * `preview` 那一格于是**永远清不掉** —— ↵ 想把一个预览格固定下来时什么都没发生。
 * 整条支路连同 `PaneLeafNode.preview` / `pinTab` 一起删掉,那个 bug 随之消失,
 * 而下面这句「已经在这片叶里 = 只激活」剩下来的正是它本来该有的语义。
 */
export function insertTab(
  node: PaneNode,
  leafId: string,
  ref: ContentRef,
  opts: { at?: number; activate?: boolean; preview?: boolean } = {},
): PaneNode {
  const { at, activate = true, preview = false } = opts
  return mapLeaf(node, leafId, (leaf) => {
    const already = indexOfRef(leaf, ref)
    if (already >= 0) {
      // 已经在这片叶里 —— 只激活(不重复插:一个内容在一个区域里只出现一次)。
      if (leaf.active === already) return leaf
      return { ...leaf, active: already }
    }
    const index = at === undefined ? leaf.tabs.length : Math.min(Math.max(0, at), leaf.tabs.length)
    const tabs = [...leaf.tabs]
    tabs.splice(index, 0, ref)
    /*
     * 插在活动 tab **之前**时,活动下标要跟着往后挪一格 —— 不挪的话屏幕上活动的
     * 那一条会静默换成隔壁。这是下标制 tab 条最容易漏的一格。
     */
    const active = activate
      ? index
      : clampActive(tabs, leaf.active >= index ? leaf.active + 1 : leaf.active)
    /*
     * **预览标记跟着下标走**(C2)。`preview: true` = 新插的这一格**就是**预览格
     * (一片叶最多一格,所以它顶掉原来那一格的标记 —— 那一格于是转正,而这正是
     * 「预览格旁边再开一格预览」说不通的原因:预览位只有一个座)。
     */
    const nextPreview = preview
      ? index
      : previewAfterInsert(previewIndexOf(leaf), index)
    return withPreview({ ...leaf, tabs, active }, nextPreview)
  })
}

/** 摘掉一格。**不 prune** —— 剪不剪由调用方决定(store 要先看是不是最后一片)。 */
export function removeTab(node: PaneNode, leafId: string, index: number): PaneNode {
  return mapLeaf(node, leafId, (leaf) => {
    if (index < 0 || index >= leaf.tabs.length) return leaf
    const tabs = leaf.tabs.filter((_, i) => i !== index)
    /*
     * 关掉活动那一条之后停在**同一个下标**(也就是右边那一条顶上来),
     * 关掉最后一条时退一格 —— 与所有编辑器一致。关掉活动**之前**的那一条时
     * 活动跟着往前挪一格,屏幕上不换内容。
     */
    const active = clampActive(tabs, leaf.active > index ? leaf.active - 1 : leaf.active)
    /*
     * **摘掉的恰好是预览格 → 这片叶没有预览格了**(C2)。它顺带把「拖走预览格
     * 就是把它转正」这条路(设计 §4.1 转正之三)变成结构保证:跨叶搬家
     * (`store.moveRefIntoLeaf`)与同叶换序(`tree.moveTab`)都是「摘一格再插
     * 一格」,摘的那一下标记就没了,插的那一下不会再标回来。
     */
    const next = withPreview({ ...leaf, tabs, active }, previewAfterRemove(previewIndexOf(leaf), index))
    // 摘掉的那一格顺带不再钉住(判词在 `pinnedAfterTabs` 上)。
    return withPinned(next, pinnedAfterTabs(leaf, tabs))
  })
}

/**
 * **原位换一格 ref**(W5-b 裁定 1)。同一片叶、同一个下标、活动格不动 ——
 * 换的只是「这一格代表谁」。
 *
 * ── 它为什么不是「摘一格 + 插一格」的语法糖 ──────────────────────────────
 * 两条,都可见:
 *  · **下标**:`removeTab` + `insertTab` 会把它插到**末位**,屏幕上那一格当场
 *    换位子;换会话这件事不该让标签跳到最右边;
 *  · **叶的身份**:那一格是这片叶里唯一一格时,`removeTab` 之后 store 那条路
 *    会把空叶 `prune` 掉,再插进来就是**另一片叶**(新的 leaf id)——
 *    整片叶连同它的兄弟一起重挂,「第一条消息发出去,整台聊天区闪一下」正是
 *    这么来的。零重挂断言(用例 `replaceRef 不重挂`)守的就是这一条。
 *
 * `to` 已经在这片叶的别处 = **合并**:摘掉 `from` 那一格,活动落到 `to` 上
 * (两格同名的 tab 是 `refId` 撞车,树上不许有)。`from` 不在这片叶 = 恒等。
 */
export function replaceRef(
  node: PaneNode,
  leafId: string,
  from: ContentRef,
  to: ContentRef,
): PaneNode {
  return mapLeaf(node, leafId, (leaf) => {
    const at = indexOfRef(leaf, from)
    if (at < 0) return leaf
    if (sameRef(from, to)) return leaf
    const already = indexOfRef(leaf, to)
    if (already >= 0) {
      const tabs = leaf.tabs.filter((_, i) => i !== at)
      const active = clampActive(tabs, already > at ? already - 1 : already)
      // 合并那一支**真的少了一格**,所以预览标记按「摘掉第 at 格」重算(C2),
      // 钉住名单同理少掉那一格(C3)。
      const merged = withPreview({ ...leaf, tabs, active }, previewAfterRemove(previewIndexOf(leaf), at))
      return withPinned(merged, pinnedAfterTabs(leaf, tabs))
    }
    const tabs = [...leaf.tabs]
    tabs[at] = to
    /*
     * 原位换那一支**格数没变**,所以预览标记一个字不动 —— 那正是「预览格里原来
     * 那条被换掉」(设计 §4.1)成立的地方:换的是这一格代表谁,它还是预览格。
     *
     * 钉住那一格**不跟着换**(C3):名单记的是 `refId`,而这一格代表的已经是
     * 另一份内容 —— 换进来的那一份没被谁钉过。旧的那个 id 由 `pinnedAfterTabs`
     * 当场落掉,不留残渣。
     */
    return withPinned({ ...leaf, tabs }, pinnedAfterTabs(leaf, tabs))
  })
}

/**
 * **同一份内容换个写法**:整棵树里每一格 `from` 原位换成 `to`,钉住跟着走(09-24)。
 *
 * ── 它与 `replaceRef` 差在哪一句 ─────────────────────────────────────────
 * `replaceRef` 说的是「这一格**换了一份内容**」(列表里点另一条会话):换进来的
 * 那一份没被谁钉过,所以钉住落掉。这一只说的是「**还是那一份**,只是名字的写法
 * 变了」—— 今天唯一的调用方是 `dir:~/x` → `dir:/Users/me/x`(判词在
 * `content/files/HomeRootResolver.tsx`):用户钉住的是那个目录,不是那串字,
 * 所以钉住名单里那个 id 原位改写,不落掉。
 *
 * 范围是**每一片叶**(同一个目录可以在两片叶里各开一棵,各换各的);下标、活动格、
 * 预览标记全由 `replaceRef` 那一句保证不动。`from` 哪儿都没有 = 引用恒等。
 */
export function rekeyRef(node: PaneNode, from: ContentRef, to: ContentRef): PaneNode {
  if (sameRef(from, to)) return node
  const fromId = refId(from)
  const toId = refId(to)
  let next = node
  for (const leaf of leavesOf(node)) {
    if (indexOfRef(leaf, from) < 0) continue
    const pinned = Array.isArray(leaf.pinned) && leaf.pinned.includes(fromId)
      ? [...new Set(leaf.pinned.map((id) => (id === fromId ? toId : id)))]
      : null
    next = replaceRef(next, leaf.id, from, to)
    if (pinned) {
      next = mapLeaf(next, leaf.id, (after) =>
        withPinned(after, pinnedAfterTabs({ ...after, pinned }, after.tabs)),
      )
    }
  }
  return next
}

/** 换活动 tab。 */
export function activate(node: PaneNode, leafId: string, index: number): PaneNode {
  return mapLeaf(node, leafId, (leaf) => {
    const next = clampActive(leaf.tabs, index)
    return next === leaf.active ? leaf : { ...leaf, active: next }
  })
}

/** 在两片叶之间搬一个 tab。同叶内搬 = 排序。 */
export function moveTab(
  node: PaneNode,
  from: { leafId: string; index: number },
  to: { leafId: string; at?: number },
): PaneNode {
  const source = findLeaf(node, from.leafId)
  const ref = source?.tabs[from.index]
  if (!ref) return node
  const lifted = removeTab(node, from.leafId, from.index)
  /*
   * 同一片叶里搬:摘掉之后目标下标要跟着往前收一格(经典的 splice 双动作坑)。
   */
  const at =
    to.at !== undefined && from.leafId === to.leafId && to.at > from.index ? to.at - 1 : to.at
  return insertTab(lifted, to.leafId, ref, { at, activate: true })
}

/**
 * **拆开一格复合标签**(W7-t / B7 收尾;设计 §6:「左格顶回原位、右格插在它后面、
 * 活动格不动」)。这一个**树变换只有这一个产地**。
 *
 * ── 为什么它得是一只纯函数,而不是 store 里那两句 ────────────────────────
 * 「拆开之后这棵树长什么样」有**两个**读者:真拆(`store.unpairAt`,它还要顺手
 * 把那格 pair 的分栏比例从账上删掉)与**只读的预演**(`drop-commit.canClosePairSide`
 * —— 格头那颗 ✕ 画不画要在渲染里答,一个字都不许落到 store 上)。09-06 审查逮到
 * 的账正是这一条:那时预演在 `drop-commit` 里手抄了同样两句 `T.replaceRef` +
 * `T.insertTab`,于是同一个形状有两处产地 —— 改一处漏一处的下场是那颗 ✕ 按下去
 * 做的事与它画出来时预演的不是同一件。
 *
 * **它只搬结构,不记账**:`pairRatios` 那本账是 store 的(树不知道有这本账),
 * 所以 `store.unpairAt` 仍旧自己 `delete` 那一格比例。
 *
 * 摊开那一句是**种类自述**(`partsOfContent` 问的是登记表),所以这只文件照旧
 * 一个种类名都不认识 —— 它只知道「有些内容自述得出自己由哪几格组成」。
 *
 * **拆不动就交回同一个引用**:那一格不是复合的 / 下标越界 / 叶不在 —— 三种都
 * 原样返回 `node`。调用方因此可以拿引用恒等当「什么都没换」的判据(`store.unpairAt`
 * 的早退、`drop-commit` 那几句「引用恒等就不播报」读的都是这一条)。
 */
export function unpair(node: PaneNode, leafId: string, index: number): PaneNode {
  const tab = findLeaf(node, leafId)?.tabs[index]
  if (!tab) return node
  const parts = partsOfContent(tab)
  if (!parts || parts.length < 2) return node
  const swapped = replaceRef(node, leafId, tab, parts[0])
  return insertTab(swapped, leafId, parts[1], { at: index + 1, activate: false })
}

/**
 * 切一片叶。`before: true` = 新叶排在原叶**前面**(向上 / 向左分)。
 * `ref` 缺席 = 把原叶的活动 tab 搬过去(「把这一格拉到旁边」)。
 */
export function splitLeaf(
  node: PaneNode,
  leafId: string,
  dir: 'row' | 'col',
  newLeafId: string,
  newSplitId: string,
  ref: ContentRef | null,
  opts: { before?: boolean; ratio?: number } = {},
): PaneNode {
  const leaf = findLeaf(node, leafId)
  if (!leaf) return node
  const moved = ref ?? leaf.tabs[leaf.active] ?? null
  if (!moved) return node
  // 从原叶里搬走那一格(点名了 ref 的话是复制一份开新的,不搬)。
  const trimmed = ref
    ? node
    : removeTab(node, leafId, leaf.active)
  const kept = findLeaf(trimmed, leafId)
  // 搬走之后原叶空了 = 这一次分屏没有意义(等于什么都没做)。
  if (!kept || kept.tabs.length === 0) return node
  const fresh = makeLeaf(newLeafId, [moved], 0)
  const split: PaneSplitNode = {
    kind: 'split',
    id: newSplitId,
    dir,
    ratio: opts.ratio ?? DEFAULT_SPLIT_RATIO,
    a: opts.before ? fresh : kept,
    b: opts.before ? kept : fresh,
  }
  return replaceLeaf(trimmed, leafId, split)
}

/**
 * **把一棵树折成一片叶**(W6-a,设计 `workbench-tabs-2026-09.md` §2.1 / §10)。
 *
 * 中央区不再是任意深度的拼贴树,而是**一条标签列表**;这只纯函数就是那条政策
 * 的全部算术:所有叶按**阅读序**(`leavesOf` 的序)把标签接成一条,叶 id 取
 * 第一片的(于是「留下来的那一片不重挂」照旧成立),活动格取第一片的活动格,
 * **比例整个丢掉**(树上不再有 split 节点,`--pr-*` 那几格变量自然无人再读)。
 *
 * ── 它为什么在这里,而不是在 store 里 ────────────────────────────────────
 * 「折成一片」是一句关于**树形**的话,与区域无关;哪个区域要执行这条政策是
 * store 的事(今天只有中央区)。放在这里,迁移那一遍(`persist-migrate`)与
 * 运行期那一遍(`normalizeRegions`)读的是同一句算术 —— 两处各写一遍的下场
 * 是存量档案折出来的顺序与运行期折出来的不一样。
 *
 * **引用恒等**:本来就是一片叶时原样交回(它是每一次 normalize 都要跑的一句)。
 */
export function foldLeaves(node: PaneNode): PaneLeafNode {
  if (node.kind === 'leaf') return node
  const leaves = leavesOf(node)
  const first = leaves[0]
  const tabs = leaves.flatMap((leaf) => leaf.tabs)
  /*
   * **预览标记只留第一片那一格**(C2)。第一片的标签排在最前,所以它的下标折完
   * 还指着同一格;后面几片的**转正**——一片叶最多一格预览位,折成一片之后那几格
   * 抢同一个座,而「谁抢到」不是一句说得出理由的话。折叶是一次结构级的归一
   * (persist v3 与 `normalizeRegions` 各跑一遍),让它把那几格一并转正是诚实的。
   */
  const folded: PaneLeafNode = { kind: 'leaf', id: first.id, tabs, active: clampActive(tabs, first.active) }
  return withPreview(folded, previewIndexOf(first))
}

export function setRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.kind === 'leaf') return node
  if (node.id === splitId) return node.ratio === ratio ? node : { ...node, ratio }
  const a = setRatio(node.a, splitId, ratio)
  const b = setRatio(node.b, splitId, ratio)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

/**
 * 剪枝:空叶剪掉,split 只剩一支就把那一支提上来。
 * 整棵树都空了回 `null` —— 「空了怎么办」由 store 决定(见文件头)。
 */
export function prune(node: PaneNode): PaneNode | null {
  if (node.kind === 'leaf') return node.tabs.length === 0 ? null : node
  const a = prune(node.a)
  const b = prune(node.b)
  if (!a) return b
  if (!b) return a
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

/* ── 座位:把几格连坐标摘下来、再原样放回去 ─────────────────────────────── */

/**
 * **一格内容此刻坐在哪**(区域 + 叶 + 叶内位次)。
 *
 * 它是**两条路共用的一种坐标**:伴随面按会话收放(C3,`./companions.ts`)与全局瓦
 * 按人携带(S1,下面那两只)问的是同一句话 —— 「这几格在哪儿,把它们摘下来,
 * 再原样放回另一份 regions 里」。所以摘与放两件只有**一个产地**,住在这只文件里
 * (纯函数、不认识任何一种内容);两条路各自的**判据**(收谁、什么时候收)留在
 * 各自那儿,那才是它们真正不同的地方。
 *
 * `CompanionSeat` 是它的别名(那份坐标要落盘,名字跟着它的账走)。
 */
export interface PaneSeat {
  readonly ref: ContentRef
  readonly region: RegionId
  readonly leafId: string
  readonly index: number
}

/**
 * **把这些格从树上摘掉**。
 *
 * 摘的次序是**每片叶内下标从大到小** —— 逐格从小往大摘会让后面那些的下标一路
 * 往前塌,摘的就成了别人。
 *
 * **不 prune**:剪不剪由调用方决定(中央区那棵永远至少一片叶,而那句话住在 store)。
 * 一格都没摘到时原样交回同一份 regions(引用恒等)。
 */
export function withoutSeats(
  regions: Readonly<Record<string, PaneNode>>,
  seats: readonly PaneSeat[],
): Record<string, PaneNode> {
  if (seats.length === 0) return regions as Record<string, PaneNode>
  const out: Record<string, PaneNode> = { ...regions }
  const byRegion = new Map<string, PaneSeat[]>()
  for (const seat of seats) {
    const rows = byRegion.get(seat.region) ?? []
    rows.push(seat)
    byRegion.set(seat.region, rows)
  }
  for (const [region, rows] of byRegion) {
    let tree = out[region]
    if (!tree) continue
    for (const seat of [...rows].sort((a, b) => b.index - a.index)) {
      tree = removeTab(tree, seat.leafId, seat.index)
    }
    out[region] = tree
  }
  return out
}

/**
 * **按坐标逐格放回**,并把 `activeId` 那一格点亮(`null` = 谁都不点)。
 *
 * 四条判据:
 *  · **同一格只放一份**:这份内容已经在树上就跳过 —— 一个内容在一个区域里只出现
 *    一次是不变量,而两条会话记着同一棵目录树是常态;
 *  · **原区域原位次**:`insertTab` 自己会把下标钳进范围;
 *  · **叶没了 → 落到同区域第一片叶末尾**(dock-scope §2.3「同名区域存在就 append
 *    到那片叶」/ session-continuity §3.3);
 *  · **区域没了 → 当场建回来**(关掉一扇浮窗之后再切回来,它该回到一扇浮窗里,
 *    而不是凭空掉进中央区)。叶 id 由调用方铸(`makeLeafId`)—— 这只文件是纯的,
 *    而那台计数器有它自己的寿命(`./ids.ts`)。
 *
 * **不碰焦点叶**。一格都没放时原样交回同一份 regions(引用恒等)。
 */
export function withSeats(
  regions: Readonly<Record<string, PaneNode>>,
  seats: readonly PaneSeat[],
  activeId: ContentRefId | null,
  makeLeafId: () => string,
): Record<string, PaneNode> {
  if (seats.length === 0) return regions as Record<string, PaneNode>
  let changed = false
  const out: Record<string, PaneNode> = { ...regions }
  // 位次小的先插:后面那些的落点是按**放回之后**那张表说的。
  for (const seat of [...seats].sort((a, b) => a.index - b.index)) {
    const id = refId(seat.ref)
    if (locateSeatIn(out, id)) continue
    const tree = out[seat.region] ?? makeLeaf(makeLeafId())
    const leaf = findLeaf(tree, seat.leafId) ?? leavesOf(tree)[0]
    if (!leaf) continue
    const at = leaf.id === seat.leafId ? seat.index : undefined
    // `activate: false` —— 放回来不该顺手把每一片叶露脸的那一格换掉;
    // 该点亮的只有 `activeId` 那一格,下面统一点一次。
    out[seat.region] = insertTab(tree, leaf.id, seat.ref, { at, activate: false })
    changed = true
  }
  if (!changed) return regions as Record<string, PaneNode>
  if (activeId) {
    const at = locateSeatIn(out, activeId)
    if (at) out[at.region] = activate(out[at.region], at.leafId, at.index)
  }
  return out
}

/**
 * 这个 refId 此刻在哪一格。**顶层标签**那一层就够了(收放的都是顶层那一格;
 * 复合标签里面那一侧由复合自己持有)。
 */
export function locateSeatIn(
  regions: Readonly<Record<string, PaneNode>>,
  id: ContentRefId,
): { region: string; leafId: string; index: number } | null {
  for (const region of regionsInReadOrder(regions)) {
    const tree = regions[region]
    if (!tree) continue
    const at = locateRef(tree, region as RegionId, id)
    if (at) return { region, leafId: at.leafId, index: at.index }
  }
  return null
}

/* ── 层级:剥离与携带(S1,正本 `docs/dock-scope-2026-09.md` §2.3)─────────── */

/**
 * **这一层的格此刻坐在哪几处**,按阅读序。判据只经 `kinds.residencyLevelOf` ——
 * 所以这一族三只函数里一个种类名、一个瓦名都不出现。
 */
function seatsAtLevel(
  regions: Readonly<Record<string, PaneNode>>,
  level: ResidencyLevel,
): PaneSeat[] {
  const seats: PaneSeat[] = []
  for (const region of regionsInReadOrder(regions)) {
    const tree = regions[region]
    if (!tree) continue
    for (const leaf of leavesOf(tree)) {
      leaf.tabs.forEach((ref, index) => {
        if (residencyLevelOf(ref) !== level) return
        seats.push({ ref, region: region as RegionId, leafId: leaf.id, index })
      })
    }
  }
  return seats
}

/**
 * **剥**:把这一层的格从这份 regions 里全部摘掉。
 *
 * 换空间那一拍它作用在**进场**那棵树上:账上那几格 app 级的是**上一次离场时留下
 * 的旧影**,真正该在场的那一份此刻还在离场的活树里。不先剥就会有两份。
 *
 * **不 prune**(与 `withoutSeats` 同一条):剪空叶、保中央区那句话住在 store。
 * 一格都没剥到时原样交回同一份 regions。
 */
export function stripByLevel(
  regions: Readonly<Record<string, PaneNode>>,
  level: ResidencyLevel,
): Record<string, PaneNode> {
  return withoutSeats(regions, seatsAtLevel(regions, level))
}

/**
 * **携带**:把离场那棵树上这一层的格,连区域坐标一起放进进场那棵树。
 *
 * `to` 必须**已经剥干净**(调用方先 `stripByLevel`)—— 两件分开是因为它们是两条
 * 独立的判据,而合成一只之后「开机不剥」那一条就没有地方表达了:开机根本不走
 * 携带这条路(`swapSpace` 只在真有离场方时才跑,判词在 `workspace/per-space.ts`)。
 *
 * 落位规则整件在 `withSeats` 上(同名区域 append、叶没了落第一片叶、区域没了建回来)。
 * **不点亮任何一格**:携带不是「打开」,进场那棵树里每片叶露脸的是谁不该被它改写
 * (焦点同理不搬 —— dock-scope §2.5)。
 */
export function carryByLevel(
  from: Readonly<Record<string, PaneNode>>,
  to: Readonly<Record<string, PaneNode>>,
  level: ResidencyLevel,
  makeLeafId: () => string,
): Record<string, PaneNode> {
  return withSeats(to, seatsAtLevel(from, level), null, makeLeafId)
}

/* ── 存量档案的入口闸 ──────────────────────────────────────────────────── */

export interface SanitizeOptions {
  /**
   * **这一格今天还认得出吗**。认不得的 tab **整格丢掉**(见下)。
   *
   * 2026-09-13 从 `(kind: string)` 放宽成 `(ref)`:从前它只问得出「这**一种**还在
   * 不在」,而一块退役的瓦(模型服务并进设置页)留下的 `panel:providers` 种类还在、
   * 没了的是那**一个 key**。判据仍然是种类自述的
   * (`kinds.isKnownContent` = 表上有这一种 ∧ 那一种认得这一个),这只文件照旧
   * 一个种类名都不出现。
   */
  known(ref: ContentRef): boolean
  /** 这一格是不是单例。单例的同一个 refId 在整棵树上只留第一格。 */
  singleton(ref: ContentRef): boolean
  /**
   * **这一格背后那个东西还在吗**(第三口,W5-b 裁定 5)。缺席 = 一律当还在。
   *
   * ── 它为什么是**宿主注入**,不是种类自述 ─────────────────────────────
   * `known` / `singleton` 问的是**同步答得出**的那一层(注册表 + 种类自述,
   * 与时间无关 —— `known` 2026-09-13 放宽到按 ref 问,答案仍旧全在表上);
   * 这一口问的是**这一个**——「`session:abc` 那条会话被删了没有」,而答案住在
   * 会话列表那本账上,列表到了才有判据。种类自己去问数据源 = 树的入口闸依赖
   * 一次网络往返,那正是「merge 是同步的、第一帧画的就是这个布局」要避开的。
   *
   * 所以它由**发起清洗的那一拍**递进来(列表首达 / `onSessionsRemoved`),
   * 平时那三处入口(merge / seed / 换装)一律不给 —— 那时列表还没到,
   * 给了就会把整棵树洗空。判词与两个发起点写在 `content/session-projection.ts`。
   */
  alive?(ref: ContentRef): boolean
}

/**
 * **把一份来路不明的树洗成一棵能渲染的树**(裁定:merge 时对整棵树跑幂等
 * `prune + 未知 kind 剔除`)。
 *
 * 它治的是三件真会发生的事:
 *  ① **认不出的那一格**:插件卸载了 / 版本回退了,档案里留着 `terminal:` 的 tab;
 *    或者种类还在、**那一个**没了(一块退役的瓦留下的 `panel:providers`,
 *    2026-09-13)。两种都是渲染时查不到东西,`renderContent` 答 null,而 tab 条上
 *    会留一格点不开的标签。剔掉整格是唯一诚实的处理。
 *  ② **单例重复**:两片叶里各有一个 `panel:files` —— 单例的定义就是不许这样,
 *    留第一格。
 *  ③ **结构烂了**:活动下标越界、空叶、只剩一支的 split、ratio 是 NaN。
 *  ④ **背后那个东西没了**(W5-b):一条被删掉的会话在树上留着一格 tab ——
 *    只有递了 `alive` 的那一拍问这一句(判词写在 `SanitizeOptions.alive` 上)。
 *
 * **幂等**:洗过一遍的树再洗一遍交回同一个对象(用例钉着)。
 */
export function sanitize(node: PaneNode | null | undefined, opts: SanitizeOptions): PaneNode | null {
  if (!isPaneNode(node)) return null
  const seen = new Set<ContentRefId>()
  const cleaned = scrub(node, opts, seen)
  return cleaned ? prune(cleaned) : null
}

function scrub(node: PaneNode, opts: SanitizeOptions, seen: Set<ContentRefId>): PaneNode | null {
  if (node.kind === 'leaf') {
    /*
     * **留下来的那几格原本在第几**(C2)。清洗是一次逐格过滤,而预览标记是一个
     * 下标 —— 不跟着重算的话,洗掉一格死会话之后那格斜体会落到隔壁头上。
     * 记原下标而不是「减掉几个」是因为被滤掉的可能在它两边都有。
     */
    const kept: number[] = []
    const tabs = node.tabs.filter((tab, at) => {
      const ok = (() => {
        if (!opts.known(tab)) return false
        // 背后那个东西没了(被删掉的会话)= 这一格整个丢掉。缺席 = 不问。
        if (opts.alive && !opts.alive(tab)) return false
        if (!opts.singleton(tab)) return true
        const id = refId(tab)
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })()
      if (ok) kept.push(at)
      return ok
    })
    const active = clampActive(tabs, node.active)
    /*
     * 预览格自己被洗掉 = 没有预览格(`indexOf` 答 -1 → undefined)。
     * **这里也是那格数值的入口闸**:`previewIndexOf` 先把越界 / 非整数拦下,
     * 所以一份手改过的档案带进来的垃圾在这一遍就没了。
     */
    const wasPreview = previewIndexOf(node)
    const at = wasPreview === undefined ? -1 : kept.indexOf(wasPreview)
    const nextPreview = at >= 0 ? at : undefined
    if (
      tabs.length === node.tabs.length
      && active === node.active
      && nextPreview === node.previewIndex
    ) return node
    return withPreview({ ...node, tabs, active }, nextPreview)
  }
  const a = scrub(node.a, opts, seen)
  const b = scrub(node.b, opts, seen)
  const ratio = Number.isFinite(node.ratio) ? Math.min(90, Math.max(10, node.ratio)) : DEFAULT_SPLIT_RATIO
  if (!a) return b
  if (!b) return a
  if (a === node.a && b === node.b && ratio === node.ratio) return node
  return { ...node, a, b, ratio }
}

/** 形状闸:落盘的 JSON 可能是任何东西(手改过、版本对不上、被截断)。 */
function isPaneNode(value: unknown): value is PaneNode {
  if (!value || typeof value !== 'object') return false
  const node = value as Partial<PaneNode>
  if (node.kind === 'leaf') {
    const leaf = value as Partial<PaneLeafNode>
    /*
     * 存量档案里那一格 `preview` **不判也不留**:形状闸只问「今天这只类型要的
     * 那几格在不在」,多出来的键由 persist v3 的迁移抹掉(判词在
     * `persist-migrate.ts`)。在这里判它等于让一份 v2 档案在迁移之前就被判非法,
     * 而 merge 里这一遍恰恰跑在迁移之后 —— 那时它已经不在了。
     */
    return (
      typeof leaf.id === 'string'
      && Array.isArray(leaf.tabs)
      && leaf.tabs.every(isContentRef)
      && typeof leaf.active === 'number'
    )
  }
  if (node.kind === 'split') {
    const split = value as Partial<PaneSplitNode>
    return (
      typeof split.id === 'string'
      && (split.dir === 'row' || split.dir === 'col')
      && typeof split.ratio === 'number'
      && isPaneNode(split.a)
      && isPaneNode(split.b)
    )
  }
  return false
}

function isContentRef(value: unknown): value is ContentRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Partial<ContentRef>
  return typeof ref.kind === 'string' && typeof ref.key === 'string' && ref.kind.length > 0
}

import { refId, sameRef } from './kinds'
import type { ContentRef, ContentRefId } from './kinds'
import type { RegionId } from './regions'

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
  /** 这片叶里那个**预览 tab** 的 refId(§2.1);null = 没有预览 tab。 */
  preview: ContentRefId | null
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

export function makeLeaf(
  id: string,
  tabs: ContentRef[] = [],
  active = 0,
  preview: ContentRefId | null = null,
): PaneLeafNode {
  return { kind: 'leaf', id, tabs, active, preview }
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
 * `preview: true` = **预览 tab**(§2.1 拍点 ①):一片叶至多一个 —— 已经有一个的话
 * **就地替换**它(不是再插一个),这就是「浏览一棵树时单击十个文件不该留下十个 tab」
 * 那条判据的全部实现。已经开着同一个 ref 时不重复插,只激活。
 */
export function insertTab(
  node: PaneNode,
  leafId: string,
  ref: ContentRef,
  opts: { preview?: boolean; at?: number; activate?: boolean } = {},
): PaneNode {
  const { preview = false, at, activate = true } = opts
  return mapLeaf(node, leafId, (leaf) => {
    const already = indexOfRef(leaf, ref)
    if (already >= 0) {
      // 已经在这片叶里 —— 只激活。**预览格不动**:再点一次同一个预览 tab
      // 不该把它固定下来(固定要靠 ↵ / 编辑 / 「保留」那三条明确的手势)。
      if (leaf.active === already) return leaf
      return { ...leaf, active: already }
    }
    const previewAt = leaf.preview === null ? -1 : leaf.tabs.findIndex((t) => refId(t) === leaf.preview)
    if (preview && previewAt >= 0) {
      // 替换既有的预览 tab —— 位置不变,于是屏幕上那一格不跳。
      const tabs = [...leaf.tabs]
      tabs[previewAt] = ref
      return { ...leaf, tabs, preview: refId(ref), active: activate ? previewAt : clampActive(tabs, leaf.active) }
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
    const nextPreview = preview
      ? refId(ref)
      : leaf.preview
    return { ...leaf, tabs, active, preview: nextPreview }
  })
}

/** 摘掉一格。**不 prune** —— 剪不剪由调用方决定(store 要先看是不是最后一片)。 */
export function removeTab(node: PaneNode, leafId: string, index: number): PaneNode {
  return mapLeaf(node, leafId, (leaf) => {
    if (index < 0 || index >= leaf.tabs.length) return leaf
    const gone = leaf.tabs[index]
    const tabs = leaf.tabs.filter((_, i) => i !== index)
    /*
     * 关掉活动那一条之后停在**同一个下标**(也就是右边那一条顶上来),
     * 关掉最后一条时退一格 —— 与所有编辑器一致。关掉活动**之前**的那一条时
     * 活动跟着往前挪一格,屏幕上不换内容。
     */
    const active = clampActive(tabs, leaf.active > index ? leaf.active - 1 : leaf.active)
    const preview = leaf.preview !== null && leaf.preview === refId(gone) ? null : leaf.preview
    return { ...leaf, tabs, active, preview }
  })
}

/** 固定预览 tab(§2.1 的「保留」)。不是预览的就是恒等变换。 */
export function pinTab(node: PaneNode, leafId: string, index: number): PaneNode {
  return mapLeaf(node, leafId, (leaf) => {
    const tab = leaf.tabs[index]
    if (!tab || leaf.preview === null || leaf.preview !== refId(tab)) return leaf
    return { ...leaf, preview: null }
  })
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
  const pinned = source.preview !== null && source.preview === refId(ref)
  const lifted = removeTab(node, from.leafId, from.index)
  /*
   * 同一片叶里搬:摘掉之后目标下标要跟着往前收一格(经典的 splice 双动作坑)。
   */
  const at =
    to.at !== undefined && from.leafId === to.leafId && to.at > from.index ? to.at - 1 : to.at
  return insertTab(lifted, to.leafId, ref, { at, preview: pinned, activate: true })
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
  const fresh = makeLeaf(newLeafId, [moved], 0, null)
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

/* ── 存量档案的入口闸 ──────────────────────────────────────────────────── */

export interface SanitizeOptions {
  /** 认不认得这个种类名。认不得的 tab **整格丢掉**(见下)。 */
  known(kind: string): boolean
  /** 这个种类是不是单例。单例的同一个 refId 在整棵树上只留第一格。 */
  singleton(kind: string): boolean
}

/**
 * **把一份来路不明的树洗成一棵能渲染的树**(裁定:merge 时对整棵树跑幂等
 * `prune + 未知 kind 剔除`)。
 *
 * 它治的是三件真会发生的事:
 *  ① **未知种类**:插件卸载了 / 版本回退了,档案里留着 `terminal:` 的 tab ——
 *    渲染时查不到表,今天的 `renderContent` 会答 null,而 tab 条上会留一格
 *    点不开的标签。剔掉整格是唯一诚实的处理。
 *  ② **单例重复**:两片叶里各有一个 `panel:files` —— 单例的定义就是不许这样,
 *    留第一格。
 *  ③ **结构烂了**:活动下标越界、预览指着一个已经不在的 refId、空叶、
 *    只剩一支的 split、ratio 是 NaN。
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
    const tabs = node.tabs.filter((tab) => {
      if (!opts.known(tab.kind)) return false
      if (!opts.singleton(tab.kind)) return true
      const id = refId(tab)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    const active = clampActive(tabs, node.active)
    const preview =
      node.preview !== null && tabs.some((tab) => refId(tab) === node.preview) ? node.preview : null
    if (tabs.length === node.tabs.length && active === node.active && preview === node.preview) {
      return node
    }
    return { ...node, tabs, active, preview }
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
    return (
      typeof leaf.id === 'string'
      && Array.isArray(leaf.tabs)
      && leaf.tabs.every(isContentRef)
      && typeof leaf.active === 'number'
      && (leaf.preview === null || typeof leaf.preview === 'string')
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

import { leavesOf } from './tree'
import type { PaneLeafNode, PaneNode } from './tree'

/**
 * **把一棵拼贴树摊成一层**(W1)。
 *
 * ── 为什么不是递归渲染 ──────────────────────────────────────────────────
 * 递归渲染(`split` 画两个孩子 + 一条杆)读起来最省,但它把**零重挂**那条铁律
 * 违反得彻底:一次分屏会让留下来的那片叶多两层 DOM 祖先(`PaneSplit` → `.side`),
 * 而 React 的协调是按**位置**认组件的 —— 祖先链一变,那棵子树整个卸载再挂一遍。
 * 真机后果不是抽象的:中央区第一片叶装的是聊天,它一重挂就丢滚动位、
 * 重跑一次进场落底、`chat-source.open()` 再走一遍 —— **每分一次屏都闪一下**。
 *
 * 所以每一片叶都是**同一个容器的直接孩子**,位置靠绝对定位。树的形状怎么变,
 * 叶在 React 树里的位置都不动(key = 叶 id),于是「分屏 / 关叶 / 剪枝」
 * 只改一格 style。这也正是 W1-b 顶栏标签组要的东西:每片叶的左右界是算出来的,
 * 不必再去量 DOM。
 *
 * ── 几何是**字符串**,不是数字 ──────────────────────────────────────────
 * 每一次切分的比例住在一格无单位 CSS 变量里(`--pr-<splitId>`),叶的
 * left/top/width/height 是一串 `calc()` 表达式,把路径上每一格比例乘进去。
 * 于是**拖拽期间一帧都不经过 React**:杆把实时值写进根上那格变量
 * (`ui/Splitter` 的 `liveVar` + `liveTarget`),所有依赖它的格子由浏览器一起重排
 * —— 与 `FilesPanel` 那条分栏逐字同一手,只是从一格变量推广到一棵树。
 *
 * 这只文件是**纯函数**:没有 React、没有 DOM、没有内容种类名。
 */

/** 一块矩形,四个边都是 CSS 长度表达式(已经包好 `calc()`)。 */
export interface PaneBox {
  left: string
  top: string
  width: string
  height: string
}

export interface LeafSlot {
  leaf: PaneLeafNode
  box: PaneBox
}

export interface SeamSlot {
  /** 这一次切分的 id(CSS 变量名与 `setSplitRatio` 都按它)。 */
  id: string
  dir: 'row' | 'col'
  ratio: number
  /** **这一次切分自己那块地**(杆按它算比例:比例是相对这一次切分的,不是相对整棵树)。 */
  box: PaneBox
  /** 杆本身坐在哪儿 —— 那条缝的位置(一条细带子)。 */
  seam: { left: string; top: string; length: string }
}

export interface PaneLayout {
  leaves: LeafSlot[]
  seams: SeamSlot[]
}

/** 这一次切分的比例变量名。**唯一产地** —— 渲染层与杆都从这里取。 */
export const ratioVar = (splitId: string): string => `--pr-${splitId}`

/* ── 表达式:一串没有 `calc()` 外壳的算术,末了才包一次 ──────────────────── */

/** `a + b` */
const add = (a: string, b: string) => `(${a} + ${b})`
/** `a - b` */
const sub = (a: string, b: string) => `(${a} - ${b})`
/** 一段长度乘上某个比例的百分之几。`f` 是一格无单位变量(0–100)。 */
const scale = (len: string, f: string) => `(${len} * ${f} / 100)`

/** 这一次切分那格比例的读法(缺省 50 —— 变量还没写上去的第一帧)。 */
const frac = (splitId: string) => `var(${ratioVar(splitId)}, 50)`

const box = (left: string, top: string, width: string, height: string): PaneBox => ({
  left: `calc(${left})`,
  top: `calc(${top})`,
  width: `calc(${width})`,
  height: `calc(${height})`,
})

interface RawBox {
  left: string
  top: string
  width: string
  height: string
}

const ROOT: RawBox = { left: '0%', top: '0%', width: '100%', height: '100%' }

/**
 * 摊平。叶按**阅读序**(左→右 / 上→下)出,与 `tree.leavesOf` 同一个序 ——
 * W1-b 顶栏标签组的分组次序读的就是它。
 */
export function layoutTree(node: PaneNode): PaneLayout {
  const out: PaneLayout = { leaves: [], seams: [] }
  walk(node, ROOT, out)
  return out
}

function walk(node: PaneNode, rect: RawBox, out: PaneLayout): void {
  if (node.kind === 'leaf') {
    out.leaves.push({ leaf: node, box: box(rect.left, rect.top, rect.width, rect.height) })
    return
  }
  const f = frac(node.id)
  if (node.dir === 'row') {
    const firstW = scale(rect.width, f)
    const seamX = add(rect.left, firstW)
    walk(node.a, { ...rect, width: firstW }, out)
    walk(node.b, { ...rect, left: seamX, width: sub(rect.width, firstW) }, out)
    out.seams.push({
      id: node.id,
      dir: node.dir,
      ratio: node.ratio,
      box: box(rect.left, rect.top, rect.width, rect.height),
      seam: { left: `calc(${seamX})`, top: `calc(${rect.top})`, length: `calc(${rect.height})` },
    })
    return
  }
  const firstH = scale(rect.height, f)
  const seamY = add(rect.top, firstH)
  walk(node.a, { ...rect, height: firstH }, out)
  walk(node.b, { ...rect, top: seamY, height: sub(rect.height, firstH) }, out)
  out.seams.push({
    id: node.id,
    dir: node.dir,
    ratio: node.ratio,
    box: box(rect.left, rect.top, rect.width, rect.height),
    seam: { left: `calc(${rect.left})`, top: `calc(${seamY})`, length: `calc(${rect.width})` },
  })
}

/**
 * 每一次切分的比例,摊成一张「变量名 → 值」的表(写在根上一次)。
 *
 * 它与 `layoutTree` 分开,是因为**这两件事的寿命不一样**:表达式只在树的形状
 * 变了之后才需要重算,而这张表每次比例一动就变(拖拽落定时)。
 */
export function ratioVars(node: PaneNode): Record<string, string> {
  const out: Record<string, string> = {}
  collectRatios(node, out)
  return out
}

function collectRatios(node: PaneNode, out: Record<string, string>): void {
  if (node.kind === 'leaf') return
  out[ratioVar(node.id)] = `${node.ratio}`
  collectRatios(node.a, out)
  collectRatios(node.b, out)
}

/** 这棵树里有几片叶(焦点边画不画的判据)。 */
export const leafCount = (node: PaneNode): number => leavesOf(node).length

/* ── 顶栏标签组的落位(W1-b,设计 §2.2「中央区的檐就是窗口顶栏」)────────────
 *
 * 顶栏上**一片叶一组标签,各坐各叶的正上方**。这里只回答两件纯结构的事:
 * 「这一组跟着哪个节点的盒走」与「同一段宽度里第几个 / 一共几个」——一次
 * `getBoundingClientRect()` 都不做。真正的像素由 `leaf-geometry.ts` 量出来写进
 * 两格 CSS 变量,组用 `calc()` 读;于是**拖分隔杆的那几十帧一帧都不经过 React**
 * (与本文件头上那条 `liveVar` 判据同源)。
 *
 * ── 为什么「跟着谁的盒」不总是叶自己 ──────────────────────────────────────
 * 上下切分的两片叶**横向重叠**:它们的正上方是同一段宽度。设计原话是「就把那一段
 * 宽度按序平分」。所以这里按「共用同一段横向跨度」把叶分组:
 *   · 叶        一组一片,跨度就是它自己;
 *   · row 切分  左右分家 —— 两边各自成组,拼接,序 = 左到右;
 *   · col 切分  上下重叠 —— 两边并成**一组**,跨度是这次切分自己那块地,
 *               组里按阅读序(上、下)平分。
 *
 * `col` 那一并只在**两边各自恰好一组**时是精确的。一旦某一边自己还含着一次
 * `row` 切分(`col(叶1, row(叶2, 叶3))`),三片叶的横向区间两两不等,「精确坐在
 * 正上方」在一条直线上无解 —— 那时退成「这次切分整块地,按阅读序平分」:
 * **宁可几组都略偏,也不许两组在顶栏上叠在一起**(叠上去 = 标签互相盖住,
 * 比偏一点严重得多)。留账:W4 若真出现三层嵌套的常用形,再谈。
 */

/** 一片叶在顶栏上的那一组标签。 */
export interface TopStripSlot {
  leafId: string
  /** 这一组的横向跨度由哪个节点的盒说了算(叶 id 或切分 id)。 */
  spanId: string
  /** 这一段宽度里的第几个(0 起)。 */
  index: number
  /** 这一段宽度一共分给几组。 */
  count: number
}

/** 一段横向跨度,以及共用它的那几片叶(阅读序)。 */
interface SpanGroup {
  spanId: string
  leafIds: string[]
}

/** 顶栏上从左到右的那几组标签。**纯函数**,所以平分那条规则钉得住。 */
/**
 * **中央区的标签条画在顶栏上吗**(09-24,用户拍「分屏后每格自带标签条」)。
 *
 * 中央区只有一片叶 = 顶栏画(W1-b 那条用户原话「把标签放到红绿灯那一栏上」照旧成立);
 * 中央区一旦分屏 = 每一片叶像架子上的叶一样,在自己顶上画一条,顶栏那一带只剩红绿灯与
 * 尾格。从前「中央区的檐在顶栏」是写死的,靠单叶政策保证它只有一组;单叶政策 09-24 撤了
 * (主区也能拖出分屏),而顶栏上排几组、每组对准哪片叶正是 W7-c 为了性能删掉的那条路 ——
 * 所以多叶那一形不回顶栏。合回一片叶,标签自动回到顶栏。
 *
 * 判据**只有这一处**:`TopBarLeafTabs` / `TopBarLeafActions` 问它要不要画,`PaneLeaf`
 * 问它要不要在叶身上画,两边读同一句话,不可能一边画了另一边也画。
 */
export function centerStripOnTopBar(tree: PaneNode | undefined): boolean {
  return !tree || tree.kind === 'leaf'
}

export function topStrips(node: PaneNode): TopStripSlot[] {
  const out: TopStripSlot[] = []
  for (const group of spanGroups(node)) {
    group.leafIds.forEach((leafId, index) => {
      out.push({ leafId, spanId: group.spanId, index, count: group.leafIds.length })
    })
  }
  return out
}

function spanGroups(node: PaneNode): SpanGroup[] {
  if (node.kind === 'leaf') return [{ spanId: node.id, leafIds: [node.id] }]
  const a = spanGroups(node.a)
  const b = spanGroups(node.b)
  // 左右分家:两边各自成组,序就是左到右。
  if (node.dir === 'row') return [...a, ...b]
  // 上下重叠:两边并成一组,跨度是这次切分自己那块地。
  if (a.length === 1 && b.length === 1) {
    return [{ spanId: node.id, leafIds: [...a[0].leafIds, ...b[0].leafIds] }]
  }
  // 退化形(某一边自己还含着一次左右切分):整块地按序平分,宁偏勿叠。
  return [{ spanId: node.id, leafIds: leavesOf(node).map((leaf) => leaf.id) }]
}

/* ── 跨度那两格 CSS 变量 **W7-c 整条退役** ────────────────────────────────
 * `spanXVar` / `spanWVar` / `workbench/leaf-geometry.ts` / `data-pane-span` 是
 * 「顶栏的标签组精确坐在它那片叶的正上方」那条规则的全部机械(W1-b)。v3 把中央区
 * 收成一条标签条之后那条规则没有对象了(裁定 1:标签从顶栏自己的开头排),这几件
 * 随之零消费者 —— 而它同时是 `gate:perf` ⑤a 第 4 次强制排版的来源。
 * `topStrips` 交出的 `spanId` / `index` / `count` 留着:它们描述的是**树的形状**,
 * 与谁来消费无关。 */

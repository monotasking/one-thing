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

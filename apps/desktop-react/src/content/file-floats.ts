import { useCallback, useState } from 'react'
import { DETAIL_POPOVER_GAP } from './FileDetailPopover'

/**
 * **一个文件的两层浮层开在哪儿**(09-02 批 9b 立件)。
 *
 * ── 为什么它是一件而不是两份 ────────────────────────────────────────────
 * 「一个文件能做什么」全仓只有一份定义(`FileActionsMenu`,09-01 动作单产地
 * 裁定),「一个文件长什么样」也只有一份(`FileDetailPopover`)。可是**这两块
 * 内容各自开在哪一点**,在树面(`content/FilesPanel`)与查看器
 * (`content/viewer/FileViewer`)里从前是各写一遍的:两个 `useState<Anchor>`、
 * 两条右键判据、两处 `+ DETAIL_POPOVER_GAP` 的算式。内容共用而锚点各写,
 * 结果就是「同一张菜单在两块面里贴的位置不一样」——而那不是设计,是抄漏。
 *
 * 于是这里收的是**那两格状态 + 那一条锚点算式**,别的一概不收:
 *  · 浮层**画什么**   → 还是 `FileActionsMenu` / `FileDetailPopover` 自己;
 *  · 浮层**怎么关**(Esc 认领 / 点外关)与**怎么跟滚** → 还是 `ui/float`
 *    (09-01 库自审立法:浮层行为单产地)。这件一个字都不碰那三件事,
 *    它只回答「开在哪一点」。
 *
 * ── 两档锚(与 `ui/float` 的定位两档同名同义)──────────────────────────
 *   指针事件  → **点锚**:光标那一点就是落点,不加缝。右键菜单走这一档
 *              (点锚不跟滚 —— 那条裁定在 `ui/float`,这里只是把落点算对)。
 *   元素矩    → **矩锚**:贴着那块矩的左下角,隔一条 `DETAIL_POPOVER_GAP`。
 *              行尾 ⋯、以及从一层浮层里长出下一层时走这一档。
 *   已算好的点 → 当作一块零高的矩:同样隔一条缝往下长。
 *
 * ── 三张状态表(状态先行)────────────────────────────────────────────────
 *  ① 生命周期:纯 `useState`,无订阅、无计时器、无模块级副作用 —— 所以
 *     **不需要 HMR dispose**(判据:这东西的寿命是不是「这个模块实例」——
 *     不是,它的寿命是调用它的那个组件)。宿主换落点导致组件重挂时,
 *     两格锚点归零 = 浮层收起,这是对的:那两块浮层贴的是**屏幕坐标**,
 *     换了宿主之后原来那一点已经不指向任何东西了。
 *  ② UI 生命状态:两格各自只有 **关(null) / 开(一个点)** 两态。没有
 *     loading —— 详情那块内容自己有它的载入态(`useFileDetail`),
 *     而「开在哪儿」这件事是同步算出来的。
 *  ③ UI 交互状态:无。它不画任何东西,所以没有 rest/hover/focus/disabled。
 *
 * ── 留给 9d 的一格(FilesPanel 收编时要拍的板)──────────────────────────
 * 今天两面有一处**真的不一样**:从右键菜单里点「详情」时,查看器把详情
 * 往下挪一条缝(`menuAt.y + DETAIL_POPOVER_GAP`),而树面直接复用菜单那一点
 * (`openDetailFor(menu.row, menu.at)`,不加缝)。本批**保住查看器今天的
 * 行为**(9b 是拆分批,逐像素零差是它的验收条件),所以 `openDetailAt` 这一口
 * 一律隔一条缝。9d 把树面迁进来时要拍的正是这一格:是让树面也隔一条缝
 * (两面从此一致,代价是树面详情下移 4px),还是承认这是两种用法。
 * 别默默地把其中一面改了 —— 那是用户可感知的位置变化。
 */

/** 一处浮层的落点(视口坐标)。菜单与详情浮层共用这一个形状。 */
export interface Anchor {
  x: number
  y: number
}

/**
 * 浮层从哪儿长出来。三种来源各自的算法写在 `anchorAtPointer` / `anchorBelow`,
 * 判别靠形状而不是靠调用方多传一个 `kind` —— 多一格入参就是多一处可以填错的地方。
 */
export interface PointerLike {
  readonly clientX: number
  readonly clientY: number
}

export type FloatOrigin = PointerLike | DOMRect | Anchor | null | undefined

function isPointerLike(origin: NonNullable<FloatOrigin>): origin is PointerLike {
  return 'clientX' in origin
}

function isRectLike(origin: NonNullable<FloatOrigin>): origin is DOMRect {
  return 'bottom' in origin
}

/** 点锚:光标那一点**就是**落点,不加缝(右键菜单)。 */
export function anchorAtPointer(event: { clientX: number; clientY: number }): Anchor {
  return { x: event.clientX, y: event.clientY }
}

/**
 * 矩锚:贴着这块矩的左下角,隔一条 `DETAIL_POPOVER_GAP` 长出来 ——
 * 浮层是那个元素的**附属**,不是屏幕中央的一块东西。
 *
 * 取不到矩时落在 `(0, GAP)`:与迁移前那两面逐字相同(`rect?.left ?? 0`)。
 * 这不是兜底策略而是**如实**——元素不在文档里的时候没有「它下面」这个位置,
 * 编个屏幕中央出来只会让人以为浮层是随机弹的。
 */
export function anchorBelow(origin: FloatOrigin): Anchor {
  if (!origin) return { x: 0, y: DETAIL_POPOVER_GAP }
  if (isRectLike(origin)) return { x: origin.left, y: origin.bottom + DETAIL_POPOVER_GAP }
  if (isPointerLike(origin)) return { x: origin.clientX, y: origin.clientY + DETAIL_POPOVER_GAP }
  return { x: origin.x, y: origin.y + DETAIL_POPOVER_GAP }
}

export interface FileFloats {
  /** 动作菜单开在哪个点(null = 没开)。 */
  menuAt: Anchor | null
  /** 详情浮层贴在哪儿(null = 没开)。 */
  detailAt: Anchor | null
  /** 指针事件 → 点锚;元素矩 / 一个点 → 矩锚(左下角隔一条缝)。 */
  openMenuAt: (origin: FloatOrigin) => void
  /** 详情**永远**隔一条缝长在开它的那件东西下面(留账见文件头最后一节)。 */
  openDetailAt: (origin: FloatOrigin) => void
  closeMenu: () => void
  closeDetail: () => void
}

export function useFileFloats(): FileFloats {
  const [menuAt, setMenuAt] = useState<Anchor | null>(null)
  const [detailAt, setDetailAt] = useState<Anchor | null>(null)

  const openMenuAt = useCallback((origin: FloatOrigin) => {
    setMenuAt(origin && isPointerLike(origin) ? anchorAtPointer(origin) : anchorBelow(origin))
  }, [])
  const openDetailAt = useCallback((origin: FloatOrigin) => {
    setDetailAt(anchorBelow(origin))
  }, [])
  const closeMenu = useCallback(() => setMenuAt(null), [])
  const closeDetail = useCallback(() => setDetailAt(null), [])

  return { menuAt, detailAt, openMenuAt, openDetailAt, closeMenu, closeDetail }
}

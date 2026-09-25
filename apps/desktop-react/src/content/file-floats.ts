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
 * ── 两个宿主,两种落法(09-24 起分家)───────────────────────────────────
 *   查看区  → **点锚**:右键那一下光标在哪,菜单就开在哪(点锚不跟滚 —— 那条裁定
 *            在 `ui/float`);从菜单里开详情,隔一条 `DETAIL_POPOVER_GAP` 往下长。
 *            这两格状态就是下面的 `useFileFloats`。
 *   文件面板 → **开在面板旁边**(`anchorBeside`):锚是那一行,落点是面板左右缘之外。
 *            ⋯ 与右键同一个落点 —— 右键不再锚光标,那一下点在列表上,菜单就还在
 *            列表上。它是活矩形(跟滚),状态由面板自己记(它还要记「哪一行」)。
 *
 * ── 三张状态表(状态先行)────────────────────────────────────────────────
 *  ① 生命周期:纯 `useState` / 纯函数,无订阅、无计时器、无模块级副作用 —— 所以
 *     **不需要 HMR dispose**(判据:这东西的寿命是不是「这个模块实例」——
 *     不是,它的寿命是调用它的那个组件)。宿主换落点导致组件重挂时,
 *     锚点归零 = 浮层收起,这是对的:查看区那两格贴的是**屏幕坐标**,文件面板
 *     那一格的 getter 指着旧宿主里的元素,换了宿主都不再指向任何东西。
 *  ② UI 生命状态:每一格只有 **关(null) / 开** 两态。没有 loading —— 详情那块
 *     内容自己有它的载入态(`useFileDetail`),而「开在哪儿」这件事是同步算出来的。
 *  ③ UI 交互状态:无。它不画任何东西,所以没有 rest/hover/focus/disabled。
 *
 * ── 09-02 批 9d 那一格(「承认两种用法」)随 09-24 作废 ────────────────────
 * 9d 拍的是:树面从菜单开详情不隔缝(菜单自己已经贴着行矩隔过一条),查看区隔一条,
 * 口子是 `openDetailAt` 的 `gap` 格。09-24 文件面板的两层浮层改成「开在面板旁边」,
 * 两层同锚、同一个 `right-start`,「隔几条缝」这个问题在树面上不存在了 ——
 * `gap` 格连同它唯一的非缺省调用点一起删掉,查看区那一档一个字节没动。
 */

/** 一处浮层的落点(视口坐标)。菜单与详情浮层共用这一个形状。 */
export interface Anchor {
  x: number
  y: number
}

/** 一次指针事件里「光标在哪」的那两个数(右键菜单的点锚只要这两个)。 */
export interface PointerLike {
  readonly clientX: number
  readonly clientY: number
}

/** 点锚:光标那一点**就是**落点,不加缝(查看区的右键菜单)。 */
export function anchorAtPointer(event: PointerLike): Anchor {
  return { x: event.clientX, y: event.clientY }
}

/**
 * 从一层浮层长出下一层:贴着那一点往下隔一条 `DETAIL_POPOVER_GAP`(查看区从右键菜单
 * 里开详情)。取不到锚时落在 `(0, GAP)` —— **如实**:没有「它下面」这个位置的时候,
 * 编个屏幕中央出来只会让人以为浮层是随机弹的。
 *
 * 09-24 之前它还收一块元素矩 / 一次指针事件、还有一格 `gap`(树面从菜单开详情传 0)。
 * 那三样的消费者全是文件面板,而文件面板的两层浮层改成了「开在面板旁边」
 * (见下面 `anchorBeside`),于是它们一起删了 —— 不留没人走的支。
 */
export function anchorBelow(origin: Anchor | null | undefined): Anchor {
  if (!origin) return { x: 0, y: DETAIL_POPOVER_GAP }
  return { x: origin.x, y: origin.y + DETAIL_POPOVER_GAP }
}

/**
 * **开在面板旁边**(09-24 报障「不要挡着文件 list,我说了没?」)。
 *
 * 文件面板的行菜单与详情从前贴在行下方 / 光标处,整块压在文件列表上;把「打开方式」
 * 折进二级菜单只是把它变矮,没有让开。裁定是**锚是这一行、落点是面板之外**:
 * 交给 `ui/float` 的 `right-start` 一块**合成矩形** —— 左右缘是面板的(各外扩一格
 * `--sp-1`,浮层与面板之间留一条缝,翻到左边时同样留一条),上下缘是那一行的。
 * 于是 `right-start` 那一支的「右边放不下先翻、两边都放不下才夹」原样作用在面板上,
 * 这里一个坐标都不判(浮层摆哪儿只有 `ui/float` 一个产地)。
 *
 * 交出去的是**活的** getter,不是一次快照:列表滚动时那一行的 `top` 跟着变,
 * `useFloatPosition` 的 rect 档跟滚,浮层随那一行上下走、始终在面板外面;
 * 那一行滚出窗口化的可视窗被卸载时 getter 答 null,浮层**原地不动**(ui/float 纪律③)。
 * `at` 是开那一刻量的一次,只当首帧兜底(`x/y` 那两格)。
 *
 * 缝的读法与 `ui/float` 读安全区同一条:现读根上的 token,jsdom 里读出空串 → 按 0 走。
 *
 *  落点           | 面板右缘之外    | 面板左缘之外     | 结果
 *  ---------------|-----------------|------------------|-------------------------------
 *  左架子         | 放得下          | —                | 右侧(压到中央舞台,不压列表)
 *  中央舞台       | 右边有架子 / 空 | —                | 右侧;右边贴窗时翻左
 *  右架子(钉右) | 放不下(贴窗)  | 放得下           | **翻到左侧**
 *  浮窗贴右       | 放不下          | 放得下           | **翻到左侧**
 *  面板占满全窗   | 放不下          | 放不下           | 退回夹:贴窗右内沿、行的高度
 */
export interface BesideAnchor {
  /** 合成矩形的 getter,交给 `Menu` / `Popover` 的 `anchor`(配 `anchorPlace="right-start"`)。 */
  get: () => DOMRect | null
  /** 开那一刻的落点,只当首帧兜底。 */
  at: Anchor
}

export function anchorBeside(
  panel: () => HTMLElement | null,
  row: () => DOMRect | null,
): BesideAnchor {
  const get = (): DOMRect | null => {
    const el = panel()
    const r = row()
    if (!el || !r) return null
    const p = el.getBoundingClientRect()
    const gap = Number.parseFloat(getComputedStyle(el).getPropertyValue('--sp-1')) || 0
    const left = p.left - gap
    const right = p.right + gap
    const rect = {
      left,
      right,
      top: r.top,
      bottom: r.bottom,
      width: right - left,
      height: r.bottom - r.top,
      x: left,
      y: r.top,
    }
    return { ...rect, toJSON: () => rect }
  }
  const first = get()
  return { get, at: { x: first?.right ?? 0, y: first?.top ?? 0 } }
}

export interface FileFloats {
  /** 动作菜单开在哪个点(null = 没开)。 */
  menuAt: Anchor | null
  /** 详情浮层贴在哪儿(null = 没开)。 */
  detailAt: Anchor | null
  /** 指针事件 → 点锚(光标那一点)。 */
  openMenuAt: (event: PointerLike) => void
  /** 详情隔一条缝长在开它的那一点下面。 */
  openDetailAt: (origin: Anchor | null) => void
  closeMenu: () => void
  closeDetail: () => void
}

export function useFileFloats(): FileFloats {
  const [menuAt, setMenuAt] = useState<Anchor | null>(null)
  const [detailAt, setDetailAt] = useState<Anchor | null>(null)

  const openMenuAt = useCallback((event: PointerLike) => {
    setMenuAt(anchorAtPointer(event))
  }, [])
  const openDetailAt = useCallback((origin: Anchor | null) => {
    setDetailAt(anchorBelow(origin))
  }, [])
  const closeMenu = useCallback(() => setMenuAt(null), [])
  const closeDetail = useCallback(() => setDetailAt(null), [])

  return { menuAt, detailAt, openMenuAt, openDetailAt, closeMenu, closeDetail }
}

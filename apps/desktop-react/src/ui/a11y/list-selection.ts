import { useCallback, useEffect, useRef, useState } from 'react'
import { nextRovingIndex, type RovingAxis } from './roving'

/**
 * 键盘可控选择列表的**唯一状态机**(A11y 线 · 地基件之四)。
 *
 * 立法一句话:**hover 只是 hover,不许影响 select**(09-01 用户裁定)。
 *
 * ── 两个状态,两条产地 ──────────────────────────────────────────────────
 *  · **active**(键盘位):↑↓/Home/End 改它,**显式点击**改它,别的什么都不改它。
 *    ↵ 永远落在 active 上 —— 这是本原语存在的全部理由。
 *  · **hover**(鼠标位):**纯视觉,不进 JS**。它由 CSS 的 `:hover` 画,
 *    鼠标一离开自己就没了,谁也不用去清它。
 *
 * 两态可以同屏:键盘位画 `--st-sel`(accent 底),hover 画 `--st-hover`(淡底),
 * 键盘位被 hover 时画 `--st-sel-hover`。三条配方在消费方自己的样式表里,
 * 本文件不碰样式。
 *
 * ── 为什么 hover 连一个 state 都不给它 ──────────────────────────────────
 * 「二次污染」那格(09-01 立案)说的是这条链:
 *   键盘 ↑↓ → active 变 → `scrollIntoView` 把列表滚一段 → **鼠标一动没动**,
 *   但它脚下换了一行 → 浏览器补一发 `mouseenter` → 如果 mouseenter 写 active,
 *   键盘位当场被拽到鼠标底下那一行。用户看到的是「按 ↓ 一下跳了两行 / 跳回去了」。
 *
 * 常见的修法是给 mouseenter 加一道「鼠标真动过吗」的判据(记最近一次真实
 * `mousemove` 的坐标,enter 时坐标没变 = 合成事件,忽略)。本仓**不用**它,
 * 用更强的那一手:**mouseenter 根本不写 active**。判据要维护、要挑边界
 * (页面加载后鼠标一次没动过、触屏、缩放),而「这条链不存在」不需要维护。
 * 所以 hover 是 CSS 的事,本 hook 一个 mouse 监听都不挂 —— 消费方也不许挂。
 * 执法:`npm run ui:consume` 的 kbd-select 规则(见 scripts/ui-consume-check.mjs)。
 * ──────────────────────────────────────────────────────────────────────
 *
 * ── 它与 useRoving 的分工 ────────────────────────────────────────────────
 * `useRoving` 管的是**焦点真的在项上**那一族(菜单、tab 条、分段器):当前项 =
 * `document.activeElement`,所以它压根没有第二个「选中下标」可被污染。
 * 本 hook 管的是另一族:**焦点留在输入框**,列表只是屏幕上的候选
 * (composer 的 @ / 抽屉、模型抽屉、工作区快切、检索面板)—— 这一族必须自己
 * 记一个下标,于是才有 hover 能污染它这回事。
 * 按键的判据两族同源:都用 `nextRovingIndex`,不另立一张键表。
 * ──────────────────────────────────────────────────────────────────────
 */

/** 夹进 `[0, count-1]`。空表钉 0 —— 让调用方少写一个分支。 */
export function clampListIndex(index: number, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(index, count - 1))
}

/** 走一步。`loop=false` 时到端点就停(抽屉候选),`true` 是循环(命令面板)。 */
export function stepListIndex(index: number, delta: number, count: number, loop: boolean): number {
  if (count <= 0) return 0
  const next = clampListIndex(index, count) + delta
  if (next < 0) return loop ? count - 1 : 0
  if (next >= count) return loop ? 0 : count - 1
  return next
}

export interface ListSelectionOptions {
  /** 当前候选条数。变化时 active 自动夹回范围内。 */
  count: number
  /** 自持档首次挂载的键盘位。后续显式落位仍通过 select。 */
  initialActive?: number
  /** 受控档:外部持有 active(composer 的 pickIndex 在 store 里)。不给就自持。 */
  active?: number
  onActiveChange?: (index: number) => void
  /** 到端点是否绕回。默认 false(停在端点)。 */
  loop?: boolean
  /** 方向轴。默认纵向。 */
  axis?: RovingAxis
  /**
   * Home / End 归不归本原语管。默认 **false** —— 这一族列表的焦点恒在输入框,
   * 而 Home / End 在一个还在编辑的输入框里是「到行首 / 行尾」,是文本编辑的基本盘。
   * 抢走它,代价是搜索词改不动(与 Overview 刻意不接 ←→ 是同一条判例)。
   * 焦点真的落在列表上的场合才传 true。
   */
  homeEnd?: boolean
  /**
   * active 变化时把那一行滚进视野的落点。默认 `'nearest'` —— 已经在视野里的
   * 一动不动,只有真走出去了才滚最短的那一段。传 `null` 关掉(列表不限高时)。
   */
  scrollBlock?: ScrollLogicalPosition | null
}

export interface ListSelection {
  /** 键盘位。已经夹进 `[0, count-1]`,消费方直接画、直接 ↵。 */
  active: number
  /** 键盘走一步。 */
  move: (delta: number) => void
  /** 显式落位:点击选中、换词重置到 0。**不是**给鼠标经过用的。 */
  select: (index: number) => void
  /**
   * 一下按键归不归本原语管。管 → 已经改完 active 并返回 true(调用方按需
   * `preventDefault`);不管 → false,**不要吞掉它**(吞掉不认识的键是
   * 「键盘可达」最常见的反面教材,与 useRoving 同一条纪律)。
   */
  handleKey: (key: string) => boolean
  /** 行 ref 收集器:`ref={sel.rowRef(i)}`。滚入视野靠它认行。 */
  rowRef: (index: number) => (el: HTMLElement | null) => void
}

export function useListSelection(options: ListSelectionOptions): ListSelection {
  const {
    count,
    active: controlled,
    onActiveChange,
    loop = false,
    axis = 'vertical',
    homeEnd = false,
  } = options
  const scrollBlock = options.scrollBlock === undefined ? 'nearest' : options.scrollBlock

  const [own, setOwn] = useState(options.initialActive ?? 0)
  const raw = controlled ?? own
  const active = clampListIndex(raw, count)

  /* 受控档也要有自持的一份:两档共用同一个 setter,免得每个消费现场分叉。 */
  const commit = useCallback(
    (index: number) => {
      if (controlled === undefined) setOwn(index)
      onActiveChange?.(index)
    },
    [controlled, onActiveChange],
  )

  const move = useCallback(
    (delta: number) => {
      commit(stepListIndex(active, delta, count, loop))
    },
    [commit, active, count, loop],
  )

  /*
   * 落位**不夹**,读的时候才夹(上面那句 `active`)。这样 `select` 的身份只跟着
   * commit 走,不跟着 count 走 —— 「换词就回到第一条」那条 effect 才能老老实实
   * 只依赖 query,而不是候选表一变就重跑一次。
   */
  const select = useCallback((index: number) => commit(index), [commit])

  const handleKey = useCallback(
    (key: string) => {
      if (count <= 0) return false
      if (!homeEnd && (key === 'Home' || key === 'End')) return false
      const next = nextRovingIndex(key, active, count, axis, loop)
      if (next === null) return false
      commit(next)
      return true
    },
    [commit, active, count, axis, loop, homeEnd],
  )

  /** 下标 → 行元素。行是按下标画的,所以这张表跟着下标就够了。 */
  const rows = useRef<(HTMLElement | null)[]>([])
  const rowRef = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      rows.current[index] = el
    },
    [],
  )

  useEffect(() => {
    if (scrollBlock === null) return
    // `?.` 两处都是真的:候选换了一批的那一帧 refs 还是上一份,而 jsdom 里
    // scrollIntoView 是 test/setup.ts 补的空实现 —— 两边都不该让一次选中崩掉列表。
    rows.current[active]?.scrollIntoView?.({ block: scrollBlock })
  }, [active, count, scrollBlock])

  return { active, move, select, handleKey, rowRef }
}

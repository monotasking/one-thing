import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * roving tabindex(A11y 线 · A1 地基件之二)。立法见
 * `docs/design/react-shell-a11y-2026-08.md` 的第一律「键盘可达」。
 *
 * 规矩一句话:**一组控件在 Tab 序里只占一个位子,组内用方向键走**。
 * 菜单十项、tab 条八页、分段器三段 —— 如果每一项都进 Tab 序,用户按 Tab
 * 要按二十下才走得出这一行。APG 对 menu / tablist / radiogroup 三种模式
 * 给的都是同一句:容器进 Tab 序,组内方向键。
 *
 * 实现分两半,好让判据本身能被单测钉住:
 *  · `nextRovingIndex` 是**纯函数** —— 按键 + 当前位 + 总数 + 轴向 → 新位;
 *  · `useRoving` 是它的 DOM 外衣 —— 同步 tabIndex、听 keydown、移焦点。
 *
 * ── 谁是「当前项」 ──────────────────────────────────────────────────────
 * 每次渲染后重新判,优先级三档:
 *  ① 焦点正落在组内某一项上 → 就是它(方向键走完之后靠这一档保持住);
 *  ② 有项声明 `aria-selected="true"` / `aria-checked="true"` → 就是它
 *     (Tabs / Segmented / 单选菜单:Tab 进来该落在选中的那一项上);
 *  ③ 都没有 → 第一项(菜单这类无选中态的)。
 * ──────────────────────────────────────────────────────────────────────
 *
 * ── 它**不**做什么 ──────────────────────────────────────────────────────
 *  · 不替谁做选中:方向键只移**焦点**。「移到就选中」(APG 的自动激活)是
 *    组件自己的语义,要的话在自己的 onFocus 里做 —— 本批一个组件都没这么改,
 *    交互语义守恒。
 *  · 不管 Enter / Space:那两下由原生 `<button>` 白送(项一律是真按钮)。
 *  · 不管 Esc:同 focus-trap,关不关是浮层自己的事。
 * ──────────────────────────────────────────────────────────────────────
 */

/** 方向轴。菜单是纵,tab 条 / 分段器是横,网格状的用 both。 */
export type RovingAxis = 'horizontal' | 'vertical' | 'both'

/** 组内项的默认判据。组件在项上贴 `data-roving-item` 即入组。 */
export const ROVING_ITEM_SELECTOR = '[data-roving-item]'

/**
 * 纯判据:这一下按键把「当前位」挪到哪。
 *
 * 返回 `null` = 这个键不归 roving 管(调用方不要 preventDefault,让它照常冒泡 ——
 * 吞掉不认识的键是「键盘可达」最常见的反面教材)。
 */
export function nextRovingIndex(
  key: string,
  current: number,
  count: number,
  axis: RovingAxis = 'vertical',
  loop = true,
): number | null {
  if (count <= 0) return null
  const step = (delta: number): number => {
    const next = current + delta
    if (next < 0) return loop ? count - 1 : 0
    if (next >= count) return loop ? 0 : count - 1
    return next
  }
  const horizontal = axis === 'horizontal' || axis === 'both'
  const vertical = axis === 'vertical' || axis === 'both'
  switch (key) {
    case 'ArrowRight':
      return horizontal ? step(1) : null
    case 'ArrowLeft':
      return horizontal ? step(-1) : null
    case 'ArrowDown':
      return vertical ? step(1) : null
    case 'ArrowUp':
      return vertical ? step(-1) : null
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

export interface RovingOptions {
  axis?: RovingAxis
  loop?: boolean
  /** 组内项的选择器。默认 `[data-roving-item]`。 */
  itemSelector?: string
  /** false 时这个 hook 什么都不做(浮层没开的时候不该抢键)。 */
  active?: boolean
}

function itemsOf(container: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
  )
}

function currentIndexOf(items: HTMLElement[]): number {
  const active = typeof document === 'undefined' ? null : document.activeElement
  const focused = items.findIndex((el) => el === active)
  if (focused >= 0) return focused
  const selected = items.findIndex(
    (el) => el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true',
  )
  return selected >= 0 ? selected : 0
}

/**
 * `useRoving(ref, { axis })` —— 把 ref 指的容器变成一个 roving 组。
 *
 * 每次渲染后同步一遍 tabIndex(项的增减、选中态的变化都要跟上),
 * 并在容器上听 keydown。没有依赖数组是刻意的:这一趟是几次 querySelectorAll +
 * 几次属性写,比起判「要不要重跑」的那套簿记便宜得多。
 */
export function useRoving(ref: RefObject<HTMLElement | null>, options: RovingOptions = {}): void {
  const { axis = 'vertical', loop = true, itemSelector = ROVING_ITEM_SELECTOR, active = true } = options

  useEffect(() => {
    const container = ref.current
    if (!container || !active) return
    const items = itemsOf(container, itemSelector)
    const current = currentIndexOf(items)
    items.forEach((el, i) => {
      el.tabIndex = i === current ? 0 : -1
    })

    const onKeyDown = (e: KeyboardEvent) => {
      const list = itemsOf(container, itemSelector)
      if (list.length === 0) return
      const here = currentIndexOf(list)
      const stepped = nextRovingIndex(e.key, here, list.length, axis, loop)
      if (stepped === null) return
      /*
       * 焦点还停在容器身上(浮层刚开出来那一刻就是这个状态):第一下方向键
       * 落到**当前项本身**,不是从它再往前走一步。不这么判的话,菜单一开、
       * 按一下 ↓,焦点直接跳过首项落到第二项 —— 首项永远要绕一圈才到得了。
       * Home / End 不吃这条豁免:它们说的是「到端点」,与从哪儿出发无关。
       */
      const insideList = list.some((el) => el === document.activeElement)
      const isEndpointKey = e.key === 'Home' || e.key === 'End'
      const next = !insideList && !isEndpointKey ? here : stepped
      e.preventDefault()
      list.forEach((el, i) => {
        el.tabIndex = i === next ? 0 : -1
      })
      list[next].focus()
    }

    container.addEventListener('keydown', onKeyDown)
    return () => container.removeEventListener('keydown', onKeyDown)
  })
}

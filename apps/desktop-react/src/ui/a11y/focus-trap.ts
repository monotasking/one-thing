import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * 焦点圈禁(A11y 线 · A1 地基件之一)。立法见
 * `docs/design/react-shell-a11y-2026-08.md` 的第二律「焦点可见且永不丢失」。
 *
 * 它只做三件事,一件都不多:
 *  ① **开启时记住锚点** —— 开这扇浮层之前焦点在哪个元素上;
 *  ② **Tab / Shift+Tab 圈禁在容器内** —— 走到末尾回到开头,反之亦然;
 *  ③ **关闭时把焦点还给锚点** —— 还得回去才算「没丢」。
 *
 * ── 为什么手写而不是引一个库 ────────────────────────────────────────────
 * 现成的 focus trap 库要处理 iframe、shadow DOM、`inert`、可滚动容器里的
 * 隐藏项……那些边界这台上一个都不存在(浮层就三种:Dialog / Menu / 浮窗,
 * 全在同一个文档、同一棵树里)。运行时零新依赖是本批的硬约束,而这件东西
 * 的本体是四十行 —— 引一个库进来换的是四十行,赔的是一个我们不掌握的依赖。
 * ──────────────────────────────────────────────────────────────────────
 *
 * ── 它**不**做什么 ──────────────────────────────────────────────────────
 *  · 不监听 Esc:关不关是浮层自己的语义(Dialog 关、Menu 关、抽屉可能不关),
 *    trap 只管「开着的时候焦点出不去」。Esc 归各组件自己那一行。
 *  · 不设 `aria-modal` / `inert`:那是**语义**,归组件;trap 只管键盘路径。
 *  · 不管点击 —— 鼠标点到浮层外面是宿主的事(Menu 有「点外关」,Dialog 有遮罩)。
 * ──────────────────────────────────────────────────────────────────────
 */

/**
 * 可聚焦元素的判据。`[tabindex="-1"]` **不在**表里:它是「可编程聚焦、不进 Tab 序」,
 * 而这张表回答的正是「按 Tab 会停在哪」。
 */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * 容器里**当前**进得了 Tab 序的元素,按文档序。
 *
 * 过滤只看「声明上的隐藏」(display/visibility/hidden/aria-hidden),**不看排版**:
 * `offsetParent` / `getClientRects()` 在 jsdom 里对每个元素都是空的,拿它们过滤
 * 会让所有单测里的容器都变成「一个可聚焦元素都没有」。真机上多算进来的那一类
 * (被祖先裁掉但仍在流里的元素)本来也应该进 Tab 序 —— 少算才是 bug。
 */
export function focusablesIn(container: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const el of Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))) {
    if (el.hasAttribute('hidden')) continue
    if (el.getAttribute('aria-hidden') === 'true') continue
    if (el.closest('[aria-hidden="true"]')) continue
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : undefined
    if (style && (style.display === 'none' || style.visibility === 'hidden')) continue
    out.push(el)
  }
  return out
}

export interface FocusTrapOptions {
  /**
   * 开启瞬间焦点落在哪。
   *  · `'container'`(默认)—— 落在容器本身(容器要有 `tabIndex={-1}`)。
   *    这是 APG 对话框模式允许的落点,也是本台既有 Dialog 的行为,**不改**。
   *  · `'first'` —— 落在第一个可聚焦元素上。
   */
  initialFocus?: 'container' | 'first'
}

/**
 * `useFocusTrap(ref, active)` —— 开着的时候 Tab 出不去,关掉的时候焦点回原处。
 *
 * `active` 从 false 变 true 的那一刻记锚点;从 true 变 false(或组件卸载)时还焦点。
 * 锚点如果已经不在文档里(比如触发它的按钮随浮层一起卸载了),就什么都不做 ——
 * 强行 focus 一个游离节点只会让焦点落到 `<body>` 上,那不叫还。
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  options: FocusTrapOptions = {},
): void {
  const { initialFocus = 'container' } = options
  // 锚点存在 ref 里而不是 state:它变了不该引起重渲染,而且要活过整个开启期。
  const anchor = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return

    const previous = document.activeElement
    anchor.current = previous instanceof HTMLElement ? previous : null

    const items = focusablesIn(container)
    if (initialFocus === 'first' && items.length > 0) items[0].focus()
    else container.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const list = focusablesIn(container)
      if (list.length === 0) {
        // 一个可聚焦元素都没有(比如只有一段说明文字的对话框):Tab 原地不动,
        // 焦点留在容器上。让它走出去等于把用户丢到浮层后面那一屏上。
        e.preventDefault()
        container.focus()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const current = document.activeElement
      const inside = current instanceof Node && container.contains(current)
      // 焦点停在容器自己身上(刚开启那一刻就是这个状态)算「在首项之前」:
      // 往前一步进首项、往后一步进末项 —— 与浏览器对 tabindex=-1 容器的原生行为一致。
      const atContainer = current === container
      if (e.shiftKey) {
        if (!inside || atContainer || current === first) {
          e.preventDefault()
          last.focus()
        }
        return
      }
      if (!inside || atContainer || current === last) {
        e.preventDefault()
        first.focus()
      }
    }

    // 挂在 document 上而不是容器上:焦点万一已经跑到容器外面(浏览器把它落到
    // body 上是常态),挂容器就再也收不到这一下 Tab,圈禁当场失效。
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const back = anchor.current
      anchor.current = null
      if (back && back.isConnected) back.focus()
    }
  }, [ref, active, initialFocus])
}

/**
 * **模态的 Tab 圈禁**(§4.1 `modal` 那一行的内置行为)。
 *
 * 这两段是从 `ui/a11y/focus-trap.ts` **原样搬过来**的(R0 不改那只文件 ——
 * 它今天还在给 Dialog 供圈禁与锚点归还,R1 才退役锚点半边)。搬而不引的理由:
 * `focus-trap` 那只 hook 的形状是「装一个 document 监听 + 记一个锚点」,而树里
 * 需要的只是**判据**——「按 Tab 该停在哪」——由那一个派发器现问现答,不再多一个
 * 监听器。等 R1 里 Dialog / Menu / Popover / Palette 全改成 `modal` 作用域,
 * `focus-trap` 整只退役,这里就是它唯一的遗骨。
 *
 * 与那边逐字相同的两条判据(连注释一起搬,免得下一个人以为可以简化):
 *  · `[tabindex="-1"]` **不在**可聚焦表里:它是「可编程聚焦、不进 Tab 序」,
 *    而这张表回答的正是「按 Tab 会停在哪」;
 *  · 过滤只看**声明上的隐藏**(display/visibility/hidden/aria-hidden),不看排版 ——
 *    `offsetParent` / `getClientRects()` 在 jsdom 里对每个元素都是空的,拿它们
 *    过滤会让所有单测里的容器都变成「一个可聚焦元素都没有」。
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

/** 容器里**当前**进得了 Tab 序的元素,按文档序。 */
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

/**
 * 一下 Tab 落在圈禁里的哪儿。**答的是元素,不是动作** —— 真正 focus 是调用方
 * (派发器)的事,而它是否真搬焦点由 `FocusTree.policy.moveFocus` 闸着。
 *
 * `null` = 这一下不归圈禁管(自然往下走)。
 * 焦点停在容器自己身上(刚开启那一刻)算「在首项之前」:往前一步进首项、
 * 往后一步进末项 —— 与浏览器对 `tabindex=-1` 容器的原生行为一致。
 * 一个可聚焦元素都没有的容器(只有一段说明文字的对话框):Tab 原地不动,
 * 焦点留在容器上;让它走出去等于把用户丢到浮层后面那一屏上。
 */
export function tabStopWithin(
  container: HTMLElement,
  active: Element | null,
  shiftKey: boolean,
): HTMLElement | null {
  const list = focusablesIn(container)
  if (list.length === 0) return container
  const first = list[0]
  const last = list[list.length - 1]
  const inside = active instanceof Node && container.contains(active)
  const atContainer = active === container
  if (shiftKey) {
    if (!inside || atContainer || active === first) return last
    return null
  }
  if (!inside || atContainer || active === last) return first
  return null
}

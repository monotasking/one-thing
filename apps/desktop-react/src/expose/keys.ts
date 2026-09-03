import { nextRovingIndex } from '../ui/a11y/roving'

/**
 * **键名判据的单产地**(方向 A §3.2 那道禁令的落点)。
 *
 * 全壳的规矩:方向键在一个文件里出现,那个文件必须消费 `ui/a11y` 的原语
 * (`ui-consume-check.mjs` 的 `kbd-select-handwritten`)。这块面的活动行不走
 * roving —— 焦点留在树容器上、活动行由 `aria-activedescendant` 指着(树的 APG
 * 模式),所以真正能复用的是那只原语的**步进判据**而不是它的 DOM 外衣:
 * `nextRovingIndex` 在这里以 `loop=false` 被调用,于是「到头就停不回绕」与菜单
 * 那边的「到头回绕」共用同一份算术,不各写一遍加一减一。
 *
 * 于是键名字面量全仓只出现在这只文件里:`ExposeView` 与将来的 `SessionTree`
 * 拿到的是**意图**(`ExposeIntent`),不是 `e.key`。换一套键位 = 改这张表。
 */

/**
 * 这块面认识的八种意图。**它不含 Esc** —— 退层是响应链的事
 * (`FocusScope onEscape`),不是列表的键;也不含 ⌘⇧P,那是一条**面域局部键**
 * (`FOCUS_SCOPES.expose.keys` 的 `pin.toggle`),由作用域表声明、由树路由。
 */
export type ExposeIntent =
  | 'move-up'
  | 'move-down'
  | 'expand'
  | 'collapse'
  | 'home'
  | 'end'
  | 'enter'
  | 'quicklook'

/**
 * `KeyboardEvent.key` → 意图。不认识的键回 `null`,调用方据此**不要**
 * `preventDefault` —— 吞掉不认识的键是「键盘可达」最常见的反面教材。
 *
 * ←→ 在这里是 `collapse` / `expand` 而不是「左右走一格」:树上的横向是**层级**
 * (展开 / 收起 / 进子 / 回父,§3.2),不是走位。语义的分岔在名字上就分完了,
 * 消费者不必再判一次「现在这一下是走位还是展开」。
 */
export function exposeIntentOf(key: string): ExposeIntent | null {
  switch (key) {
    case 'ArrowUp':
      return 'move-up'
    case 'ArrowDown':
      return 'move-down'
    case 'ArrowRight':
      return 'expand'
    case 'ArrowLeft':
      return 'collapse'
    case 'Home':
      return 'home'
    case 'End':
      return 'end'
    case 'Enter':
      return 'enter'
    case ' ':
      return 'quicklook'
    default:
      return null
  }
}

/** 这个意图走的是纵向序列吗(↑↓ / Home / End)。横向那两个是层级,不走序列。 */
const SEQUENCE_KEY: Partial<Record<ExposeIntent, string>> = {
  'move-up': 'ArrowUp',
  'move-down': 'ArrowDown',
  home: 'Home',
  end: 'End',
}

/**
 * 活动行的下一个下标。**到头就停,不回绕**(`loop = false`)——
 * 与 Quick Look 的 ‹ › 同一个边界口径,免得两种键有两种直觉。
 *
 * `current = -1`(还没落焦)时任何一下都落到序列首:`nextRovingIndex` 在
 * 不回绕档下把越界夹回边界,`-1 - 1` 与 `-1 + 1` 都收在 0 —— 这正是从前
 * `moveFocus` 里那句「还没落焦时先把焦点放到序列首」,现在由原语承担。
 *
 * 不归序列管的意图(展开 / 收起 / 进入 / 预览)回 `null`。
 */
export function stepRowIndex(
  intent: ExposeIntent,
  current: number,
  count: number,
): number | null {
  const key = SEQUENCE_KEY[intent]
  if (!key) return null
  return nextRovingIndex(key, current, count, 'vertical', false)
}

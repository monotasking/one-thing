import { nextRovingIndex } from '../ui/a11y/roving'

/**
 * **键名判据的单产地**(检索面终稿 附录 B §1「纯模型」那一行)。
 *
 * 照 `src/expose/keys.ts` 的体例:面板拿到的是**意图**(`SearchIntent`),
 * 不是 `e.key`。换一套键位 = 改这张表。
 *
 * ── 走位算术不在这里 ────────────────────────────────────────────────────
 * 这块面的焦点**恒在输入框**,列表是屏上的候选,活动项由
 * `ui/a11y/list-selection` 的 `handleKey` 算 —— 全壳唯一那份「加一减一夹范围」。
 * 所以这里只回答「这一下是不是走位」,一步都不自己走:`move` 那一格由消费方
 * 原样交回 `selection.handleKey(e.key)`。
 *
 * 「这一下是不是走位」这句话本身也**问原语**,不自己列一遍方向键的名字:
 * `nextRovingIndex(key, …, 'vertical', …)` 认得它就是走位,不认得就不是 ——
 * ←→ 因此天然不归这块面管(输入框里那是光标左右移动),而不是靠这里再写一条
 * 「记得别接左右」的注释。
 */

/**
 * 这块面认识的五种意图。
 *
 * **不含 Esc**:它不认领(`SearchPanel` 一个字不写),由宿主退层 —— 那是响应链
 * 的事,不是列表的键。**不含 Home / End**:焦点在输入框里,那两下是「到行首 /
 * 行尾」,文本编辑的基本盘(`useListSelection` 的 `homeEnd: false` 是同一条判据的
 * 另一半)。
 */
export type SearchIntent =
  /** Tab / ⇧Tab = **换搜索范围**(这块面里 Tab 不是「把焦点交出去」)。 */
  | 'tab-next'
  | 'tab-prev'
  /** ↵ = 落在活动项上(⏎ 的落点由 `items/registry` 那张表答)。 */
  | 'enter'
  /** 空格 = 输入一个空格(不赋列表语义,拍点 B 保旧)。 */
  | 'space'
  /**
   * ↑ = **回上一条查询,或者往上走一行**。
   *
   * 两种时候是同一下键,判据(输入框空 ∧ 活动项是序列首项 ∧ 走得动历史)由面板
   * 合取 —— 那是三句关于**此刻屏幕**的话,不是关于键名的话。
   */
  | 'history-recall-or-up'
  /** 归纵向序列管的其余那些(↓)。原样交回 `selection.handleKey`。 */
  | 'move'

/**
 * `KeyboardEvent.key`(+ 有没有按 ⇧)→ 意图。
 *
 * 不认识的键回 `null`,调用方据此**不要** `preventDefault` —— 吞掉不认识的键是
 * 「键盘可达」最常见的反面教材(与 `exposeIntentOf` / `useRoving` 同一条纪律)。
 */
export function searchIntentOf(key: string, shift = false): SearchIntent | null {
  if (key === 'Tab') return shift ? 'tab-prev' : 'tab-next'
  if (key === 'Enter') return 'enter'
  if (key === ' ') return 'space'
  if (key === 'ArrowUp') return 'history-recall-or-up'
  // Home / End 不接:输入框里那是光标移动(`homeEnd: false` 的另一半)。
  if (key === 'Home' || key === 'End') return null
  // 其余归不归纵向序列管,**问原语** —— 走位一步都不在这里走。
  return nextRovingIndex(key, 0, 2, 'vertical', false) === null ? null : 'move'
}

/** 这个意图要不要原样交回 `selection.handleKey`(走位那两格)。 */
export function isSequenceIntent(intent: SearchIntent | null): boolean {
  return intent === 'move' || intent === 'history-recall-or-up'
}

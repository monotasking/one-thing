/**
 * 页内查找的**判据那一半**(B3-a,方案 §6 与 `native-view-protocol.ts` 的
 * `verb: 'find'` 文件头)。
 *
 * 两个纯函数,一个 electron 都不碰:
 *
 *   · `beginsNewFindSession` —— 「这一下是从头重找,还是接着上次往下找」。判据只有
 *     一句:**词变了没有**。它住在主进程这一侧,因为记得上一个词的是这台查找器
 *     本人;让壳报一格 `again` 就是同一个判据两个产地(判词整段在协议那一条上)。
 *   · `foldFoundInPage` —— Chromium 的 `found-in-page` 结果 → 一对读数。
 *
 * ## `found-in-page` 会连着来好几发,而这**不是**要在这里治的事
 *
 * Chromium 对一次 `findInPage` 通常发两发:先是一发 `finalUpdate: false` 的中间
 * 结果(边扫边报),再是一发 `finalUpdate: true` 的定稿。两发的 `matches` 可能不同。
 * 这里**两发都折、两发都推** —— 读数一路长上去正是「它还在数」的诚实形态,
 * 而只等定稿会让人在长页面上看着一格空读数发呆半秒。
 *
 * ## 一处都没有 = `{active: 0, total: 0}`,而不是「上一次那个数」
 *
 * Chromium 在零命中时给 `matches: 0` 且 `activeMatchOrdinal: 0`。原样带出去 ——
 * 终端那一格「找到了却拿不到读数就让读数保持原样」的判词在这里不适用:那边的
 * 空窗是「装饰关掉了所以事件永不来」,这边事件一定来,来了就是真的。
 */

/** `found-in-page` 事件交来的那一份(只认这两格)。 */
export interface FoundInPageResult {
  readonly requestId?: number
  readonly activeMatchOrdinal?: number
  readonly matches?: number
  readonly finalUpdate?: boolean
}

/** 一对读数。`active` 从 **1** 起(Chromium 口径原样);零命中时两格都是 0。 */
export interface BrowserFindReadout {
  readonly active: number
  readonly total: number
}

export const NO_FIND_MATCHES: BrowserFindReadout = { active: 0, total: 0 }

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * 折一发结果。认不出来的载荷 = 零命中(而不是抛):这条事件来自 Chromium,
 * 一次形状对不上不该让主进程炸。
 */
export function foldFoundInPage(result: unknown): BrowserFindReadout {
  if (!result || typeof result !== 'object') return NO_FIND_MATCHES
  const row = result as FoundInPageResult
  const total = count(row.matches)
  if (total === 0) return NO_FIND_MATCHES
  // 总数有、序号没有(Chromium 在中间结果里偶尔这样)——报总数,序号留 0,
  // 让读数那一格自己决定怎么说(壳那边 0 = 「只报总数,不编一个序号」)。
  return { active: Math.min(count(row.activeMatchOrdinal), total), total }
}

/**
 * 这一下要不要**开一段新的查找会话** —— 也就是 `findInPage` 的 `findNext` 那一格。
 *
 * ## 那个标志的名字与它的意思是**反的**,这一段专门为它而写
 *
 * 直觉会把 `findNext: true` 读成「找下一处」。它不是。Electron 的类型定义原话:
 *
 *   > Whether to begin a new text finding session with this request.
 *   > Should be `true` for initial requests, and `false` for follow-up requests.
 *
 * 所以 **`true` = 从头重找一遍(新会话)**,`false` = 接着上一段会话往下走。
 * 第一版把它读反了,`gate:browser` ⑫ 当场判红:第一发查找传了 `findNext: false`
 * (「接着一段并不存在的会话」)→ Chromium 答 `matches: 0`,而同一片视图上主进程
 * 直接再查一次答 1。**这就是这只函数存在、而且带着这段判词的理由** —— 它不是
 * 一句转述,它是一条踩过的坑。
 *
 * 判据本身一句话:**词变了 = 新会话;词一样 = 接着走**。空词永远答 false ——
 * 它根本不该走到 `findInPage`(调用方在空词上发的是 `stopFindInPage`),这里答
 * false 只是为了这只函数自己是全的。
 */
export function beginsNewFindSession(previous: string | undefined, text: string): boolean {
  if (!text) return false
  return previous !== text
}

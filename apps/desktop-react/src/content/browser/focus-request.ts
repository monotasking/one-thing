/**
 * **「这一格是人亲手开出来的,焦点该进去」那张条子**(B2)。
 *
 * ── 为什么不是「摆完之后 `activateScope`」 ──────────────────────────────
 * 试过,真机上落空:`placeRef` 写完 store 之后,那片叶要等 React 的一次渲染 +
 * 提交才存在,而 `focus/after-commit` 的「微任务 + 一帧」够不着它 —— 门里量到的
 * 是焦点仍然停在输入面板上(`{"scope":"composer"}`)。叶还是 `lazy` 进来的,
 * 中间还隔着一次 chunk 解析。
 *
 * 所以走**与终端逐字相同**的那条路(判词在
 * `content/terminal/registry.requestTerminalFocus` 上):开它的人**先留一张条子**,
 * 那片叶挂载时自己取走(一次性),把 `activateOnMount` 翻真。于是「送焦点」这件事
 * 发生在**它自己的挂载那一拍**,不需要外面任何人猜那一拍是什么时候。
 *
 * ── 一次性,而且只认「人亲手开的那一格」 ────────────────────────────────
 * 布局恢复、拖到别的叶、切回来 —— 这些都会让叶重新挂载,而它们**不该**抢焦点
 * (人可能正在别处打字)。条子只在 `openBrowser` / 点名那一路留下,取走即焚。
 */

const REQUESTS = new Set<string>()

/** 留一张条子:这一格开出来之后焦点要进去。 */
export function requestBrowserFocus(tabId: string): void {
  REQUESTS.add(tabId)
}

/** 取走那张条(一次性)。没被点过名就是 false。 */
export function takeBrowserFocusRequest(tabId: string): boolean {
  return REQUESTS.delete(tabId)
}

/** 回到出厂。测试与 HMR 用。 */
export function resetBrowserFocusRequests(): void {
  REQUESTS.clear()
}

if (import.meta.hot) {
  import.meta.hot.dispose(resetBrowserFocusRequests)
}

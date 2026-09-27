/**
 * **一格浏览器 tab「这辈子成功停下来过没有」**(2026-09-26)。
 *
 * `browserBodyPhase`(`content/browser/start-backdrop.ts`)只看得见此刻那一行,而
 * 「有没有过一次 `url && !loading`」是一段历史;从起始页出发的第一次加载要靠它决定
 * 起始页还当不当底。这段历史从前记在 `BrowserLeaf` 的一格 `useRef` 上,而**换宿主是
 * 一次重挂**(`native-view/view-claim.ts` 09-15 真机量到的):把浏览器从浮窗拖进主
 * 面板,叶卸载再挂载,闩归零,页面若还在加载,起始页就以「底」的身份又装了回来 ——
 * 用户报障「搜索、加载时感觉回到了空状态页」。
 *
 * 所以它住在这张按 tabId 的表里,寿命是那片视图不是那次挂载 —— 与 `browser-find.ts`
 * 的查找状态、`browser-notices.ts` 的檐下两件逐字同一条判词;tab 关掉时由
 * `browser-source.ts` 的 `closed` 事实一并忘掉,HMR / 测试走 `resetBrowserSettled`。
 *
 * 它是**单向的闩**:只从「没停过」翻到「停过」,不翻回去(第二次导航由 Chromium
 * 自己留着上一页的画面,壳不必再兜底 —— `start-backdrop.ts` 的 `live` 档)。所以在
 * 渲染里写它是安全的:StrictMode 双跑只是把同一句话说两遍。不发通知、不订阅 ——
 * 读它的那一次渲染正是写它的那一次。
 */

const settled = new Set<string>()

/** 这一格观察到过一次 `url && !loading`。幂等。 */
export function markBrowserTabSettled(tabId: string): void {
  settled.add(tabId)
}

export function hasBrowserTabSettled(tabId: string): boolean {
  return settled.has(tabId)
}

/** tab 关了:这段历史随它走。 */
export function forgetBrowserTabSettled(tabId: string): void {
  settled.delete(tabId)
}

/** 回到出厂。测试与 HMR 用;幂等。 */
export function resetBrowserSettled(): void {
  settled.clear()
}

/*
 * 模块级副作用 = 这个模块实例的寿命(09-01 立法)。复用已有的那一口拆卸,
 * 不写第二套。生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(resetBrowserSettled)
}

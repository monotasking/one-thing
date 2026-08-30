/**
 * 「把光标交给输入框」的**接缝**(D1 开工批)。
 *
 * 它和 `sink.ts` 是同一条缝的两个方向:sink 是输入面板**交出去**一句话,
 * 这里是别处**请它**接管键盘。两件事都不许让两边直接认识对方 ——
 * 建会话那条路(expose/store 的 newSession)不该 import 一个 React 组件的 ref,
 * 输入框也不该知道谁会来叫它。
 *
 * 形状刻意只有一口:**没有 blur**。抢焦点是一次明确的交接(建完会话该打字了),
 * 而「把焦点还回去」在这套壳里从来是别人主动取(总览开场抢搜索条、卡片聚焦),
 * 不需要一个能远程失焦的口子 —— 那种口子只会制造「焦点莫名其妙没了」的报障。
 *
 * 没人登记时是**恒等**:输入框没挂载(还在总览里、或壳刚起来)时叫它一声不是错。
 */

let focusFn: (() => void) | undefined

/** 输入框挂载时登记自己;卸载时传 undefined 摘掉。 */
export function registerComposerFocus(fn: (() => void) | undefined): void {
  focusFn = fn
}

/** 请输入框接管键盘。没人登记 = 什么都不做。 */
export function focusComposer(): void {
  focusFn?.()
}

import { registerItemKind } from './registry'
import { actionItemKind } from './action'
import { moreItemKind } from './more'
import { rowItemKind } from './row'

/**
 * **注册只发生在这一个 barrel**(与 `../targets/index.ts`、
 * `content/viewer/kinds/index.ts`、`content/blocks/registry.ts` 逐条同款):
 * import 这个文件就是「这台上有哪些序列项」,一眼看全。
 *
 * **加一种序列项 = 一个模块文件 + 这里一行**。面板 / 键盘 / 分页 / 序列一个字
 * 都不用改 —— `sequence.ts` 只拼接,`reconcile` 与 ⏎ 只读表。
 *
 * 三行,按 kind 的字母序 —— 次序在这里**没有语义**(屏幕上的次序由 `sequenceOf`
 * 说),所以取一个不会引发讨论的排法。
 */
const registered = [actionItemKind, moreItemKind, rowItemKind].map(registerItemKind)

/**
 * 模块级副作用的退役口(09-01 立法)。注册是一次模块级副作用,寿命就是「这个模块
 * 实例」—— 热更时不退役,下一份模块再注册同名 kind 会当场抛「already registered」。
 * 退役**复用注册交出来的那一口**(每条只删自己那一条),不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const dispose of registered) dispose()
  })
}

export { registerItemKind, resolveItemKind, resetItemKinds, itemKindNames } from './registry'
export type {
  SearchItemContext,
  SearchItemKind,
  SearchItemRenderProps,
  SearchItemView,
} from './registry'

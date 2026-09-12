import { HeightBook } from '../../ui/flip-height'

/**
 * 卡高账本 —— **工具卡这一族共用一只 `ResizeObserver`** 记住「此刻多高」,
 * 给 FLIP 当「改前」的起点。
 *
 * ── 09-12:机制搬去 `ui/flip-height.ts`,这里只剩这一族自己的那本 ─────────
 * `CardHeightBook` 那只类与 `useFlipHeight` 那只 hook 逐字没变,搬家的理由是
 * composer 的候选抽屉成了第二个消费者(候选从「正在找…」一行长成整列,
 * 高度一样不许跳)—— 「基础件先行」那条法说的正是这一刻:第二个消费者出现时
 * 立件,不在业务面再抄一份。**病历整段也跟着搬过去了**(它是那件原语存在的
 * 理由,不是这一族的私事);这里留下的是这一族为什么要**自己一本**:
 * 916 只一起进场的盒子与零星几只浮层挤进同一只观察者,下一个人读 `size`
 * 时就说不清那个数在说谁。两只 RO 的成本是常数。
 */

/** 全壳工具卡的那一本。模块级单例 —— 按 09-01 立法配 HMR 退役(复用它自己那口 `reset()`)。 */
export const cardHeights = new HeightBook()

if (import.meta.hot) {
  import.meta.hot.dispose(() => cardHeights.reset())
}

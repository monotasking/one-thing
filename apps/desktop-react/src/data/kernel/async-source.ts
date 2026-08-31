/**
 * 「一件正在进行的异步动作」这件事本身 —— query 与 mutation 的**共同面**。
 *
 * 为什么要有这一层:交互稳定律③说「异步动作必有进行中反馈,而且长在发起它的
 * 那个控件上」。控件(`ui/AsyncButton`)要绑的只有这一件事,它不该关心自己
 * 被绑的是一发取数还是一次写入 —— 那是数据层的分工,不是按钮的。
 *
 * 两口,一口都不多:
 *  · `subscribe` —— 进行中这件事变了就喊一声(React 侧走 useSyncExternalStore);
 *  · `isPending(key?)` —— 此刻在飞吗。**带 key 时只问那一格**:一次勾选把整表
 *    都禁掉,正是律③点名的那种「把一个控件的状态说成一整块面的状态」。
 *    query 是按 key 分家的(一个 key 一发),所以它无视这个参数;mutation 一发
 *    可以打在任意一格上,所以它认。
 */
export interface AsyncSource {
  /** 订阅「进行中」的变化。返回退订。 */
  subscribe(listener: () => void): () => void
  /** 此刻在飞吗。不带 key = 问整体。 */
  isPending(key?: string): boolean
}

/** 谁都没绑的那一档。让消费者不必为「还没有 source」写第二条分支。 */
export const IDLE_ASYNC_SOURCE: AsyncSource = {
  subscribe: () => () => undefined,
  isPending: () => false,
}

/** 后端那句原话。**不翻译、不加工** —— 它是数据,不是文案。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

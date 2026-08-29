/**
 * 性能预算 —— **一份常量表,两个消费者**:dev HUD 的报警色,和
 * `scripts/gate-perf.mjs` 的红绿判据。
 *
 * 放在 src 根而不是 services/ 下,是因为它不是一项服务,是一张**契约表**:
 * 「这块壳认为多慢算慢」。HUD 和门都读它,所以门红了不会有人辩「HUD 上是绿的」。
 * 门是 node 脚本、读不了 CSS module,所以这份表必须是纯数据、零 import。
 *
 * 数字的来历(不是拍脑袋):
 *  · 100ms —— RAIL 的交互响应上限,超过这个人就觉得「按了没反应」;
 *  · 50ms  —— Long Animation Frame 的定义线,也是 INP「长任务」的口径;
 *  · 33ms  —— 30fps 的一帧。流式回放是**稳态**动画,掉到 30fps 以下就看得出顿。
 *    (不用 16.7ms/60fps 是刻意的:流式期间主线程本来就有真实工作要做,
 *     按 60fps 卡会把正常的解析开销也判成红。)
 */

export const PERF_BUDGET = {
  /** 交互延迟(event timing 的 duration)的 p95 上限,毫秒。 */
  interactionP95Ms: 100,
  /** 长帧(LoAF)的定义线,毫秒。探针也用这个值当订阅阈值。 */
  longFrameMs: 50,
  /** 动画期间允许出现的长帧条数 —— 零。 */
  animationLongFrames: 0,
  /** 流式稳态下允许出现的「超过这个毫秒数」的帧,条数上限见 streamOverBudgetFrames。 */
  streamFrameMs: 33,
  /** 流式稳态允许的超标帧条数。 */
  streamOverBudgetFrames: 0,
  /** event timing 的订阅阈值:低于它的交互不进环,省得把环冲满。 */
  eventDurationThresholdMs: 40,
} as const

export type PerfBudget = typeof PERF_BUDGET

/** 一条读数是否超预算。HUD 的红/绿与门的红/绿走的是同一句判断。 */
export function overBudget(kind: 'longFrame' | 'interaction', ms: number): boolean {
  return kind === 'longFrame' ? ms > PERF_BUDGET.longFrameMs : ms > PERF_BUDGET.interactionP95Ms
}

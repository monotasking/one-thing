/**
 * 性能预算 —— **一份常量表,两个消费者**:dev HUD 的报警色,和
 * `scripts/gate-perf.mjs` 的红绿判据。
 *
 * 放在 src 根而不是 services/ 下,是因为它不是一项服务,是一张**契约表**:
 * 「这块壳认为多慢算慢」。HUD 和门都读它,所以门红了不会有人辩「HUD 上是绿的」。
 * 门是 node 脚本、读不了 CSS module,所以这份表必须是纯数据、零 import。
 *
 * 数字的来历(不是拍脑袋):
 *  · 70ms  —— 高频往复交互(切 tab 这类一天几十次的动作)的 p95 上限。100ms 的
 *    RAIL 线只是「按了没反应」的下限,不是「感觉利索」的线:08-30 用户报切换钝,
 *    量出来 83ms —— 在 100 的预算带里绿着,手感却是每次错过约 5 帧。所以这一档
 *    改按**健康读数锚定**:修完打包版 p95 61ms,预算 = 61 + 一成五抖动余量 ≈ 70
 *    (60fps 下约 4 帧)。再回到 80ms 档,门先于用户开口变红。
 *  · 100ms —— RAIL 的交互响应上限,留给**一次性**的重交互(冷开几百张卡的首屏):
 *    它是「按了等它开」,不是往复动作,按「没反应」的线卡就够了。
 *  · 393ms(sessionSwitchMs,09-03 二修按读数锚定,不再是占位)—— 切会话是
 *    「整棵消息树换一份」:上一条的树要拆、新的一条要解析 markdown 再排版,
 *    与①「几百张卡首屏」同属一次性重交互,但比它重一档。所以它不套
 *    `interactionP95Ms`(那是切 tab 那种一天几十次的往复动作),自己一格。
 *    读数:批 A 修完(clamp-measurer 共享 RO / useChatToc 合帧 / assemble 按身份章
 *    LRU)在打包版上连跑 4 次 `gate-perf.mjs`,p95 291/341/299/273ms —— 抖动带本身
 *    有约 70ms 宽,是这台机器上后台进程与 GC 的噪声,不是产品代码的确定性行为
 *    (下面 `sessionSwitchForcedLayouts` 才是)。锚点取 4 次里的**最大值** 341,
 *    乘一成五抖动余量 ≈ 392.15,取整 393 —— 与①同一条算法,只是这一档更宽的
 *    抖动带要求锚在最大值而不是随手一次的读数上,否则下一次跑门会被自己的
 *    噪声打红。
 *  · 3 次(sessionSwitchForcedLayouts)—— **这一档真正的红绿判据**(见
 *    `scripts/gate-perf.mjs` 里 `forcedLayouts()` 的大注:时间 p95 落在改前改后
 *    重叠的抖动带里,拿它当判据会闪;强制排版次数是一个**整数计数**,同一次
 *    改动前后在这台机器上跑多少遍都不变)。批 A 修完连跑 4 次,8 次切换每一次
 *    都恰好是 3 次强制排版,毫无波动 —— 3 就是这份代码今天的确定性读数,不留余量
 *    (改前是什么量级见 `gate-perf.mjs` 场景⑤大注的反证段落)。
 *  · 50ms  —— Long Animation Frame 的定义线,也是 INP「长任务」的口径;
 *  · 33ms  —— 30fps 的一帧。流式回放是**稳态**动画,掉到 30fps 以下就看得出顿。
 *    (不用 16.7ms/60fps 是刻意的:流式期间主线程本来就有真实工作要做,
 *     按 60fps 卡会把正常的解析开销也判成红。)
 */

export const PERF_BUDGET = {
  /** 高频交互延迟(event timing 的 duration)的 p95 上限,毫秒。 */
  interactionP95Ms: 70,
  /** 一次性重交互(冷开会话总览这类首屏全画)的端到端上限,毫秒。 */
  coldOpenMs: 100,
  /** 切会话(常规档 ↔ 常规档)「按下 → 上屏」的 p95 上限,毫秒——参考读数,见下方大注。 */
  sessionSwitchMs: 393,
  /** 切会话单次允许出现的强制排版(forced reflow)次数上限——**这一档真正的判据**,见下方大注。 */
  sessionSwitchForcedLayouts: 3,
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

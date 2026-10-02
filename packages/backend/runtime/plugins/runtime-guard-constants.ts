/**
 * 软隔离的阈值常量。
 *
 * 单独一个文件,是为了让**策略表**(policy.ts)与**执行器**(runtime-guard.ts)
 * 都能引用同一个数字而不互相 import —— R7 第一版在 policy.ts 里另写了一份
 * `DEFAULT_THRESHOLD`,结果 tracker 构造参数里的 `threshold` 被表静默架空成了
 * 一个永远取不到的死配置。两份常量就是两份事实。
 */

/** 同一条车道连败多少次触发罚则(罚则本身由 policy.ts 的严重度表决定)。 */
export const CORE_PLUGIN_FAILURE_THRESHOLD = 3

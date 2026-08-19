/**
 * 时长格式化 —— 一份实现,三种口径。
 *
 * 三处调用点历史上各写了一份(`tool-activity-view.formatToolDuration` /
 * `MessageBubble.formatWorkDuration` / `useGenerationStatus.formatElapsed`),
 * 输出**确实不同**,不是重复代码:
 *
 * | style     | 亚秒            | < 1 分钟                    | ≥ 1 分钟   | 用在哪 |
 * | --------- | --------------- | --------------------------- | ---------- | ------ |
 * | `tool`    | 下限 100ms      | `12.4s`(恒一位小数)        | `2m05.3s`  | 工具行头 / 参数草稿计时器 |
 * | `work`    | `''`(不说话)  | `1.5s` / 满 10s 起 `12s`    | `2:05`     | Working/Worked 头 |
 * | `elapsed` | `0s`            | `12s`(整秒下取整)          | `2:05`     | 生成状态读数 |
 *
 * 之所以不统一:`tool` 要能横向比较同一批工具的快慢(所以恒带小数、且跑得再快
 * 也不显示 `0.0s`);`work` 是一句话里的附注,亚秒不值一提、两位数秒不必带小数;
 * `elapsed` 是秒表,跳动必须是整秒。合并只是把三份实现收成一处并把口径写进
 * 类型,**没有**改任何一处的输出。
 */

export type DurationStyle = 'tool' | 'work' | 'elapsed'

export interface FormatDurationOptions {
  style: DurationStyle
}

/**
 * `tool` 口径:亚 100ms 的执行会渲染成 "0.0s",读起来像坏掉的计时器 ——
 * 所有真实调用至少显示 0.1s 这个下限。
 */
const TOOL_FLOOR_MS = 100

/** `work` 口径:满一秒才开口;满十秒后小数位不再有信息量。 */
const WORK_FLOOR_MS = 1000
const WORK_DECIMAL_CEILING_MS = 10_000

const MINUTE_MS = 60_000

/** `m:ss` 时钟(`work` / `elapsed` 共用,两者在 ≥ 1 分钟处本来就同一算法)。 */
function clock(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS)
  const seconds = Math.floor((ms % MINUTE_MS) / 1000)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function formatDuration(ms: number, options: FormatDurationOptions): string {
  switch (options.style) {
    case 'tool': {
      const clamped = Math.max(ms, TOOL_FLOOR_MS)
      if (clamped < MINUTE_MS) return `${(clamped / 1000).toFixed(1)}s`
      const minutes = Math.floor(clamped / MINUTE_MS)
      const seconds = (clamped % MINUTE_MS) / 1000
      return `${minutes}m${seconds < 10 ? '0' : ''}${seconds.toFixed(1)}s`
    }
    case 'work': {
      if (ms < WORK_FLOOR_MS) return ''
      if (ms < MINUTE_MS) return `${(ms / 1000).toFixed(ms >= WORK_DECIMAL_CEILING_MS ? 0 : 1)}s`
      return clock(ms)
    }
    case 'elapsed': {
      const total = Math.max(0, ms)
      if (total < MINUTE_MS) return `${Math.floor(total / 1000)}s`
      return clock(total)
    }
  }
}

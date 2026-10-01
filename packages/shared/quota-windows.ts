/**
 * 限额窗口**按时长归类**(§8.1)—— 纯函数,零依赖。
 *
 * P4 从 runtime `providers/quota/classify-windows.ts` 搬来(`git mv`,逐字未改):runtime 的配额源
 * 与壳的读数卡都要它,而壳不许 import runtime 的服务商代码。不放 `@shared/contracts/`,因为那里
 * 只收形状、不收函数(边界门 `packages/shared/contracts holds serializable shapes only`)。
 *
 * Codex 的 `primary_window` / `secondary_window` 在不同套餐里装的是不同的窗(Plus 的
 * primary 是 5 小时窗,某些团队套餐的 primary 却是周窗),CodexBar 一类工具都在这里
 * 踩过:按位置读,换个套餐标签就贴反了。所以归类只看窗口有多长:
 *
 *  - ≤ 6 小时 → `5h`(「5 小时」);
 *  - ≤ 8 天 → `7d`(「本周」);
 *  - 其余 → `{n}d`(「{n} 天」,n 按天四舍五入,至少 1)。
 */

export const QUOTA_WINDOW_5H = '5h'
export const QUOTA_WINDOW_7D = '7d'

const HOUR = 3600
const DAY = 86_400

/** 归类键。非有限 / 非正的秒数没有归类(返回 `undefined`),调用方丢掉那一窗。 */
export function classifyQuotaWindowSeconds(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  if (seconds <= 6 * HOUR) return QUOTA_WINDOW_5H
  if (seconds <= 8 * DAY) return QUOTA_WINDOW_7D
  return `${Math.max(1, Math.round(seconds / DAY))}d`
}

/** `{n}d` 的那个 n(`5h` / `7d` 与认不出的键答 `undefined`)。壳拼「{n} 天」用。 */
export function quotaWindowDaysOf(id: string): number | undefined {
  const match = /^(\d+)d$/.exec(id)
  if (!match || id === QUOTA_WINDOW_7D) return undefined
  return Number(match[1])
}

/**
 * 一张表里的窗口排序:短窗在前(5 小时 → 本周 → 更长),同长的主窗口排在附加窗口
 * 之前。服务商给的顺序不可信(同一个理由),屏幕上的顺序由这里一处定。
 */
export function sortQuotaWindows<T extends { seconds: number; label?: string }>(windows: readonly T[]): T[] {
  return [...windows].sort((a, b) => {
    if (a.seconds !== b.seconds) return a.seconds - b.seconds
    if (!a.label !== !b.label) return a.label ? 1 : -1
    return (a.label ?? '').localeCompare(b.label ?? '')
  })
}

/**
 * 服务商给的时间戳 → epoch ms。三种写法都见过:秒(Codex 的 `reset_at`)、毫秒、
 * ISO 字符串(Claude 的 `resets_at`)。认不出就缺席,不编一个。
 */
export function quotaEpochMsOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 1e12 ms ≈ 2001 年;小于它的只可能是秒。
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return quotaEpochMsOf(numeric)
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 读数的进位,全壳唯一产地(§5.7,2026-09-05)。
 *
 * 数量:小写 k、大写 M,一位小数,整数不留 .0;先四舍五入再判档,
 * 所以 999 950 进到 1M 而不是 '1000k'。时间:只到 0.1s,永不写毫秒;≥ 60s 用 '1m 05s'。
 */
export function formatQuantity(n: number): string {
  const a = Math.abs(n)
  if (a < 1000) return String(n)
  const sign = n < 0 ? '-' : ''
  const trim = (s: string): string => (s.endsWith('.0') ? s.slice(0, -2) : s)
  const k = Math.round(a / 100) / 10
  if (k < 1000) return `${sign}${trim(k.toFixed(1))}k`
  const m = Math.round(a / 100_000) / 10
  return `${sign}${trim(m.toFixed(1))}M`
}

export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`
  const total = Math.round(safe / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

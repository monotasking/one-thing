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

/**
 * `formatQuantity` 的反向:把人写的读数解析回整数。**同一份进位规则的另一半**,
 * 所以住在同一个文件里 —— k / M 的倍数在两处各写一遍就是两处会漂开。
 *
 * 认的写法:`200000`、`200,000`、`200k` / `200K`、`1M` / `1m`、`1.5M`;
 * 大小写不分(`formatQuantity` 写小写 k 大写 M,人打的时候没人记得住这条)。
 * 倍数是十进制(k = 1000,M = 1 000 000):目录里 deepseek 那种 1 048 576 是
 * 二进制的账,但人说「1M」的时候指的是一百万,不是 2 的 20 次方。
 *
 * 认不出来、乘完不是整数、或 ≤ 0,一律 `null` —— 「0.0005k」不是半个 token。
 */
export function parseQuantity(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(raw.trim().replace(/,/g, ''))
  if (!m) return null
  const unit = m[2]?.toLowerCase()
  const factor = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1
  const n = Number(m[1]) * factor
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null
  return n
}

export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`
  const total = Math.round(safe / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

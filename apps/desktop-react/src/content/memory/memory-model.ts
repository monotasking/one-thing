import type { MemoryHolderReport, MemoryProcessSample, MemoryReportResponse } from '@shared/ipc/memory'
import type { StatusDotTone } from '../../ui/StatusDot'
import type { MessageKey } from '../../i18n'

/**
 * 内存监视器的纯读法(2026-09-25)。屏幕上每一个「怎么念、怎么量」都在这里,
 * 面板组件只管摆 —— 于是读法能单测,面板不必。
 */

/** 面板看得见时多久问一次。2s:够跟上一次打开网页的涨落,又不至于让监视器自己成了负担。 */
export const MEMORY_POLL_MS = 2000

/** 趋势线留多少个点:150 × 2s = 最近 5 分钟。 */
export const MEMORY_HISTORY_POINTS = 150

// ── 压力档 ─────────────────────────────────────────────────────────────────

/** 总量落在预算的哪一档。量不到(`totalBytes === null`)就是 `idle`,不猜。 */
export function pressureTone(report: Pick<MemoryReportResponse, 'totalBytes' | 'budget'>): StatusDotTone {
  const total = report.totalBytes
  if (total === null) return 'idle'
  if (total >= report.budget.hardBytes) return 'bad'
  if (total >= report.budget.softBytes) return 'warn'
  return 'ok'
}

export function pressureLabelKey(tone: StatusDotTone): MessageKey {
  if (tone === 'bad') return 'memory.pressureHard'
  if (tone === 'warn') return 'memory.pressureSoft'
  if (tone === 'ok') return 'memory.pressureOk'
  return 'memory.pressureUnknown'
}

/**
 * 预算表(meter)的刻度。**上限不是 hard 线**:超过 hard 的那一截要画得出来 ——
 * 刻度顶 = max(hard × 1.2, 总量 × 1.05),于是 soft / hard 两根刻线永远在条里,
 * 而一个 1.7GB 的总量也不会把条撑爆成 100%。
 */
export interface MeterScale {
  max: number
  fill: number | undefined
  soft: number
  hard: number
}

export function meterScale(report: Pick<MemoryReportResponse, 'totalBytes' | 'budget'>): MeterScale {
  const { softBytes, hardBytes } = report.budget
  const total = report.totalBytes
  const max = Math.max(hardBytes * 1.2, (total ?? 0) * 1.05, 1)
  return {
    max,
    fill: total === null ? undefined : total / max,
    soft: softBytes / max,
    hard: hardBytes / max,
  }
}

// ── 去向:四类 ───────────────────────────────────────────────────────────────

/**
 * 进程归成四类,**次序固定**(颜色按这个次序取 `--viz-1..4`,不按大小换色):
 * core(主进程)/ 界面(壳自己的渲染进程)/ 网页(内置浏览器的每一格与它的子框架)/
 * 系统(GPU、网络、音频这类 Chromium 服务,以及认不出的)。
 * 七种 kind 折成四类而不是七色 —— 四格以上的分类色在色觉异常下分不开。
 */
export type MemoryCategory = 'core' | 'ui' | 'web' | 'system'

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = ['core', 'ui', 'web', 'system']

export function categoryOf(kind: MemoryProcessSample['kind']): MemoryCategory {
  if (kind === 'main') return 'core'
  if (kind === 'renderer') return 'ui'
  if (kind === 'browser') return 'web'
  return 'system'
}

const CATEGORY_KEYS: Record<MemoryCategory, MessageKey> = {
  core: 'memory.catCore',
  ui: 'memory.catUi',
  web: 'memory.catWeb',
  system: 'memory.catSystem',
}

const CATEGORY_HINT_KEYS: Record<MemoryCategory, MessageKey> = {
  core: 'memory.catCoreHint',
  ui: 'memory.catUiHint',
  web: 'memory.catWebHint',
  system: 'memory.catSystemHint',
}

export function categoryLabelKey(category: MemoryCategory): MessageKey { return CATEGORY_KEYS[category] }
export function categoryHintKey(category: MemoryCategory): MessageKey { return CATEGORY_HINT_KEYS[category] }

/** 颜色跟类别走(第 n 类恒是第 n 格),**不跟排名走**。 */
export function categoryColorVar(category: MemoryCategory): string {
  return `var(--viz-${MEMORY_CATEGORIES.indexOf(category) + 1})`
}

export interface CategoryGroup {
  category: MemoryCategory
  bytes: number
  /** 占所有量得到的字节的比例(0–1)。 */
  share: number
  /** 这一类里的进程,从大到小,量不到的排最后。 */
  processes: MemoryProcessSample[]
}

/** 分组 + 求和。空的类别**不出现**(一格 0 字节的段在条上画不出来,在图例里是噪音)。 */
export function groupByCategory(rows: readonly MemoryProcessSample[]): CategoryGroup[] {
  const measured = rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
  return MEMORY_CATEGORIES.flatMap(category => {
    const processes = sortProcesses(rows.filter(row => categoryOf(row.kind) === category))
    if (processes.length === 0) return []
    const bytes = processes.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
    return [{ category, bytes, share: measured > 0 ? bytes / measured : 0, processes }]
  })
}

/** 从大到小;量不到的排最后。**不改原数组** —— 报表是 query 的缓存。 */
export function sortProcesses(rows: readonly MemoryProcessSample[]): MemoryProcessSample[] {
  return [...rows].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
}

/** 百分比念法:不到 1% 念「<1%」,别的取整。 */
export function formatShare(share: number): string {
  if (share > 0 && share < 0.01) return '<1%'
  return `${Math.round(share * 100)}%`
}

// ── 趋势 ─────────────────────────────────────────────────────────────────────

export interface MemorySample { at: number; bytes: number }

/** 追加一个点并截到 `limit`。同一次采样(`at` 不变)不重复记。 */
export function appendSample(history: readonly MemorySample[], sample: MemorySample, limit = MEMORY_HISTORY_POINTS): MemorySample[] {
  if (history.length > 0 && history[history.length - 1].at === sample.at) return history as MemorySample[]
  const next = [...history, sample]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/**
 * 趋势图的几何:x 按**时间**铺(不是按下标 —— 面板藏起来那一段没有点,
 * 那一段就该是一段空白的时间,而不是被挤没)。
 *
 * **y 不从 0 起,所以这里只有线、没有面积**:面积图的面积就是量,基线必须是 0;
 * 而监视器要看的是起伏 —— 1.7 GB 上下 40 MB 从 0 起画就是一条平线。纵轴范围包住
 * 这段数据**与** soft / hard 两根参照线(两根线永远在图里,读者随时知道离线多远),
 * 上下各留一成空。
 */
export interface TrendGeometry {
  points: Array<{ x: number; y: number; sample: MemorySample }>
  line: string
  softY: number
  hardY: number
  yMin: number
  yMax: number
}

export function trendGeometry(
  history: readonly MemorySample[],
  budget: MemoryReportResponse['budget'],
  width: number,
  height: number,
): TrendGeometry | undefined {
  if (history.length < 2 || width <= 0 || height <= 0) return undefined
  const values = history.map(sample => sample.bytes)
  const lo = Math.min(budget.softBytes, ...values)
  const hi = Math.max(budget.hardBytes, ...values)
  const pad = Math.max((hi - lo) * 0.1, 1)
  const yMin = Math.max(0, lo - pad)
  const yMax = hi + pad
  const t0 = history[0].at
  const span = Math.max(1, history[history.length - 1].at - t0)
  const yOf = (bytes: number): number => height - ((bytes - yMin) / (yMax - yMin)) * height
  const points = history.map(sample => ({ x: ((sample.at - t0) / span) * width, y: yOf(sample.bytes), sample }))
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  return { points, line, softY: yOf(budget.softBytes), hardY: yOf(budget.hardBytes), yMin, yMax }
}

/** 离指针最近的那个点的下标(十字线吸附用)。 */
export function nearestIndex(xs: readonly number[], x: number): number {
  let best = 0
  for (let i = 1; i < xs.length; i++) {
    if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i
  }
  return best
}

// ── 缓存 ─────────────────────────────────────────────────────────────────────

const UNIT_KEYS: Record<string, MessageKey> = {
  sessions: 'memory.unitSessions',
  events: 'memory.unitEvents',
  views: 'memory.unitViews',
}

/** 持有者自述的单位 → 字典键。认不得的单位原样念(新持有者不必先改这里才看得见)。 */
export function holderUnitKey(unit: string): MessageKey | undefined {
  return UNIT_KEYS[unit]
}

const DETAIL_KEYS: Record<string, MessageKey> = {
  sessions: 'memory.detailSessions',
  subscribed: 'memory.detailSubscribed',
  capacityPerSession: 'memory.detailCapacityPerSession',
  idle: 'memory.detailIdle',
  protected: 'memory.detailProtected',
  tabs: 'memory.detailTabs',
  hidden: 'memory.detailHidden',
  audible: 'memory.detailAudible',
  hibernated: 'memory.detailHibernated',
}

/**
 * detail 那几格的人话。认得的键查字典(「空闲 7」),认不得的原样(`key 7`)——
 * 持有者是自述的,新长一格不该先等这张表才看得见。
 */
export function holderDetailParts(holder: Pick<MemoryHolderReport, 'detail'>): Array<{ key?: MessageKey; raw: string; value: string }> {
  return Object.entries(holder.detail ?? {}).map(([raw, value]) => ({
    ...(DETAIL_KEYS[raw] ? { key: DETAIL_KEYS[raw] } : {}),
    raw,
    value: String(value),
  }))
}

/** 条数占上限的比例(缓存行那条细表)。没有条数上限 = `undefined`,不画表。 */
export function holderFill(holder: Pick<MemoryHolderReport, 'entries' | 'limit'>): number | undefined {
  const limit = holder.limit?.entries
  if (limit === undefined || limit <= 0) return undefined
  return Math.min(1, holder.entries / limit)
}

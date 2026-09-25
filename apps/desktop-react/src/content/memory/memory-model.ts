import type { MemoryHolderReport, MemoryProcessSample, MemoryReportResponse } from '@shared/ipc/memory'
import type { StatusDotTone } from '../../ui/StatusDot'
import type { MessageKey } from '../../i18n'

/**
 * 内存面板的纯计算函数:状态判断、刻度、分组、趋势图几何与格式化。
 * 与组件分开,便于单元测试。
 */

/** 面板可见时的刷新间隔。 */
export const MEMORY_POLL_MS = 2000

/** 趋势图保留的点数:150 × 2 秒 = 5 分钟。 */
export const MEMORY_HISTORY_POINTS = 150

// ── 状态 ───────────────────────────────────────────────────────────────────

/** 根据总占用判断状态;无法测量时返回 `idle`。 */
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
 * 占用条的刻度。最大值取 max(硬上限 × 1.2, 总占用 × 1.05),使两个上限刻度始终
 * 落在条内,超过硬上限的部分也能显示。
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

// ── 类别 ─────────────────────────────────────────────────────────────────────

/**
 * 进程分为四类,顺序固定,颜色按此顺序取 `--viz-1..4`:
 * 核心(主进程)、界面(应用窗口的渲染进程)、网页(内置浏览器标签页及其子框架)、
 * 系统服务(GPU、网络、音频等 Chromium 服务及其他)。
 * 超过四种分类色时,色觉异常的用户难以区分,因此不按七种进程类型分别着色。
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

/** 类别对应的颜色,固定不随排名变化。 */
export function categoryColorVar(category: MemoryCategory): string {
  return `var(--viz-${MEMORY_CATEGORIES.indexOf(category) + 1})`
}

export interface CategoryGroup {
  category: MemoryCategory
  bytes: number
  /** 占可测量总量的比例(0–1)。 */
  share: number
  /** 该类别的进程,从大到小排列,无法测量的排在最后。 */
  processes: MemoryProcessSample[]
}

/** 按类别分组并求和,不返回没有进程的类别。 */
export function groupByCategory(rows: readonly MemoryProcessSample[]): CategoryGroup[] {
  const measured = rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
  return MEMORY_CATEGORIES.flatMap(category => {
    const processes = sortProcesses(rows.filter(row => categoryOf(row.kind) === category))
    if (processes.length === 0) return []
    const bytes = processes.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
    return [{ category, bytes, share: measured > 0 ? bytes / measured : 0, processes }]
  })
}

/** 从大到小排序,无法测量的排在最后。返回新数组。 */
export function sortProcesses(rows: readonly MemoryProcessSample[]): MemoryProcessSample[] {
  return [...rows].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
}

/** 格式化百分比:小于 1% 显示「<1%」,其余取整。 */
export function formatShare(share: number): string {
  if (share > 0 && share < 0.01) return '<1%'
  return `${Math.round(share * 100)}%`
}

// ── 趋势 ─────────────────────────────────────────────────────────────────────

export interface MemorySample { at: number; bytes: number }

/** 追加一个趋势点并截断到 `limit` 个;相同时间戳的点不重复记录。 */
export function appendSample(history: readonly MemorySample[], sample: MemorySample, limit = MEMORY_HISTORY_POINTS): MemorySample[] {
  if (history.length > 0 && history[history.length - 1].at === sample.at) return history as MemorySample[]
  const next = [...history, sample]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/**
 * 趋势图几何。横轴按时间排布,面板隐藏期间没有数据的时段保留为空白。
 *
 * 纵轴范围覆盖全部数据点与软 / 硬上限,上下各留 10% 余量,不从 0 开始,以便看清变化;
 * 因此只画线,不画面积(面积图的基线必须是 0)。
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

/** 返回离指定横坐标最近的点的下标。 */
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

/** 单位对应的文案键;未知单位返回 `undefined`,调用方原样显示。 */
export function holderUnitKey(unit: string): MessageKey | undefined {
  return UNIT_KEYS[unit]
}

/** 缓存明细里要显示的项及其文案。不在表里的项不显示。 */
const DETAIL_KEYS: Record<string, MessageKey> = {
  sessions: 'memory.detailSessions',
  capacityPerSession: 'memory.detailCapacityPerSession',
  idle: 'memory.detailIdle',
  protected: 'memory.detailProtected',
  tabs: 'memory.detailTabs',
  hidden: 'memory.detailHidden',
  audible: 'memory.detailAudible',
  hibernated: 'memory.detailHibernated',
}

/** 缓存明细中要显示的项:只保留有文案的项,值为 0 的项不显示。 */
export function holderDetailParts(holder: Pick<MemoryHolderReport, 'detail'>): Array<{ key: MessageKey; value: number | string }> {
  return Object.entries(holder.detail ?? {}).flatMap(([raw, value]) => {
    const key = DETAIL_KEYS[raw]
    if (!key || value === 0 || value === false) return []
    return [{ key, value: typeof value === 'boolean' ? String(value) : value }]
  })
}

/** 条目数占上限的比例;没有条目上限时返回 `undefined`。 */
export function holderFill(holder: Pick<MemoryHolderReport, 'entries' | 'limit'>): number | undefined {
  const limit = holder.limit?.entries
  if (limit === undefined || limit <= 0) return undefined
  return Math.min(1, holder.entries / limit)
}

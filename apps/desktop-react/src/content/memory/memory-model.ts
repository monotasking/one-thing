import type { MemoryHolderReport, MemoryProcessSample, MemoryReportResponse } from '@shared/ipc/memory'
import type { StatusDotTone } from '../../ui/StatusDot'
import type { MessageKey } from '../../i18n'

/**
 * 内存监视器的纯读法(2026-09-25)。屏幕上每一个「怎么念」都在这里,
 * 面板组件只管摆 —— 于是读法能单测,面板不必。
 */

/** 面板看得见时多久问一次。2s:够跟上一次打开网页的涨落,又不至于让监视器自己成了负担。 */
export const MEMORY_POLL_MS = 2000

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

/** 总量占 hard 线的比例,给进度条用。量不到 = `undefined`(= 不知道,不是 0)。 */
export function budgetRatio(report: Pick<MemoryReportResponse, 'totalBytes' | 'budget'>): number | undefined {
  if (report.totalBytes === null || report.budget.hardBytes <= 0) return undefined
  return Math.min(1, report.totalBytes / report.budget.hardBytes)
}

const KIND_KEYS: Record<MemoryProcessSample['kind'], MessageKey> = {
  main: 'memory.kindMain',
  renderer: 'memory.kindRenderer',
  browser: 'memory.kindBrowser',
  gpu: 'memory.kindGpu',
  utility: 'memory.kindUtility',
  worker: 'memory.kindWorker',
  other: 'memory.kindOther',
}

export function processKindKey(kind: MemoryProcessSample['kind']): MessageKey {
  return KIND_KEYS[kind] ?? 'memory.kindOther'
}

/** 从大到小;量不到的排最后。**不改原数组** —— 报表是 query 的缓存。 */
export function sortProcesses(rows: readonly MemoryProcessSample[]): MemoryProcessSample[] {
  return [...rows].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
}

/** 每一行占最大那一行的几成(行尾那条细槽)。 */
export function shareOfLargest(rows: readonly MemoryProcessSample[]): Map<number, number> {
  const largest = rows.reduce((max, row) => Math.max(max, row.bytes ?? 0), 0)
  return new Map(rows.map(row => [row.pid, largest > 0 && row.bytes !== null ? row.bytes / largest : 0]))
}

const UNIT_KEYS: Record<string, MessageKey> = {
  sessions: 'memory.unitSessions',
  events: 'memory.unitEvents',
  views: 'memory.unitViews',
}

/** 持有者自述的单位 → 字典键。认不得的单位原样念(新持有者不必先改这里才看得见)。 */
export function holderUnitKey(unit: string): MessageKey | undefined {
  return UNIT_KEYS[unit]
}

/** detail 那几格念成一行「k=v · k=v」。空就不画。 */
export function holderDetailText(holder: Pick<MemoryHolderReport, 'detail'>): string | undefined {
  const entries = Object.entries(holder.detail ?? {})
  return entries.length > 0 ? entries.map(([key, value]) => `${key}=${String(value)}`).join(' · ') : undefined
}

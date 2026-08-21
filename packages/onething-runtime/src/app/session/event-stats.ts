/**
 * 影子期的记账账单(`docs/design/session-event-sourcing-2026-08.md` §10.3 ②)。
 *
 * `<store>/log/session-shadow-stats.json`:`{appendFailures, runs, mismatches}`。
 *
 * E0 的纪律是"写失败 warnOnce 吞掉" —— 事件是旁路账本时那没问题;事件成为
 * 唯一事实之后,一次静默的写失败就是一段永远补不回来的历史。S1 还是影子期,
 * 所以**不抛**,但必须**可见、可计数**:每会话 warn 一次(不刷屏),失败总数
 * 落进这张表,S1b 的 `sessions:shadow-report` 与门(`appendFailures = 0`)读它。
 *
 * 写盘是**节流的**:计数在内存里累加,最多每秒落一次盘 —— 这张表是给人和门看
 * 的统计,不是事实账本,没必要为它把主线程钉在 IO 上。进程退出前的最后一次由
 * `flushSessionEventStats()` 排空(测试与关停调它)。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  getOnethingLogDir,
} from '@onething/runtime/storage'
import { getLogger } from '../logging/index.js'

const log = getLogger('sessions.events')


export const SESSION_SHADOW_STATS_FILENAME = 'session-shadow-stats.json'

export interface SessionShadowStats {
  /** 事件/blob 写失败的总次数。门:必须是 0。 */
  appendFailures: number
  /** 完成并比对过的 run 数。门:≥ 200(`--min-runs` 可覆盖)。**每个 run 一次**。 */
  runs: number
  /**
   * 历史断言跑过的次数(F9,§13.2)。
   *
   * 它**不是** `runs` 的另一种说法:历史断言每次请求跑一遍,一个 12 轮的 run 会
   * 跑 12 次。从前这两件事共用一个"比过多少次"的直觉,于是"200 个干净 run"这道
   * 门被读成了远比实际大的覆盖面。分开记之后,报告里 `runs`(run 粒度)与
   * `historyChecks`(请求粒度)各说各的,门仍然只认 `runs`。
   */
  historyChecks: number
  /** 投影与消息不等的次数(同 run 同一处只计一次)。门:必须是 0。 */
  mismatches: number
  /**
   * 被折叠掉的**重复**不等(F9):同一个 run 里同一处不等在后续每轮请求上又出现
   * 一次。它不进门也不写 `shadow.jsonl` —— 记一个数只是为了让"折叠了多少"看得见。
   */
  duplicateMismatches: number
  /**
   * F6(§13.2):投影**退化**的次数(blob 读不到 / 回合重放掉回 collapsed)。
   *
   * 它不是不等 —— 退化的那一格两侧常常仍然相等(两边都短了同一截),所以它进不了
   * `mismatches`,而这正是它危险的地方:S2b 之后附件会凭空变短而门是绿的。
   * 不进门(它是**历史数据**的毛病,不是这次改动的),但报告与 `sessions:verify`
   * 都把它打出来。
   */
  projectionIssues: number
  /**
   * F13(§13.2):记录器**丢掉**的 part / 批次数。
   *
   * `openPart` 拿不到 partIndex(run 已经收账)时从前是纯静默的 return ——
   * 那一段正文在账本上整格消失,而没有任何计数说它消失过。
   */
  droppedParts: number
  /** 按断言种类拆的不等计数(`messages` / `history`)。 */
  byKind: Record<string, number>
  /**
   * 按原因拆的**跳过**计数。跳过 ≠ 不等:门只看 `mismatches`,这里只是让
   * "为什么这条会话没被比"看得见。
   *
   * - `legacyPartial` —— 会话的 `events.jsonl` 只覆盖了历史的一段尾巴(S1a
   *   之前就存在的老会话),投影里根本没有前面那些消息,比出来的必然是
   *   "少了 100 条"而不是"投影错了"。迁移之前这类会话不进历史断言(§10.9)。
   */
  skipped: Record<string, number>
  lastMismatchAt?: number
  updatedAt?: number
}

const EMPTY: SessionShadowStats = {
  appendFailures: 0,
  runs: 0,
  historyChecks: 0,
  mismatches: 0,
  duplicateMismatches: 0,
  projectionIssues: 0,
  droppedParts: 0,
  byKind: {},
  skipped: {},
}
const WRITE_THROTTLE_MS = 1000

let cached: SessionShadowStats | undefined
let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null
const warnedSessions = new Set<string>()

export function getSessionShadowStatsPath(): string {
  return path.join(getOnethingLogDir(), SESSION_SHADOW_STATS_FILENAME)
}

function load(): SessionShadowStats {
  if (cached) return cached
  try {
    const parsed = JSON.parse(fs.readFileSync(getSessionShadowStatsPath(), 'utf8')) as Partial<SessionShadowStats>
    cached = {
      appendFailures: Number(parsed.appendFailures) || 0,
      runs: Number(parsed.runs) || 0,
      historyChecks: Number(parsed.historyChecks) || 0,
      mismatches: Number(parsed.mismatches) || 0,
      duplicateMismatches: Number(parsed.duplicateMismatches) || 0,
      // 老账单缺这两格读成 0(而不是读崩)。
      projectionIssues: Number(parsed.projectionIssues) || 0,
      droppedParts: Number(parsed.droppedParts) || 0,
      byKind: normalizeByKind(parsed.byKind),
      skipped: normalizeByKind(parsed.skipped),
      ...(Number(parsed.lastMismatchAt) ? { lastMismatchAt: Number(parsed.lastMismatchAt) } : {}),
    }
  } catch {
    cached = { ...EMPTY, byKind: {}, skipped: {} }
  }
  return cached
}

function writeNow(): void {
  if (!dirty || !cached) return
  dirty = false
  try {
    fs.mkdirSync(getOnethingLogDir(), { recursive: true })
    fs.writeFileSync(
      getSessionShadowStatsPath(),
      `${JSON.stringify({ ...cached, updatedAt: Date.now() }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    // 统计表写不进去不该再制造第二条错误路径:计数留在内存里,下次再试。
    dirty = true
  }
}

function scheduleWrite(): void {
  dirty = true
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    writeNow()
  }, WRITE_THROTTLE_MS)
  const unref = (timer as unknown as { unref?: () => void }).unref
  if (typeof unref === 'function') unref.call(timer)
}

function normalizeByKind(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const count = Number(entry)
    if (Number.isFinite(count) && count > 0) out[key] = count
  }
  return out
}

export function readSessionShadowStats(): SessionShadowStats {
  const stats = load()
  return { ...stats, byKind: { ...stats.byKind }, skipped: { ...stats.skipped } }
}

export function bumpSessionShadowStats(patch: Partial<SessionShadowStats>): void {
  const stats = load()
  if (patch.appendFailures) stats.appendFailures += patch.appendFailures
  if (patch.runs) stats.runs += patch.runs
  if (patch.historyChecks) stats.historyChecks += patch.historyChecks
  if (patch.duplicateMismatches) stats.duplicateMismatches += patch.duplicateMismatches
  if (patch.projectionIssues) stats.projectionIssues += patch.projectionIssues
  if (patch.droppedParts) stats.droppedParts += patch.droppedParts
  if (patch.mismatches) {
    stats.mismatches += patch.mismatches
    stats.lastMismatchAt = Date.now()
  }
  if (patch.byKind) {
    for (const [kind, count] of Object.entries(patch.byKind)) {
      if (!count) continue
      stats.byKind[kind] = (stats.byKind[kind] ?? 0) + count
    }
  }
  if (patch.skipped) {
    for (const [reason, count] of Object.entries(patch.skipped)) {
      if (!count) continue
      stats.skipped[reason] = (stats.skipped[reason] ?? 0) + count
    }
  }
  scheduleWrite()
}

/**
 * 影子断言的总闸(S1b,§10.4)。**缺省开**;`ONETHING_SESSION_SHADOW=0` 关。
 *
 * 关掉的只是**比对与记账**这一层 —— 事件照旧落盘(S1a 的纪律不受它影响)。
 * 每次现读环境变量而不是启动时定死:测试要在同一个进程里两种档位各跑一遍,
 * 而这条判断本身是一次字符串比较,便宜到不值得缓存。
 */
export function isSessionShadowEnabled(): boolean {
  return process.env.ONETHING_SESSION_SHADOW !== '0'
}

/**
 * 一次写失败:计数 + **每会话一次** warn。
 *
 * 每会话一次而不是每次一条:一个坏掉的会话(目录被删、磁盘满)会在一个回合里
 * 失败几百次,刷屏之后真正的第一条错误就找不到了。总次数在账单里。
 */
export function countSessionEventFailure(sessionId: string, error: unknown, what: string): void {
  bumpSessionShadowStats({ appendFailures: 1 })
  if (warnedSessions.has(sessionId)) return
  warnedSessions.add(sessionId)
  log.warn('session event append failed', { sessionId, what }, error)
}

/**
 * F13:记录器丢了一段 part / 一批 delta。只计数,不 warn —— 它发生在收尾竞态上,
 * 一次执行可能连丢几段,刷屏没有意义;总数在账单里,报告会打印。
 */
export function countSessionEventDroppedPart(_sessionId: string): void {
  bumpSessionShadowStats({ droppedParts: 1 })
}

/** 把在途统计立刻落盘(关停 / 测试)。 */
export function flushSessionEventStats(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  writeNow()
}

/** 仅测试:清空进程内缓存与 warn 记忆。 */
export function resetSessionEventStatsCache(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  cached = undefined
  dirty = false
  warnedSessions.clear()
}

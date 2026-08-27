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
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.events')


export const SESSION_SHADOW_STATS_FILENAME = 'session-shadow-stats.json'

export interface SessionShadowStats {
  /** 事件/blob 写失败的总次数。门:必须是 0。 */
  appendFailures: number
  /**
   * 收尾到语义检查点的 run 数。门:≥ 200(`--min-runs` 可覆盖)。**每个 run 一次**。
   *
   * **F4-c c4 换了产地**:从前它由恒等门的 run 断言(`checkSessionRunShadow`)顺手
   * 记一笔 —— 门退役了,这个数就没人记了。现在它由 `endSessionRun` 自己记:它
   * 回答的本来就是"这一轮跑了多少个 run",与哪道门在比无关。判据一字未变
   * (关闸 `ONETHING_SESSION_SHADOW=0` 时照旧不记)。
   */
  runs: number
  /**
   * 历史恒等门跑过的次数(F9,§13.2)。**F4-c c4 起不再产生**(那道门已退役,
   * §16.24);字段留着是为了读得懂 c4 之前的老 `session-shadow-stats.json`。
   */
  historyChecks: number
  /**
   * 投影与 store 不等的次数(同 run 同一处只计一次)。**F4-c c4 起不再产生**
   * (恒等门退役);字段留着读老账,门仍然认它 —— 老账里的非零必须仍然是红。
   */
  mismatches: number
  /**
   * **端口事实断言**对不上的次数(c4,`port-fact-assert.ts`)。**进门,必须是 0。**
   *
   * 它是恒等门退役之后"A 类端口的事实已经在流上"那句话的逐格替身:端口写下某一格
   * 的那一刻,活投影上同一格折出来的是不是同一个值。默认只在开发/测试期与
   * `ONETHING_SESSION_PORT_ASSERT=1` 下跑(生产零成本),所以真机账上通常是 0
   * 且**没跑过** —— 它的战场是 `sessions:shadow-battery`。
   */
  portMismatches: number
  /**
   * 端口事实断言**真的比过**几次(c4)。只打印、不进门,但它是
   * `portMismatches = 0` 那句话的分母 —— 0 次比较的"全对"什么都不是。
   */
  portChecks: number
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
  /**
   * S3w-2(§14.3-B):**refold 自洽环**跑过多少次。
   *
   * 每会话每 N 个 run 采一次(`ONETHING_SESSION_REFOLD_EVERY`,首个 run 必采):
   * 把 `events.jsonl` 的**文件字节**重折出的投影,与**内存活投影**做 canonical
   * 对比。只打印,不进门 —— 采样数多少是配置问题,不是对错问题。
   */
  refoldChecks: number
  /**
   * refold 对不上的次数。**进门,必须是 0。**
   *
   * 它是"停写之后第二来源消失"的替身(§14.3):两侧同源(同一份事件)但路径
   * 独立 —— 文件重读 + 全量 fold vs 内存增量 fold + 队列 append —— 于是恰好盖住
   * 耐久层守的那几类:append 静默丢、坏行、seq 错乱、fsync 缺口、G12 外写者。
   */
  refoldMismatches: number
  /**
   * §17.7.1 批 2(#8b-i):**会话账对拍**真的比过几次。只打印、不进门,但它是
   * `accountMismatches = 0` 那句话的分母 —— 0 次比较的"全对"什么都不是。
   *
   * 它挂在命令写路的尾巴上,而且**不建表**(没有活投影就不比),所以真机上
   * 冷会话的第一条命令通常不计数,战场与端口断言一样是 `sessions:shadow-battery`。
   */
  accountChecks: number
  /**
   * 会话账对拍对不上的次数。**进门,必须是 0。**
   *
   * 两侧:事件流折出来的会话账(a)vs 会话容器上此刻那几格(b)。影子期它证明
   * "`updatedAt` / `lastProvider` / `lastModel` / 截断的用量扣减与 timeline 修复
   * 都折得出来";批 3 断开 reducer 之后这道门连同影子一起退役。
   */
  accountMismatches: number
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
  portMismatches: 0,
  portChecks: 0,
  duplicateMismatches: 0,
  projectionIssues: 0,
  droppedParts: 0,
  refoldChecks: 0,
  refoldMismatches: 0,
  accountChecks: 0,
  accountMismatches: 0,
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
      portMismatches: Number(parsed.portMismatches) || 0,
      portChecks: Number(parsed.portChecks) || 0,
      duplicateMismatches: Number(parsed.duplicateMismatches) || 0,
      // 老账单缺这两格读成 0(而不是读崩)。
      projectionIssues: Number(parsed.projectionIssues) || 0,
      droppedParts: Number(parsed.droppedParts) || 0,
      refoldChecks: Number(parsed.refoldChecks) || 0,
      refoldMismatches: Number(parsed.refoldMismatches) || 0,
      accountChecks: Number(parsed.accountChecks) || 0,
      accountMismatches: Number(parsed.accountMismatches) || 0,
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
  if (patch.portMismatches) stats.portMismatches += patch.portMismatches
  if (patch.portChecks) stats.portChecks += patch.portChecks
  if (patch.refoldChecks) stats.refoldChecks += patch.refoldChecks
  if (patch.refoldMismatches) stats.refoldMismatches += patch.refoldMismatches
  if (patch.accountChecks) stats.accountChecks += patch.accountChecks
  if (patch.accountMismatches) stats.accountMismatches += patch.accountMismatches
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

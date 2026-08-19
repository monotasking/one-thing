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
import { getLogDir } from '../stores/paths.js'

export const SESSION_SHADOW_STATS_FILENAME = 'session-shadow-stats.json'

export interface SessionShadowStats {
  /** 事件/blob 写失败的总次数。门:必须是 0。 */
  appendFailures: number
  /** 完成并比对过的 run 数(S1b 填)。 */
  runs: number
  /** 投影与消息不等的次数(S1b 填)。门:必须是 0。 */
  mismatches: number
  updatedAt?: number
}

const EMPTY: SessionShadowStats = { appendFailures: 0, runs: 0, mismatches: 0 }
const WRITE_THROTTLE_MS = 1000

let cached: SessionShadowStats | undefined
let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null
const warnedSessions = new Set<string>()

export function getSessionShadowStatsPath(): string {
  return path.join(getLogDir(), SESSION_SHADOW_STATS_FILENAME)
}

function load(): SessionShadowStats {
  if (cached) return cached
  try {
    const parsed = JSON.parse(fs.readFileSync(getSessionShadowStatsPath(), 'utf8')) as Partial<SessionShadowStats>
    cached = {
      appendFailures: Number(parsed.appendFailures) || 0,
      runs: Number(parsed.runs) || 0,
      mismatches: Number(parsed.mismatches) || 0,
    }
  } catch {
    cached = { ...EMPTY }
  }
  return cached
}

function writeNow(): void {
  if (!dirty || !cached) return
  dirty = false
  try {
    fs.mkdirSync(getLogDir(), { recursive: true })
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

export function readSessionShadowStats(): SessionShadowStats {
  return { ...load() }
}

export function bumpSessionShadowStats(patch: Partial<SessionShadowStats>): void {
  const stats = load()
  if (patch.appendFailures) stats.appendFailures += patch.appendFailures
  if (patch.runs) stats.runs += patch.runs
  if (patch.mismatches) stats.mismatches += patch.mismatches
  scheduleWrite()
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
  console.warn(`[SessionEvents] ${what} for ${sessionId}:`, error)
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

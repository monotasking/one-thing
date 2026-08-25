/**
 * blob 垃圾治理(S3w-4,`docs/design/session-event-sourcing-2026-08.md` §14.6 / §15.12)。
 *
 * `sessions/<id>/blobs/` 是内容寻址的正文仓库(`blob-store.ts`)。它的删除纪律
 * 一直只有一条:**随会话一起删**(会话目录 `rmSync` 掉,blob 跟着走)。那条纪律
 * 盖不住的是**同一条会话内部**的垃圾:
 *
 *  - 事件遮蔽(`surfaceOp: replace`)之后,被遮掉的那段正文仍然引用着 blob ——
 *    这类**不是**垃圾,引用集按**全量事件**算(遮蔽只影响模型可见面,不影响
 *    账本;trace / refold / verify 都要读得到被遮的那一段);
 *  - 真正的孤儿只有一种来处:**写了 blob 但那条事件没落进去**(队列失败、
 *    G12 拒写、进程在两步之间没了)。内容寻址 + 写一次让它不会重复产生,但
 *    产生过就永远躺在那里 —— 没有任何东西认得它。
 *
 * ## 三条纪律
 *
 * 1. **归档,不硬删**。孤儿移进 `blobs/orphan/`,原名不变。判据(引用扫描)
 *    只要有一处漏认,硬删就是把一段正文从唯一账本里抹掉,而 blob 是**没有第二
 *    份副本**的那一类数据;移动则永远可逆 —— 移回去就好了。
 * 2. **判据与 `sessions:verify` 同源**:`collectSessionBlobRefHashes`(core)。
 *    verify 问"有引用没文件",GC 问"有文件没引用",两侧必须是同一张表 ——
 *    判据分家迟早会分出一边删掉另一边认的东西。
 * 3. **宁可不收,不许错收**。四道跳过闸(见 `scanSessionBlobGc`):没有事件的
 *    会话、事件文件有坏行的会话、太新的 blob、`orphan/` 自己。每一道拦住的都是
 *    "看起来像孤儿其实不是"的一类。
 *
 * 跑法:`bun run sessions:blob-gc`(默认 dry-run,`--apply` 才动手),外加一个
 * **默认关**的启动后延迟触发(`ONETHING_SESSION_BLOB_GC=1`)。
 */

import fs from 'node:fs'
import path from 'node:path'
import { collectSessionBlobRefHashes, parseSessionLogEventLog } from '@onething/core/session'
import { getOnethingSessionsDir } from '@onething/runtime/storage'
import { SESSION_BLOBS_DIRNAME } from './blob-store.js'
import { SESSION_EVENTS_LOG_FILENAME } from './event-log.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.events')

/** 孤儿的归宿:`blobs/orphan/`。会话删了它跟着走(还在会话目录里)。 */
export const SESSION_BLOB_ORPHAN_DIRNAME = 'orphan'

/**
 * 比这个还新的 blob 一律不动(默认 24h)。
 *
 * blob 是**同步**写的,而引用它的那条事件是**排队异步**落盘的 —— 两步之间有一
 * 个窗口,窗口里那个文件在盘上确实"没有引用"。24h 远大于任何一次落盘延迟,
 * 也远大于一次崩溃后重启补写的间隔。
 */
export const SESSION_BLOB_GC_MIN_AGE_MS = 24 * 60 * 60 * 1000

/** 启动后延迟多久跑(默认关;开了也要等启动风暴过去)。 */
const STARTUP_GC_DELAY_MS = 5 * 60 * 1000

export type SessionBlobGcSkipReason =
  | 'no-events'
  | 'malformed-events'
  | 'no-blobs'

export interface SessionBlobGcSessionReport {
  sessionId: string
  /** 跳过的理由(在场 = 这条会话一个字节都没动过)。 */
  skipped?: SessionBlobGcSkipReason
  /** 事件里出现的 blob 引用数。 */
  referenced: number
  /** `blobs/` 下的文件数(不含 `orphan/`)。 */
  present: number
  /** 无引用且够老的那些 hash。 */
  orphans: string[]
  orphanBytes: number
  /** `blobs/` 的总字节(不含 `orphan/`)。 */
  blobBytes: number
  /** 真的移动了几个(dry-run 恒为 0)。 */
  archived: number
  /** 有引用但盘上没有文件的那些 hash(= `sessions:verify` 的 #4,这里只报数)。 */
  missing: number
  errors: string[]
}

export interface SessionBlobGcReport {
  sessionsDir: string
  dryRun: boolean
  sessions: number
  /** 真的扫过(没被跳过)的会话数。 */
  scanned: number
  orphans: number
  orphanBytes: number
  archived: number
  missing: number
  skipped: Record<string, number>
  errors: string[]
  perSession: SessionBlobGcSessionReport[]
}

export interface SessionBlobGcOptions {
  /** 默认 `true` —— 只报数不动手。真要归档必须显式给 `false`。 */
  dryRun?: boolean
  sessionsDir?: string
  sessionIds?: readonly string[]
  minAgeMs?: number
  /** `Date.now()` 的注入口(测试)。 */
  now?: () => number
}

function readTextIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 事件文件有没有**坏行**。
 *
 * `parseSessionLogEventLog` 对认不出的行是**跳过**的(append-only 的读侧纪律)。
 * 那对读投影是对的,对 GC 是致命的:被跳掉的那一行里的引用会凭空消失,而它
 * 指着的 blob 会当场变成"孤儿"。所以这里自己数一遍非空行 —— 对不上就整条
 * 会话不收。
 */
function hasMalformedEventLines(text: string, parsed: number): boolean {
  let lines = 0
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) lines += 1
  }
  return lines !== parsed
}

export function listGcSessionIds(sessionsDir: string): string[] {
  try {
    return fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'legacy-backup')
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 扫一条会话:引用集 vs 盘上文件。`dryRun:false` 时把孤儿移进 `blobs/orphan/`。
 *
 * 四道跳过闸,每一道拦住的都是"看起来像孤儿其实不是"的一类:
 *
 * 1. `no-events` —— 没有 `events.jsonl`(legacy 整文件会话 / 未迁移老会话)。
 *    没有引用集就没有"无引用"这个判断,整个 `blobs/` 会被当成孤儿。
 * 2. `malformed-events` —— 事件文件有读不出的行(见 `hasMalformedEventLines`)。
 * 3. `no-blobs` —— 这条会话根本没有 blob 目录。
 * 4. 太新的文件(`minAgeMs`)与 `orphan/` 目录本身 —— 逐个文件跳过,不影响别的。
 */
export function scanSessionBlobGc(
  sessionId: string,
  options: SessionBlobGcOptions = {},
): SessionBlobGcSessionReport {
  const dryRun = options.dryRun ?? true
  const sessionsDir = options.sessionsDir ?? getOnethingSessionsDir()
  const minAgeMs = options.minAgeMs ?? SESSION_BLOB_GC_MIN_AGE_MS
  const now = (options.now ?? Date.now)()
  const dir = path.join(sessionsDir, sessionId)
  const blobsDir = path.join(dir, SESSION_BLOBS_DIRNAME)
  const empty: SessionBlobGcSessionReport = {
    sessionId,
    referenced: 0,
    present: 0,
    orphans: [],
    orphanBytes: 0,
    blobBytes: 0,
    archived: 0,
    missing: 0,
    errors: [],
  }

  const eventsText = readTextIfExists(path.join(dir, SESSION_EVENTS_LOG_FILENAME))
  if (eventsText === undefined || eventsText.trim().length === 0) {
    return { ...empty, skipped: 'no-events' }
  }
  const events = parseSessionLogEventLog(eventsText)
  if (hasMalformedEventLines(eventsText, events.length)) {
    return { ...empty, skipped: 'malformed-events' }
  }
  const referenced = collectSessionBlobRefHashes(events)

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(blobsDir, { withFileTypes: true })
  } catch {
    return { ...empty, referenced: referenced.size, skipped: 'no-blobs', missing: referenced.size }
  }

  const report: SessionBlobGcSessionReport = { ...empty, referenced: referenced.size }
  const present = new Set<string>()
  const orphanCandidates: Array<{ name: string; bytes: number }> = []
  for (const entry of entries) {
    // `orphan/` 是本治理件自己的归档目录,不是内容 —— 它以及任何别的子目录都不看。
    if (!entry.isFile()) continue
    let stat: fs.Stats
    try {
      stat = fs.statSync(path.join(blobsDir, entry.name))
    } catch {
      continue
    }
    present.add(entry.name)
    report.blobBytes += stat.size
    if (referenced.has(entry.name)) continue
    // 太新 = 可能只是那条事件还没落盘(见 `SESSION_BLOB_GC_MIN_AGE_MS`)。
    if (now - stat.mtimeMs < minAgeMs) continue
    orphanCandidates.push({ name: entry.name, bytes: stat.size })
  }
  report.present = present.size
  for (const hash of referenced) {
    if (!present.has(hash)) report.missing += 1
  }
  report.orphans = orphanCandidates.map(entry => entry.name)
  report.orphanBytes = orphanCandidates.reduce((sum, entry) => sum + entry.bytes, 0)

  if (dryRun || orphanCandidates.length === 0) return report

  const orphanDir = path.join(blobsDir, SESSION_BLOB_ORPHAN_DIRNAME)
  try {
    fs.mkdirSync(orphanDir, { recursive: true })
  } catch (error) {
    report.errors.push(`mkdir orphan dir failed: ${String(error)}`)
    return report
  }
  for (const candidate of orphanCandidates) {
    try {
      // 归档,不硬删(纪律 1)。同名已经在 `orphan/` 下 = 上一轮已经归过档:
      // 内容寻址下同名必然同内容,直接覆盖不会丢东西。
      fs.renameSync(path.join(blobsDir, candidate.name), path.join(orphanDir, candidate.name))
      report.archived += 1
    } catch (error) {
      report.errors.push(`archive ${candidate.name} failed: ${String(error)}`)
    }
  }
  return report
}

/** 全库(或指定会话)跑一轮。默认 dry-run。 */
export function runSessionBlobGc(options: SessionBlobGcOptions = {}): SessionBlobGcReport {
  const sessionsDir = options.sessionsDir ?? getOnethingSessionsDir()
  const ids = options.sessionIds ?? listGcSessionIds(sessionsDir)
  const perSession = ids.map(id => scanSessionBlobGc(id, { ...options, sessionsDir }))
  const skipped: Record<string, number> = {}
  const report: SessionBlobGcReport = {
    sessionsDir,
    dryRun: options.dryRun ?? true,
    sessions: perSession.length,
    scanned: 0,
    orphans: 0,
    orphanBytes: 0,
    archived: 0,
    missing: 0,
    skipped,
    errors: [],
    perSession,
  }
  for (const entry of perSession) {
    // `missing`(有引用没文件)先算 —— 跳过的会话也可能有:`no-blobs` 那一支
    // 说的正是"引用在、目录不在"。它不是 GC 的判断对象(GC 只动多出来的文件),
    // 但报表把它报成 0 就是在说一句假话。
    report.missing += entry.missing
    if (entry.skipped) {
      skipped[entry.skipped] = (skipped[entry.skipped] ?? 0) + 1
      continue
    }
    report.scanned += 1
    report.orphans += entry.orphans.length
    report.orphanBytes += entry.orphanBytes
    report.archived += entry.archived
    for (const error of entry.errors) report.errors.push(`${entry.sessionId}: ${error}`)
  }
  return report
}

/**
 * 启动后延迟跑一轮 —— **默认关**。
 *
 * `ONETHING_SESSION_BLOB_GC` 三档:未设 / `0` = 不跑;`dry-run` = 跑但只记账;
 * `1` / `apply` = 真归档。延迟 5 分钟是为了不和启动风暴抢 IO,定时器 `unref`
 * 所以它自己留不住进程。返回 disposer(关停时取消)。
 */
export function scheduleSessionBlobGcOnStartup(
  options: { delayMs?: number } = {},
): (() => void) | undefined {
  const mode = process.env.ONETHING_SESSION_BLOB_GC
  if (!mode || mode === '0') return undefined
  const dryRun = mode === 'dry-run'
  const timer = setTimeout(() => {
    try {
      const report = runSessionBlobGc({ dryRun })
      log.info('session blob gc finished', {
        dryRun,
        sessions: report.sessions,
        scanned: report.scanned,
        orphans: report.orphans,
        orphanBytes: report.orphanBytes,
        archived: report.archived,
      })
    } catch (error) {
      log.warn('session blob gc failed', { dryRun }, error)
    }
  }, options.delayMs ?? STARTUP_GC_DELAY_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return () => clearTimeout(timer)
}

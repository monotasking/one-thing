#!/usr/bin/env node
/**
 * 老会话 → 事件日志的迁移(S2a **只实现 `--dry-run`**,§11.1)。
 *
 *   bun run migrate:sessions:events --dry-run [--store PATH] [--json] [--limit N]
 *
 * 今天的老会话在事件层是**空的**:它们的历史事实住在 `messages.jsonl` 里,
 * `events.jsonl`(如果有)只记着 S1 之后那几条七类事件。迁移就是把每条消息
 * 合成一条 `message/imported`,让投影从此有话可说。
 *
 * 本期一个字节都不写 —— `--apply` 明确拒绝(退出码 2)。这一版要回答的是
 * "如果写,会发生什么":哪些文件在白名单里、哪些不认识、每间会话会多出多少
 * 事件与多少字节、已经有 events.jsonl 的会话要怎么重编号、以及**现在有没有
 * 人正在用这个 store**。
 *
 * ## 合成规则(报告里逐条列出来的那份)
 *
 *  - 一条消息一条 `message/imported`,`surfaceOp: 'append'`;
 *  - 事件的 `time` 取**消息自己的 timestamp**(不是迁移时刻 —— 迁移不该给
 *    历史重新盖一遍时间戳);
 *  - `data.synthetic: true`:合成出来的账与真的记下来的账必须分得清;
 *  - 顺序 = `messages.jsonl` 里的顺序,seq 从 1 起;
 *  - 已经有 `events.jsonl` 的会话:imported 插在**现有事件之前**,现有事件
 *    整体 +N 重编号,内部引用(`surfaceOp.start/end`、`sourceEventSeqs`、
 *    `sourceSeq`、`triggerEventSeq`)同步平移。理由:导入的历史发生在那些
 *    事件之前,倒过来的话 surface 的呈现序就错了。
 *
 * **只读**:全程 `readFileSync` / `statSync`,不写任何文件(连日志也只打到
 * stdout)。真实 `~/.onething` 上跑它是安全的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 会话目录里认得的文件(§11.1 的白名单)。 */
export const SESSION_DIR_WHITELIST = new Set([
  'meta.json',
  'messages.jsonl',
  'events.jsonl',
  'segments.jsonl',
])
/** 会话目录里认得的前缀 / 子目录。 */
export const SESSION_DIR_PREFIXES = ['messages.cleared-']
export const SESSION_DIR_SUBDIRS = new Set(['blobs', 'legacy-backup'])
/** `sessions/` 根下认得的东西:会话目录、legacy 整文件、备份目录。 */
export const SESSIONS_ROOT_SUBDIRS = new Set(['legacy-backup'])

/** 迁移会重写 seq 的那些引用字段(重编号计划按它数)。 */
const SEQ_REFERENCE_FIELDS = ['sourceSeq', 'triggerEventSeq']

export function resolveStorePath(explicit) {
  return explicit || process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
}

function isKnownSessionFile(name) {
  if (SESSION_DIR_WHITELIST.has(name)) return true
  return SESSION_DIR_PREFIXES.some(prefix => name.startsWith(prefix))
}

/** 一条 `message/imported` 落到盘上有多少字节(不写,只算)。 */
function importedLineBytes(message, seq) {
  return Buffer.byteLength(JSON.stringify({
    seq,
    time: typeof message?.timestamp === 'number' ? message.timestamp : 0,
    type: 'message/imported',
    data: { message, synthetic: true },
    surfaceOp: 'append',
  }), 'utf8') + 1
}

/** messages.jsonl 逐行(只认 `{t:'m'}`;header 与半行跳过)。 */
function readTranscript(file, maxExactBytes) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return undefined
  }
  if (stat.size > maxExactBytes) {
    // 太大就不逐条算了:比例估算并自报"这是估的"。经验比例来自逐条算过的
    // 会话(imported 只比原行多一层外壳)。
    return { messages: undefined, count: undefined, bytes: stat.size, estimated: true }
  }
  const text = fs.readFileSync(file, 'utf8')
  let count = 0
  let addedBytes = 0
  let corrupt = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      corrupt += 1
      continue
    }
    if (record?.t !== 'm' || !record.m) continue
    count += 1
    addedBytes += importedLineBytes(record.m, count)
  }
  return { count, addedBytes, bytes: stat.size, corrupt, estimated: false }
}

/** 现有 events.jsonl 的条数 + 需要平移的引用处数。 */
function readExistingEvents(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { events: 0, bytes: 0, references: 0 }
  }
  let events = 0
  let references = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record?.seq !== 'number') continue
    events += 1
    if (record.surfaceOp && typeof record.surfaceOp === 'object') references += 2
    if (Array.isArray(record.sourceEventSeqs)) references += record.sourceEventSeqs.length
    for (const field of SEQ_REFERENCE_FIELDS) {
      if (typeof record.data?.[field] === 'number') references += 1
    }
  }
  return { events, bytes: Buffer.byteLength(text, 'utf8'), references }
}

export function planSession(sessionsDir, sessionId, options = {}) {
  const maxExactBytes = options.maxExactBytes ?? 64 * 1024 * 1024
  const dir = path.join(sessionsDir, sessionId)
  const unknown = []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SESSION_DIR_SUBDIRS.has(entry.name)) unknown.push(`${sessionId}/${entry.name}/`)
      continue
    }
    if (!isKnownSessionFile(entry.name)) unknown.push(`${sessionId}/${entry.name}`)
  }

  const transcript = readTranscript(path.join(dir, 'messages.jsonl'), maxExactBytes)
  const existing = readExistingEvents(path.join(dir, 'events.jsonl'))

  const importedCount = transcript?.count ?? 0
  const addedBytes = transcript?.addedBytes ?? Math.round((transcript?.bytes ?? 0) * 1.08)

  return {
    sessionId,
    unknown,
    hasTranscript: Boolean(transcript),
    transcriptBytes: transcript?.bytes ?? 0,
    transcriptCorruptLines: transcript?.corrupt ?? 0,
    estimated: Boolean(transcript?.estimated),
    imported: importedCount,
    existingEvents: existing.events,
    // 重编号计划:现有事件整体 +N,内部引用同步平移。
    renumber: existing.events > 0
      ? { shift: importedCount, events: existing.events, references: existing.references }
      : undefined,
    bytesBefore: existing.bytes,
    bytesAfter: existing.bytes + addedBytes,
  }
}

/** 现在有人在用这个 store 吗(只检测,不动)。 */
export function detectLiveness(store) {
  const runDir = path.join(store, 'run')
  const result = { lock: undefined, http: undefined, alive: false }
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(runDir, 'backend.lock'), 'utf8'))
    result.lock = { pid: lock.pid, owner: lock.owner, acquiredAt: lock.acquiredAt }
    if (typeof lock.pid === 'number') {
      try {
        process.kill(lock.pid, 0)
        result.alive = true
      } catch {
        result.alive = false
      }
    }
  } catch { /* 没有锁文件 = 没有人拿着这个 store */ }
  try {
    const http = JSON.parse(fs.readFileSync(path.join(runDir, 'http.json'), 'utf8'))
    result.http = { port: http.port, pid: http.pid }
    if (typeof http.pid === 'number' && !result.alive) {
      try {
        process.kill(http.pid, 0)
        result.alive = true
      } catch { /* 陈旧的发现文件 */ }
    }
  } catch { /* 没有发现文件 */ }
  return result
}

export function buildPlan(store, options = {}) {
  const sessionsDir = path.join(store, 'sessions')
  const rootUnknown = []
  const sessionIds = []
  let legacyJsonFiles = 0
  let entries = []
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true })
  } catch { /* 空 store */ }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SESSIONS_ROOT_SUBDIRS.has(entry.name)) continue
      sessionIds.push(entry.name)
      continue
    }
    // legacy 整文件会话:`sessions/<id>.json`,迁移时同样逐条 imported。
    if (entry.name.endsWith('.json')) {
      legacyJsonFiles += 1
      continue
    }
    rootUnknown.push(entry.name)
  }

  sessionIds.sort()
  const limited = options.limit ? sessionIds.slice(0, options.limit) : sessionIds
  const sessions = limited
    .map(id => planSession(sessionsDir, id, options))
    .filter(Boolean)

  const totals = sessions.reduce((acc, session) => ({
    imported: acc.imported + session.imported,
    existingEvents: acc.existingEvents + session.existingEvents,
    bytesBefore: acc.bytesBefore + session.bytesBefore,
    bytesAfter: acc.bytesAfter + session.bytesAfter,
    transcriptBytes: acc.transcriptBytes + session.transcriptBytes,
    renumbered: acc.renumbered + (session.renumber ? 1 : 0),
    estimated: acc.estimated + (session.estimated ? 1 : 0),
    corrupt: acc.corrupt + session.transcriptCorruptLines,
  }), { imported: 0, existingEvents: 0, bytesBefore: 0, bytesAfter: 0, transcriptBytes: 0, renumbered: 0, estimated: 0, corrupt: 0 })

  return {
    store,
    sessions,
    sessionCount: sessionIds.length,
    scanned: sessions.length,
    legacyJsonFiles,
    unknown: [...rootUnknown.map(name => `sessions/${name}`), ...sessions.flatMap(session => session.unknown)],
    totals,
    liveness: detectLiveness(store),
  }
}

const SYNTHESIS_RULES = [
  '一条消息 → 一条 `message/imported`(`surfaceOp: append`)',
  '事件 `time` = 消息自己的 `timestamp`(不盖迁移时刻)',
  '`data.synthetic = true`(合成的账与记下来的账分得清)',
  'seq 从 1 起,顺序 = messages.jsonl 的顺序',
  '已有 events.jsonl:imported 插在现有事件之前,现有事件整体 +N 重编号',
  '内部引用(surfaceOp.start/end、sourceEventSeqs、sourceSeq、triggerEventSeq)同步平移',
]

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function parseArgs(argv) {
  const args = { dryRun: false, apply: false, store: undefined, json: false, limit: 0, top: 10 }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--apply') args.apply = true
    else if (arg === '--json') args.json = true
    else if (arg === '--store') args.store = argv[++index]
    else if (arg.startsWith('--store=')) args.store = arg.slice('--store='.length)
    else if (arg === '--limit') args.limit = Number(argv[++index]) || 0
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice('--limit='.length)) || 0
    else if (arg === '--top') args.top = Math.max(0, Number(argv[++index]) || 0)
    else if (arg.startsWith('--top=')) args.top = Math.max(0, Number(arg.slice('--top='.length)) || 0)
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.apply) {
    console.error('[migrate] --apply 被拒绝:S2b 未拍板(切默认读模式 + 真实 store 迁移都要用户先拍)。')
    console.error('[migrate] 本期只有 --dry-run:它只读,不写任何文件。')
    process.exit(2)
  }
  if (!args.dryRun) {
    console.error('[migrate] 用法:bun run migrate:sessions:events --dry-run [--store PATH] [--json] [--limit N]')
    process.exit(2)
  }

  const plan = buildPlan(resolveStorePath(args.store), { limit: args.limit })

  if (args.json) {
    console.log(JSON.stringify(plan, null, 2))
    process.exit(0)
  }

  console.log(`[migrate] DRY RUN(只读,不写任何文件) store=${plan.store}`)
  console.log(`[migrate] 会话目录 ${plan.sessionCount} 间(本次估算 ${plan.scanned} 间),legacy 整文件 ${plan.legacyJsonFiles} 份`)
  console.log(`[migrate] 合成 message/imported ${plan.totals.imported} 条;已有事件 ${plan.totals.existingEvents} 条,其中 ${plan.totals.renumbered} 间会话要重编号`)
  console.log(`[migrate] events.jsonl 字节 ${mb(plan.totals.bytesBefore)} → ${mb(plan.totals.bytesAfter)}(messages.jsonl 现为 ${mb(plan.totals.transcriptBytes)})`)
  if (plan.totals.estimated > 0) console.log(`[migrate] 其中 ${plan.totals.estimated} 间会话太大,按比例估算(未逐条算)`)
  if (plan.totals.corrupt > 0) console.log(`[migrate] messages.jsonl 里有 ${plan.totals.corrupt} 行解不开(迁移时会跳过)`)

  console.log('[migrate] 合成规则:')
  for (const rule of SYNTHESIS_RULES) console.log(`  - ${rule}`)

  if (plan.unknown.length > 0) {
    console.log(`[migrate] 不认识的文件 ${plan.unknown.length} 个(迁移不会碰它们):`)
    for (const name of plan.unknown.slice(0, 20)) console.log(`  ? ${name}`)
    if (plan.unknown.length > 20) console.log(`  … 还有 ${plan.unknown.length - 20} 个`)
  } else {
    console.log('[migrate] 不认识的文件:无')
  }

  const top = [...plan.sessions].sort((a, b) => b.imported - a.imported).slice(0, args.top)
  if (top.length > 0) {
    console.log(`[migrate] 最大的 ${top.length} 间:`)
    for (const session of top) {
      const renumber = session.renumber ? ` renumber(+${session.renumber.shift}, refs ${session.renumber.references})` : ''
      console.log(`  ${session.sessionId}  imported=${session.imported}${session.estimated ? '(估)' : ''} events=${session.existingEvents} bytes ${mb(session.bytesBefore)}→${mb(session.bytesAfter)}${renumber}`)
    }
  }

  const live = plan.liveness
  if (live.alive) {
    console.log(`[migrate] ⚠ 这个 store 正在被使用(lock pid=${live.lock?.pid} owner=${live.lock?.owner}${live.http ? `, http :${live.http.port}` : ''})——`)
    console.log('[migrate]   真要迁移必须先让它退出;本次是 dry-run,什么都没做。')
  } else if (live.lock || live.http) {
    console.log(`[migrate] 发现陈旧的 run 文件(进程已不在):${JSON.stringify(live)}`)
  } else {
    console.log('[migrate] 没有人拿着这个 store(run/ 下没有活着的锁或发现文件)')
  }

  process.exit(0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}

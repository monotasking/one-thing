#!/usr/bin/env node
/**
 * 老会话 → 事件日志的迁移(§11.1 / §11.2)。
 *
 *   node scripts/migrate-sessions-events.mjs --dry-run [--store PATH] [--json] [--limit N]
 *   node scripts/migrate-sessions-events.mjs --apply   [--store PATH] [--json] [--limit N]
 *   node scripts/migrate-sessions-events.mjs --rollback <sessionId>|--all [--store PATH]
 *
 * 今天的老会话在事件层是**空的**:它们的历史事实住在 `messages.jsonl` 里,
 * `events.jsonl`(如果有)只记着 S1 之后那几条七类事件(E0,工具/请求级,
 * 折不出任何一条消息)。迁移就是把每条消息合成一条 `message/imported`,让
 * 投影从此有话可说。
 *
 * `--dry-run` 只回答"如果写会发生什么":白名单、未知文件、每间会话多出多少
 * 事件与字节、已有 events.jsonl 的会话怎么重编号、现在有没有人在用这个 store。
 * 全程只读,真实 `~/.onething` 上跑它是安全的。
 *
 * `--apply` 真的写(S2b):按 dry-run 的计划把 `message/imported` 落进
 * `events.jsonl`。**先备份、再原子写**;幂等(重跑是 no-op);出错就跳过那间,
 * 不半写坏文件。R-c 硬前置照旧在最前面 —— 有活的 core 拿着这个 store 就拒绝
 * 运行,没有绕过口。
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
 *    `sourceSeq`、`triggerEventSeq`、`request/recipe.messages[].eventSeq`)同步
 *    平移。理由:导入的历史发生在那些事件之前,倒过来的话 surface 的呈现序就错了。
 *
 * ## 谁需要迁移 / 谁不动(§11.3 裁定 4、§10.16)
 *
 * `--apply` 只碰**折不出任何一条消息节点**的会话(E0 七类 / 空事件)——它们
 * 的历史还只在 `messages.jsonl` 里。判据看事件类型:
 *  - 已有 `message/imported` = 这间已经迁过 → **no-op**(幂等的带内标记);
 *  - 已有 `user/message` / `system/message` / `run/start` / `session/compacted`
 *    / `user/message-edited` 任何一类节点 = 事件里已有原生覆盖 → **跳过并报告**
 *    (原生尾覆盖 + 未覆盖头 的"混合覆盖会话"要 S2b 的覆盖感知合并,朴素的
 *    "全量导入 + 重编号"会把尾巴导重 → 投影撞 id;所以这里不碰,不弄坏它);
 *  - 否则(E0 / 空)= **要迁**。真实 store 上绝大多数会话是这一类(§11.3)。
 *
 * ## 备份策略(copy,不 move)
 *
 * §11.2 的意图是"原件留着可回滚"。这里**复制**原 `messages.jsonl`(以及迁移
 * 前的 `events.jsonl`,如果有)到会话目录内的 `legacy-backup/` —— 复制而非
 * 移动,好让 `messages` 读模式在切默认之前照旧工作(B8 记的"就地作快照 vs 备份
 * 到 legacy-backup"矛盾,这里判给**复制**:两份都留,原地那份继续被读)。
 * 一份 `legacy-backup/events-migration.json` 记着迁移出处,供 `--rollback` 认路。
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

/**
 * 现在有人在用这个 store 吗(只检测,不动)。
 *
 * R-c(2026-08-20 用户裁定,§13.6):**这是硬前置,不是提示。**
 *
 * server 撤锁的裁定还成立(不复活常驻锁),但那条裁定与"迁移/切读"是两件事:
 * 迁移要重编号整份 `events.jsonl`(现有事件整体 +N,内部引用同步平移),
 * 而活着的 core 正拿着**内存里的 seq 计数器**在往同一个文件追加 —— 两个写者
 * 铸同一个 seq,replace 遮蔽的就是错的区间,而校验会照样放行(surface 上确实
 * 有那个 seq)。所以有活的 core 就**拒绝运行**,没有 `--force` 之类的绕过口。
 *
 * "活"的判据与 `server:start` 那条让位逻辑同口径:pid 还在 **且** 端口连得上。
 */
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

/**
 * 发现文件上那个端口连得上吗(pid 活着还不够 —— pid 可能被复用)。
 *
 * 连不上就当它不在:那是一份陈旧的发现文件。
 */
export async function httpDiscoveryPortIsOpen(http) {
  if (!http || typeof http.port !== 'number' || http.port <= 0) return false
  const net = await import('node:net')
  return await new Promise(resolve => {
    const socket = net.connect({ port: http.port, host: '127.0.0.1' })
    const done = value => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * 迁移的硬前置(R-c)。@returns 拦下的理由,`undefined` = 可以往下走。
 */
export async function blockingLivenessReason(liveness) {
  if (!liveness) return undefined
  const portOpen = await httpDiscoveryPortIsOpen(liveness.http)
  if (liveness.alive && (portOpen || !liveness.http)) {
    return liveness.http
      ? `这个 store 正在被 ${liveness.http.pid ?? liveness.lock?.pid} 号进程服务(http :${liveness.http.port} 连得上)`
      : `这个 store 被 ${liveness.lock?.owner ?? '某个进程'}(pid ${liveness.lock?.pid})占着`
  }
  return undefined
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

// ============ --apply(§11.2)============

/** 迁移出处 + 备份指纹,住在会话目录内的 legacy-backup/(白名单子目录)。 */
const MIGRATION_MARKER = 'events-migration.json'
const BACKUP_DIR = 'legacy-backup'

/** 会造出一个 surface **消息节点**的事件类型(E0 的 tool/result 折进 run,不算)。 */
const MESSAGE_NODE_TYPES = new Set([
  'user/message',
  'system/message',
  'user/message-edited',
  'message/imported',
  'run/start',
  'session/compacted',
])

/** 逐条读出 messages.jsonl 里的消息(原样,不设大小上限 —— apply 必须导全)。 */
function readMessagesForApply(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const messages = []
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
    messages.push(record.m)
  }
  return { messages, corrupt }
}

/** 逐条读出 events.jsonl 的原始记录(按 seq 稳定升序;半行/空行跳过)。 */
function readEventRecords(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { records: [], existed: false }
  }
  const parsed = []
  let order = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record?.seq !== 'number' || !Number.isFinite(record.seq)) continue
    parsed.push({ record, order: order++ })
  }
  parsed.sort((a, b) => (a.record.seq - b.record.seq) || (a.order - b.order))
  return { records: parsed.map(entry => entry.record), existed: true }
}

/** 事件里现有的覆盖形态:'imported'(迁过)/ 'native'(有原生节点)/ 'none'(E0 或空)。 */
export function coverageState(records) {
  let hasImported = false
  let hasNative = false
  for (const record of records) {
    if (record.type === 'message/imported') hasImported = true
    else if (MESSAGE_NODE_TYPES.has(record.type)) hasNative = true
  }
  if (hasImported) return 'imported'
  if (hasNative) return 'native'
  return 'none'
}

/**
 * 一条事件在投影里落成的**消息节点 id**(折不出消息节点的事件返回 undefined)。
 * 与 `events-reads.ts` 的节点身份一致:user/system/imported → `data.message.id`,
 * `run/start` → `data.assistantMessageId`,`user/message-edited` → `data.messageId`。
 * `session/compacted` 的压缩卡 id 不在这里认 —— 认不出的覆盖会被下面的“干净后缀”
 * 判据当成未覆盖,从而保守跳过,绝不硬合。
 */
function coveredMessageId(record) {
  const data = record?.data
  if (!data) return undefined
  switch (record.type) {
    case 'user/message':
    case 'system/message':
    case 'message/imported':
      return data.message?.id
    case 'run/start':
      return data.assistantMessageId
    case 'user/message-edited':
      return data.messageId ?? data.message?.id
    default:
      return undefined
  }
}

/** 现有事件覆盖到的消息 id 集合(覆盖感知合并的依据)。 */
function coveredMessageIds(records) {
  const ids = new Set()
  for (const record of records) {
    const id = coveredMessageId(record)
    if (typeof id === 'string') ids.add(id)
  }
  return ids
}

/**
 * 覆盖感知合并的计划(§13.15 / §10.16 混合覆盖会话)。混合覆盖 = S1 升级切面:
 * `events.jsonl` 只从升级点起记着尾巴那几条**原生消息节点**,而 `messages.jsonl`
 * 里还压着升级之前的**未覆盖头**。切默认到 `events` 后,`eventsListMessages` 折出
 * 的只有尾巴(`state.nodes.length > 0` 就不再退回 messages 模式),头会**整段丢失**。
 *
 * 只在“未覆盖消息恰是一段前缀、其后全部被覆盖”(干净前缀 / 干净后缀)时才合并:
 * 导入这段头为 `message/imported`、把尾巴事件整体重编号留在后面,投影 = 头 + 尾 =
 * 全份历史。任何“洞”(尾巴里仍有未覆盖消息)都**不硬合** —— 朴素全量导入会撞 id、
 * `verify` 的 covered-message-order 当场红,宁可跳过并报告,留人工处理。
 *
 * @returns {{kind:'covered'|'merge'|'unsafe', headCount?:number, reason?:string}}
 */
function planNativeMerge(messages, existing) {
  const covered = coveredMessageIds(existing)
  let firstCovered = -1
  for (let index = 0; index < messages.length; index++) {
    const id = messages[index]?.id
    if (id && covered.has(id)) { firstCovered = index; break }
  }
  if (firstCovered === -1) {
    return { kind: 'unsafe', reason: '事件覆盖的消息 id 在 messages.jsonl 里找不到(非前缀覆盖)' }
  }
  const suffixAllCovered = messages
    .slice(firstCovered)
    .every(message => message?.id && covered.has(message.id))
  if (!suffixAllCovered) {
    return { kind: 'unsafe', reason: '覆盖不是干净后缀(尾巴里仍有未覆盖消息)' }
  }
  if (firstCovered === 0) return { kind: 'covered' }
  return { kind: 'merge', headCount: firstCovered }
}

/** 一条 message/imported 记录(与 dry-run 的 importedLineBytes 逐字段同形)。 */
function makeImportedRecord(message, seq) {
  return {
    seq,
    time: typeof message?.timestamp === 'number' ? message.timestamp : 0,
    type: 'message/imported',
    data: { message, synthetic: true },
    surfaceOp: 'append',
  }
}

/**
 * 把一条现有事件整体平移:seq 与所有内部 seq 引用都过 `remap`。
 *
 * 引用字段(§9.1 + §11.1):顶层 `surfaceOp.{start,end}` / `sourceEventSeqs[]`,
 * data 里的 `sourceSeq` / `triggerEventSeq` / `messages[].eventSeq`(request/recipe)。
 * remap 认不出的 seq(迁移前就悬着的引用)按 +shift 兜底,不新造错乱。
 */
function shiftEventRecord(record, remap) {
  const next = { ...record, seq: remap(record.seq) }
  if (next.surfaceOp && typeof next.surfaceOp === 'object') {
    next.surfaceOp = { ...next.surfaceOp, start: remap(next.surfaceOp.start), end: remap(next.surfaceOp.end) }
  }
  if (Array.isArray(next.sourceEventSeqs)) {
    next.sourceEventSeqs = next.sourceEventSeqs.map(seq => (typeof seq === 'number' ? remap(seq) : seq))
  }
  if (next.data && typeof next.data === 'object') {
    const data = { ...next.data }
    for (const field of SEQ_REFERENCE_FIELDS) {
      if (typeof data[field] === 'number') data[field] = remap(data[field])
    }
    if (Array.isArray(data.messages)) {
      data.messages = data.messages.map(entry =>
        entry && typeof entry === 'object' && typeof entry.eventSeq === 'number'
          ? { ...entry, eventSeq: remap(entry.eventSeq) }
          : entry)
    }
    next.data = data
  }
  return next
}

/** 原子写:先写 .tmp 再 rename(崩溃只会留下 .tmp,不会半写坏正本)。 */
function atomicWrite(file, text) {
  const tmp = `${file}.migrate-tmp.${process.pid}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

/**
 * 迁移一间会话。@returns 结果对象
 * (status:migrated|merged|covered|noop|skipped|error|empty)。
 *
 *  - `migrated` = E0/空会话,全量导入 `message/imported`;
 *  - `merged`   = 混合覆盖会话(原生尾 + 未覆盖头),**只导未覆盖头**、尾巴事件重编号留后;
 *  - `covered`  = 原生事件已全覆盖,无未覆盖头 → 一个字节都不动;
 *  - `skipped`  = 覆盖不是干净前缀/后缀(有洞),须人工处理,不硬合;
 *  - `noop`     = 已迁过(带内 imported 标记);`empty` = 没消息;`error` = 出错。
 *
 * 不抛:任何一间出错都收进结果的 error 字段,由调用方跳过并汇报。
 */
export function applySession(sessionsDir, sessionId) {
  const dir = path.join(sessionsDir, sessionId)
  const eventsFile = path.join(dir, 'events.jsonl')
  const messagesFile = path.join(dir, 'messages.jsonl')
  try {
    const transcript = readMessagesForApply(messagesFile)
    if (!transcript || transcript.messages.length === 0) {
      return { sessionId, status: 'empty', reason: 'messages.jsonl 缺失或没有消息' }
    }
    const { records: existing } = readEventRecords(eventsFile)
    const coverage = coverageState(existing)
    if (coverage === 'imported') {
      return { sessionId, status: 'noop', reason: '已有 message/imported(迁过了)' }
    }

    // 覆盖感知:E0/空 = 全量导入;原生覆盖 = 分“已全覆盖 / 混合(导头留尾)/ 不可合”。
    let importedMessages
    let mode
    let firstCoveredIndex
    if (coverage === 'native') {
      const plan = planNativeMerge(transcript.messages, existing)
      if (plan.kind === 'covered') {
        return { sessionId, status: 'covered', reason: '事件已全覆盖(无未覆盖头,无需迁移)' }
      }
      if (plan.kind === 'unsafe') {
        return { sessionId, status: 'skipped', reason: `混合覆盖须人工处理:${plan.reason}` }
      }
      firstCoveredIndex = plan.headCount
      importedMessages = transcript.messages.slice(0, plan.headCount)
      mode = 'merged'
    } else {
      importedMessages = transcript.messages
      mode = 'migrated'
    }

    const importedRecords = importedMessages.map((message, index) => makeImportedRecord(message, index + 1))
    const shift = importedRecords.length

    // 现有事件整体重编号到 [shift+1, …];建 old→new 映射,兜底 +shift。
    // 全量导入(migrated)遮的是折不出消息的 E0 尾;合并(merged)留下的是原生尾。
    const seqMap = new Map()
    existing.forEach((record, index) => seqMap.set(record.seq, shift + index + 1))
    const remap = old => seqMap.get(old) ?? (typeof old === 'number' ? old + shift : old)
    const shiftedExisting = existing.map(record => shiftEventRecord(record, remap))

    const eventsBytesBefore = existing.length > 0
      ? Buffer.byteLength(fs.readFileSync(eventsFile, 'utf8'), 'utf8')
      : 0

    // 备份(复制,不移动)。备份已存在 = 拒绝覆盖(那是一份更早的原件)。
    const backupDir = path.join(dir, BACKUP_DIR)
    fs.mkdirSync(backupDir, { recursive: true })
    const backupMessages = path.join(backupDir, 'messages.jsonl')
    const backupEvents = path.join(backupDir, 'events.jsonl')
    if (fs.existsSync(backupMessages)) {
      return { sessionId, status: 'error', reason: `备份已存在(不覆盖):${backupMessages}` }
    }
    fs.copyFileSync(messagesFile, backupMessages)
    const hadEvents = existing.length > 0 || fs.existsSync(eventsFile)
    if (hadEvents && fs.existsSync(eventsFile)) fs.copyFileSync(eventsFile, backupEvents)

    // 原子写新的 events.jsonl:imported(seq 1..N)+ 平移后的现有事件。
    const lines = [...importedRecords, ...shiftedExisting].map(record => `${JSON.stringify(record)}\n`).join('')
    atomicWrite(eventsFile, lines)
    const eventsBytesAfter = Buffer.byteLength(lines, 'utf8')

    const marker = {
      migratedAt: new Date().toISOString(),
      sessionId,
      mode,
      imported: importedRecords.length,
      ...(mode === 'merged' ? { firstCoveredIndex } : {}),
      existingEventsBefore: existing.length,
      shiftedBy: shift,
      eventsBytesBefore,
      eventsBytesAfter,
      corruptMessageLines: transcript.corrupt,
      backup: {
        messages: path.relative(dir, backupMessages),
        events: hadEvents ? path.relative(dir, backupEvents) : null,
      },
    }
    fs.writeFileSync(path.join(backupDir, MIGRATION_MARKER), `${JSON.stringify(marker, null, 2)}\n`)

    return {
      sessionId,
      status: mode,
      imported: importedRecords.length,
      existingEvents: existing.length,
      shiftedBy: shift,
      ...(mode === 'merged' ? { firstCoveredIndex } : {}),
      eventsBytesBefore,
      eventsBytesAfter,
      backupPath: path.relative(sessionsDir, backupDir),
      corrupt: transcript.corrupt,
    }
  } catch (error) {
    return { sessionId, status: 'error', reason: String(error?.message ?? error) }
  }
}

export function applyMigration(store, options = {}) {
  const sessionsDir = path.join(store, 'sessions')
  const plan = buildPlan(store, { limit: options.limit })
  const results = plan.sessions.map(session => applySession(sessionsDir, session.sessionId))
  const tally = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1
    if (result.status === 'migrated' || result.status === 'merged') {
      acc.importedEvents += result.imported
      acc.bytesBefore += result.eventsBytesBefore
      acc.bytesAfter += result.eventsBytesAfter
    }
    return acc
  }, { migrated: 0, merged: 0, covered: 0, noop: 0, skipped: 0, error: 0, empty: 0, importedEvents: 0, bytesBefore: 0, bytesAfter: 0 })
  return { store, results, tally, legacyJsonFiles: plan.legacyJsonFiles }
}

// ============ --rollback(§11.2)============

/**
 * 回滚一间会话:从 legacy-backup/ 复原 events.jsonl(迁移前没有事件的就删掉),
 * 删掉迁移标记。messages.jsonl 迁移时是复制的、从未被改,所以不用动。
 */
export function rollbackSession(sessionsDir, sessionId) {
  const dir = path.join(sessionsDir, sessionId)
  const backupDir = path.join(dir, BACKUP_DIR)
  const markerFile = path.join(backupDir, MIGRATION_MARKER)
  try {
    let marker
    try {
      marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
    } catch {
      return { sessionId, status: 'not-migrated', reason: '没有迁移标记(这间没被本脚本迁过)' }
    }
    const eventsFile = path.join(dir, 'events.jsonl')
    const backupEvents = path.join(backupDir, 'events.jsonl')
    const restoredEvents = Boolean(marker.backup?.events) && fs.existsSync(backupEvents)
    if (restoredEvents) {
      // 有迁移前的事件 → 原子复原。
      atomicWrite(eventsFile, fs.readFileSync(backupEvents))
    } else {
      // 迁移前没有事件 → 删掉合成出来的 events.jsonl。
      if (fs.existsSync(eventsFile)) fs.rmSync(eventsFile)
    }

    // 清掉本脚本造出来的备份 + 标记(复制来的,原件一直在原地),让这间回到
    // 真正的迁移前状态 —— 否则下一次 --apply 会撞上"备份已存在"。只删标记点名
    // 的那几份,legacy-backup/ 里别的东西(JSONL legacy-json 迁移的原件)不碰;
    // 目录空了才删。
    fs.rmSync(markerFile)
    for (const rel of [marker.backup?.messages, marker.backup?.events]) {
      if (!rel) continue
      const file = path.join(dir, rel)
      if (file.startsWith(backupDir + path.sep) && fs.existsSync(file)) fs.rmSync(file)
    }
    try {
      if (fs.readdirSync(backupDir).length === 0) fs.rmdirSync(backupDir)
    } catch { /* 目录里还有别的东西,留着 */ }

    return { sessionId, status: 'rolled-back', restoredEvents }
  } catch (error) {
    return { sessionId, status: 'error', reason: String(error?.message ?? error) }
  }
}

export function rollbackMigration(store, options = {}) {
  const sessionsDir = path.join(store, 'sessions')
  let ids
  if (options.all) {
    try {
      ids = fs.readdirSync(sessionsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name !== BACKUP_DIR)
        .map(entry => entry.name)
        .sort()
    } catch {
      ids = []
    }
  } else {
    ids = [options.sessionId]
  }
  const results = ids.map(id => rollbackSession(sessionsDir, id))
  return { store, results }
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
  const args = { dryRun: false, apply: false, rollback: false, all: false, sessionId: undefined, store: undefined, json: false, limit: 0, top: 10 }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--apply') args.apply = true
    else if (arg === '--rollback') args.rollback = true
    else if (arg === '--all') args.all = true
    else if (arg === '--json') args.json = true
    else if (arg === '--store') args.store = argv[++index]
    else if (arg.startsWith('--store=')) args.store = arg.slice('--store='.length)
    else if (arg === '--limit') args.limit = Number(argv[++index]) || 0
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice('--limit='.length)) || 0
    else if (arg === '--top') args.top = Math.max(0, Number(argv[++index]) || 0)
    else if (arg.startsWith('--top=')) args.top = Math.max(0, Number(arg.slice('--top='.length)) || 0)
    else if (!arg.startsWith('-')) args.sessionId = arg
  }
  return args
}

/** R-c 硬前置:有活的 core 拿着这个 store 就拒绝运行(退出码 3),没有绕过口。 */
async function refuseIfLive(store) {
  const blocked = await blockingLivenessReason(detectLiveness(store))
  if (!blocked) return
  console.error(`[migrate] 拒绝运行:${blocked}。`)
  console.error('[migrate] 迁移会重编号整份 events.jsonl,而活着的 core 正在往同一个文件追加 ——')
  console.error('[migrate] 两个写者会铸出同一个 seq,replace 遮蔽错区间而校验照样放行。')
  console.error('[migrate] 先让它退出(退出时会删掉 run/http.json),再跑这条命令。没有绕过开关。')
  process.exit(3)
}

async function runApply(args) {
  const store = resolveStorePath(args.store)
  // R-c:**先拦,再动手**。有活的 core = 硬拦。
  await refuseIfLive(store)

  const summary = applyMigration(store, { limit: args.limit })
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2))
    process.exit(summary.tally.error > 0 ? 1 : 0)
  }

  const t = summary.tally
  console.log(`[migrate] APPLY store=${store}`)
  console.log(`[migrate] 迁移 ${t.migrated} 间 / 合并混合 ${t.merged ?? 0} 间 / 已全覆盖 ${t.covered ?? 0} 间 / 已迁过(no-op)${t.noop} 间 / 跳过 ${t.skipped} 间 / 空 ${t.empty} 间 / 出错 ${t.error} 间`)
  console.log(`[migrate] 合成 message/imported ${t.importedEvents} 条;events.jsonl 字节 ${mb(t.bytesBefore)} → ${mb(t.bytesAfter)}`)
  for (const result of summary.results) {
    if (result.status === 'migrated') {
      console.log(`  migrated ${result.sessionId}  events ${result.existingEvents}→${result.existingEvents + result.imported}(+${result.imported} imported) bytes ${mb(result.eventsBytesBefore)}→${mb(result.eventsBytesAfter)} backup=${result.backupPath}${result.corrupt ? ` corrupt=${result.corrupt}` : ''}`)
    } else if (result.status === 'merged') {
      console.log(`  merged   ${result.sessionId}  头 ${result.imported} 条 imported + 尾 ${result.existingEvents} 事件重编号(firstCovered=${result.firstCoveredIndex}) bytes ${mb(result.eventsBytesBefore)}→${mb(result.eventsBytesAfter)} backup=${result.backupPath}${result.corrupt ? ` corrupt=${result.corrupt}` : ''}`)
    } else if (result.status === 'error') {
      console.log(`  ERROR    ${result.sessionId}  ${result.reason}`)
    } else if (result.status === 'skipped') {
      console.log(`  skipped  ${result.sessionId}  ${result.reason}`)
    }
  }
  if (summary.legacyJsonFiles > 0) {
    console.log(`[migrate] legacy 整文件 ${summary.legacyJsonFiles} 份未处理(须先经 convert-sessions 转成目录会话)`)
  }
  console.log(t.error > 0 ? `[migrate] 有 ${t.error} 间出错(见上,已跳过,未半写)` : '[migrate] 全部成功')
  process.exit(t.error > 0 ? 1 : 0)
}

async function runRollback(args) {
  const store = resolveStorePath(args.store)
  await refuseIfLive(store)
  if (!args.all && !args.sessionId) {
    console.error('[migrate] 用法:node scripts/migrate-sessions-events.mjs --rollback <sessionId>|--all [--store PATH]')
    process.exit(2)
  }
  const summary = rollbackMigration(store, { all: args.all, sessionId: args.sessionId })
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2))
    const failed = summary.results.filter(r => r.status === 'error').length
    process.exit(failed > 0 ? 1 : 0)
  }
  console.log(`[migrate] ROLLBACK store=${store}`)
  let rolled = 0
  let failed = 0
  for (const result of summary.results) {
    if (result.status === 'rolled-back') {
      rolled += 1
      console.log(`  rolled-back ${result.sessionId}  ${result.restoredEvents ? '复原了迁移前的 events.jsonl' : '删掉了合成的 events.jsonl'}`)
    } else if (result.status === 'error') {
      failed += 1
      console.log(`  ERROR       ${result.sessionId}  ${result.reason}`)
    } else if (result.status === 'not-migrated' && !args.all) {
      console.log(`  skip        ${result.sessionId}  ${result.reason}`)
    }
  }
  console.log(`[migrate] 回滚 ${rolled} 间${failed > 0 ? `,${failed} 间出错` : ''}`)
  process.exit(failed > 0 ? 1 : 0)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.rollback) {
    await runRollback(args)
    return
  }
  if (args.apply) {
    await runApply(args)
    return
  }
  if (!args.dryRun) {
    console.error('[migrate] 用法:')
    console.error('[migrate]   --dry-run  [--store PATH] [--json] [--limit N]   只读,算账不写')
    console.error('[migrate]   --apply    [--store PATH] [--json] [--limit N]   真的写(备份 + 原子写 + 幂等)')
    console.error('[migrate]   --rollback <sessionId>|--all [--store PATH]      从 legacy-backup/ 复原')
    process.exit(2)
  }

  const plan = buildPlan(resolveStorePath(args.store), { limit: args.limit })

  // R-c:**先拦,再算账**。dry-run 也拦 —— 它读的那份 events.jsonl 正在被人写,
  // 算出来的重编号计划下一秒就过期了,而人会照着它做决定。
  const blocked = await blockingLivenessReason(plan.liveness)
  if (blocked) {
    console.error(`[migrate] 拒绝运行:${blocked}。`)
    console.error('[migrate] 迁移会重编号整份 events.jsonl,而活着的 core 正在往同一个文件追加 ——')
    console.error('[migrate] 两个写者会铸出同一个 seq,replace 遮蔽错区间而校验照样放行。')
    console.error('[migrate] 先让它退出(退出时会删掉 run/http.json),再跑这条命令。没有绕过开关。')
    process.exit(3)
  }

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
  if (live.lock || live.http) {
    console.log(`[migrate] 发现陈旧的 run 文件(进程已不在):${JSON.stringify(live)}`)
  } else {
    console.log('[migrate] 没有人拿着这个 store(run/ 下没有活着的锁或发现文件)')
  }

  process.exit(0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    console.error('[migrate] 失败:', error)
    process.exit(1)
  })
}

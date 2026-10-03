#!/usr/bin/env bun
/**
 * Collab v3 诊断 CLI(docs/design/collab-v3-observability.md §5,D8 O3)。
 *
 * 回答蓝图 §0 的四个必答问题,**不经进程**:直接读 `~/.onething` 下的账与时间轴。
 * app 挂了也能查 —— 而抓瞎最惨的时刻恰恰是进程不对劲的时刻。
 *
 * 用法(必须用 bun 跑 —— 它要直接 import TS 源码并走 tsconfig 的 @onething/* 路径;
 * 裸 `node` 会在第一个 import 就炸):
 *   bun scripts/collab-v3-inspect.mjs                      # 系统总览:所有房 + 所有同事各一行
 *   bun scripts/collab-v3-inspect.mjs --room <id|名字>     # 单房:账 + 租约 + 举手 + 时间轴尾 20
 *   bun scripts/collab-v3-inspect.mjs --agent <id|名字>    # 单人:大脑 / 邮箱 / 持牌 / 工作卡 / 涉入房
 *   bun scripts/collab-v3-inspect.mjs --tail 50            # 时间轴回放(全仓合并,新在前)
 *   bun scripts/collab-v3-inspect.mjs --tail 50 --type judge-verdict,grant --room <id>
 *   bun scripts/collab-v3-inspect.mjs --dead-letters       # 全仓死信汇总(按 actor 分组)
 *   bun scripts/collab-v3-inspect.mjs --json               # 任一模式的机器可读版
 *   bun scripts/collab-v3-inspect.mjs --store ~/.onething-test --room 测试
 *
 * ⚠️ **只读**。本脚本只 `readFileSync`,不写任何文件、不改 ~/.onething、不起 server、
 *    不碰 store lock。跑它**不需要**先停 dev server —— 但那时读到的是一瞬间的切片
 *    (账在同步原子写,读到的永远是某一版完整的账,不会是半份)。
 *
 * ⚠️ 进程外读不到两样,输出里一律**如实标注**、绝不猜:
 *    1. **「生成中」** —— 判据是 turn-context 登记簿,内存态。这里只报**持牌**;
 *    2. **预算闸** —— 用量账本不在房账里。重算的 `blockedBy` 因此缺这一格,
 *       时间轴里的 `gate-block` 行才是进程内的原话(详情页两个都给)。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/* ── 参数 ─────────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)
const flags = new Set(args.filter(arg => arg.startsWith('--')))

const KNOWN_FLAGS = [
  '--room', '--agent', '--tail', '--type', '--dead-letters', '--json', '--store', '--help', '-h',
]

if (flags.has('--help') || args.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf-8').split('*/')[0].replace(/^#![^\n]*\n/, ''))
  process.exit(0)
}

const unknown = [...flags].filter(flag => !KNOWN_FLAGS.includes(flag))
if (unknown.length > 0) {
  console.error(`[collab-v3-inspect] 不认识的参数:${unknown.join(' ')}(--help 看用法)`)
  process.exit(2)
}

/** `--x value` 取值。缺值或后面又是一个 flag = 用法错。 */
function optionValue(name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    console.error(`[collab-v3-inspect] ${name} 后面要跟一个值`)
    process.exit(2)
  }
  return value
}

const storeArg = optionValue('--store')
const roomArg = optionValue('--room')
const agentArg = optionValue('--agent')
const tailArg = optionValue('--tail')
const typeArg = optionValue('--type')
const asJson = flags.has('--json')

const storePath = (storeArg ?? process.env.ONETHING_STORE_PATH ?? join(homedir(), '.onething'))
  .replace(/^~(?=\/)/, homedir())

if (tailArg !== undefined && (!Number.isFinite(Number(tailArg)) || Number(tailArg) <= 0)) {
  console.error(`[collab-v3-inspect] --tail 要跟一个正整数,收到「${tailArg}」`)
  process.exit(2)
}

/* ── 纯层(唯一的真值口径:UI 与 CLI 用的是同一批函数)────────────────────── */

const { normalizeCollabRoomAccount } = await import(
  '../packages/backend/collab/actors/room-rules.ts'
)
const { normalizeCollabAgentAccount } = await import(
  '../packages/backend/collab/actors/mind-rules.ts'
)
const {
  collabSchedulerLogFileDayKey,
  isCollabSchedulerLogType,
  parseCollabSchedulerLogLine,
  COLLAB_SCHEDULER_LOG_TYPES,
} = await import('../packages/backend/collab/actors/scheduler-log-rules.ts')
const {
  formatCollabInspectAgentDetail,
  formatCollabInspectAgentLine,
  formatCollabInspectCaveats,
  formatCollabInspectDeadLetters,
  formatCollabInspectRoomDetail,
  formatCollabInspectRoomLine,
  formatCollabInspectRow,
  groupCollabInspectDeadLetters,
  matchCollabInspectTargets,
  summarizeCollabInspectAgent,
  summarizeCollabInspectRoom,
  COLLAB_INSPECT_EXECUTING_NOTE,
} = await import('../packages/backend/collab/actors/inspect-rules.ts')

const types = typeArg
  ? typeArg.split(',').map(part => part.trim()).filter(Boolean)
  : undefined
if (types) {
  const bad = types.filter(type => !isCollabSchedulerLogType(type))
  if (bad.length > 0) {
    console.error(`[collab-v3-inspect] 不认识的行类型:${bad.join(',')}`)
    console.error(`  可选:${COLLAB_SCHEDULER_LOG_TYPES.join(' ')}`)
    process.exit(2)
  }
}

/* ── 读盘(全部只读,单项失败不中断全局 —— migrate 的纪律)──────────────── */

/** 读坏了的文件全记在这里,收尾时一并印出来(`!` 前缀)。 */
const problems = []

function note(file, error) {
  problems.push(`! ${file} 读不动 —— ${error instanceof Error ? error.message : String(error)}`)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    note(file, error)
    return null
  }
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

const collabDir = join(storePath, 'collab')
const agentsDir = join(storePath, 'agents-v3')
const sessionsDir = join(storePath, 'sessions')

function roomActorsDir(roomId) {
  return join(collabDir, roomId, 'actors')
}

/** 有 `actors/room.json` 的才算一间 v3 房 —— 目录在但没账 = 还没被 v3 碰过。 */
function listRoomIds() {
  return listDirs(collabDir).filter(roomId => existsSync(join(roomActorsDir(roomId), 'room.json')))
}

function listAgentIds() {
  return listDirs(agentsDir).filter(agentId => existsSync(join(agentsDir, agentId, 'state.json')))
}

function readRoomAccount(roomId) {
  const raw = readJson(join(roomActorsDir(roomId), 'room.json'))
  return raw === null ? null : normalizeCollabRoomAccount(raw, roomId)
}

function readAgentAccount(agentId) {
  const raw = readJson(join(agentsDir, agentId, 'state.json'))
  return raw === null ? null : normalizeCollabAgentAccount(raw, agentId)
}

/** `agents.json` → id → 名字。读不到就全用 id(诊断不该因为一份名册炸掉)。 */
function readAgentNames() {
  const names = new Map()
  const raw = readJson(join(storePath, 'agents.json'))
  const list = Array.isArray(raw) ? raw : (raw?.agents ?? [])
  for (const entry of list) {
    if (entry && typeof entry.id === 'string' && typeof entry.name === 'string') names.set(entry.id, entry.name)
  }
  return names
}

/**
 * 会话 meta:房名 + 房间配置(闸要它)。
 *
 * 两种形态都认:jsonl 会话(`sessions/<id>/meta.json`)与遗留整文件
 * (`sessions/<id>.json`)。后者在这条路径上仍会遇到 —— 惰性迁移只在被打开时发生。
 */
function readRoomMeta(roomId) {
  const meta = readJson(join(sessionsDir, roomId, 'meta.json'))
  if (meta) return meta
  return readJson(join(sessionsDir, `${roomId}.json`))
}

/**
 * 一条持久 mailbox 的积压。
 *
 * 进程内那一份走游标差(O(1));进程外没有那个内存索引,只能读文件。信箱按天不切、
 * 消费后不截断,所以这里做一次**尾部优先**:先拿最后一条的 seq,与游标一减就是
 * 深度;只有深度 > 0 时才为了「最旧那封是什么时候」再扫一遍。
 */
function readMailbox(dir, name = 'inbox') {
  const logPath = join(dir, `${name}.jsonl`)
  if (!existsSync(logPath)) return undefined
  const cursor = readJson(join(dir, `${name}.cursor`))
  const cursorSeq = typeof cursor?.seq === 'number' ? cursor.seq : 0
  let text = ''
  try {
    text = readFileSync(logPath, 'utf-8')
  } catch (error) {
    note(logPath, error)
    return { depth: 0, unreadable: '信箱读不动' }
  }
  let depth = 0
  let oldestAt
  for (const line of text.split('\n')) {
    if (!line) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed?.t !== 'm' || typeof parsed.seq !== 'number') continue
    if (parsed.seq <= cursorSeq) continue
    depth += 1
    if (oldestAt === undefined && typeof parsed.m?.at === 'number') oldestAt = parsed.m.at
  }
  return oldestAt === undefined ? { depth } : { depth, oldestAt }
}

/** 一间房的时间轴文件,按日期升序(不是时间轴的文件不入列)。 */
function listSchedulerLogFiles(roomId) {
  try {
    return readdirSync(roomActorsDir(roomId))
      .filter(name => collabSchedulerLogFileDayKey(name) !== null)
      .sort()
  } catch {
    return []
  }
}

/**
 * 尾读一间房的时间轴,**新在前** —— 与 `createCollabSchedulerLogFileStore.readTail`
 * 逐条同款(新的一天在前,攒够 limit 就不再打开更老的文件)。
 */
function readSchedulerTail(roomId, { limit = 50, types: wanted } = {}) {
  if (limit <= 0) return []
  const want = wanted && wanted.length > 0 ? new Set(wanted) : null
  const rows = []
  for (const file of listSchedulerLogFiles(roomId).reverse()) {
    const path = join(roomActorsDir(roomId), file)
    let text = ''
    try {
      text = readFileSync(path, 'utf-8')
    } catch (error) {
      note(path, error)
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const row = parseCollabSchedulerLogLine(lines[index] ?? '')
      if (!row) continue
      if (want && !want.has(row.type)) continue
      rows.push(row)
      if (rows.length >= limit) return rows
    }
  }
  return rows
}

/* ── 组装 ─────────────────────────────────────────────────────────────────── */

const now = Date.now()
const agentNames = readAgentNames()
const label = id => agentNames.get(id)
const labelOptions = { label }

const roomIds = listRoomIds()
const roomMetas = new Map()
const roomAccounts = new Map()
for (const roomId of roomIds) {
  const account = readRoomAccount(roomId)
  if (!account) continue
  roomAccounts.set(roomId, account)
  roomMetas.set(roomId, readRoomMeta(roomId))
}

function roomName(roomId) {
  const name = roomMetas.get(roomId)?.name
  return typeof name === 'string' && name ? name : undefined
}

function roomConfig(roomId) {
  return roomMetas.get(roomId)?.room ?? null
}

function roomSummaryOf(roomId, { tail } = {}) {
  const account = roomAccounts.get(roomId)
  if (!account) return null
  const name = roomName(roomId)
  const mailbox = readMailbox(roomActorsDir(roomId))
  return summarizeCollabInspectRoom({
    roomId,
    ...(name ? { name } : {}),
    account,
    room: roomConfig(roomId),
    ...(tail ? { tail } : {}),
    ...(mailbox ? { mailbox } : {}),
    now,
  })
}

/** 各房账 —— agent 的持牌/举手扫的就是它(房间才是租约的权威)。 */
function roomViewsForAgent() {
  return [...roomAccounts.entries()].map(([roomSessionId, account]) => {
    const name = roomName(roomSessionId)
    return { roomSessionId, ...(name ? { name } : {}), account }
  })
}

/** 全仓死信:所有房的时间轴里 `dead-letter` 那一类。 */
function collectDeadLetters() {
  const entries = []
  for (const roomId of roomAccounts.keys()) {
    for (const row of readSchedulerTail(roomId, { limit: 5000, types: ['dead-letter'] })) {
      entries.push({ roomId, row })
    }
  }
  return entries
}

function agentSummaryOf(agentId, { deadLetters } = {}) {
  const account = readAgentAccount(agentId)
  if (!account) return null
  const name = agentNames.get(agentId)
  const inbox = readMailbox(join(agentsDir, agentId))
  return summarizeCollabInspectAgent({
    agentId,
    ...(name ? { name } : {}),
    account,
    ...(inbox ? { inbox } : {}),
    rooms: roomViewsForAgent(),
    ...(deadLetters === undefined ? {} : { deadLetters }),
    now,
  })
}

/* ── 输出 ─────────────────────────────────────────────────────────────────── */

const out = []
const print = (...lines) => { out.push(...lines) }

function flush(exitCode = 0) {
  if (problems.length > 0 && !asJson) {
    out.push('')
    out.push(...problems)
  }
  console.log(out.join('\n'))
  process.exit(exitCode)
}

function emitJson(payload) {
  console.log(JSON.stringify({ storePath, at: now, ...payload, problems }, null, 2))
  process.exit(0)
}

/** `--room` / `--agent` 后面那串字符指的是谁。命中 0 个或多个都不猜。 */
function resolveTarget(kind, query, entries) {
  const matches = matchCollabInspectTargets(query, entries)
  if (matches.length === 1) return matches[0].id
  if (matches.length === 0) {
    console.error(`[collab-v3-inspect] 找不到${kind}:「${query}」(共 ${entries.length} 个候选,--help 看用法)`)
    process.exit(1)
  }
  console.error(`[collab-v3-inspect] 「${query}」命中 ${matches.length} 个${kind},请说得更具体:`)
  for (const match of matches) console.error(`  ${match.id}${match.name ? `  ${match.name}` : ''}`)
  process.exit(1)
}

/* ── 模式 1:时间轴回放(--tail)─────────────────────────────────────────── */

if (tailArg !== undefined) {
  const limit = Math.floor(Number(tailArg))
  const targets = roomArg
    ? [resolveTarget('房', roomArg, [...roomAccounts.keys()].map(id => ({ id, name: roomName(id) })))]
    : [...roomAccounts.keys()]
  const rows = []
  for (const roomId of targets) {
    // 每间房各取 limit 条,合并后再截 —— 全仓合并时先各读满才不会漏掉安静房里的行。
    for (const row of readSchedulerTail(roomId, { limit, ...(types ? { types } : {}) })) {
      rows.push({ roomId, row })
    }
  }
  rows.sort((a, b) => b.row.at - a.row.at)
  const picked = rows.slice(0, limit)

  if (asJson) {
    emitJson({
      mode: 'tail',
      limit,
      ...(types ? { types } : {}),
      ...(roomArg ? { room: targets[0] } : {}),
      rows: picked.map(entry => ({ roomId: entry.roomId, ...entry.row })),
    })
  }

  print(`# store     ${storePath}`)
  print(`# 时间轴    尾 ${picked.length} 条(新在前)`
    + `${types ? `  类型=${types.join(',')}` : ''}`
    + `${roomArg ? `  房=${roomName(targets[0]) ?? targets[0]}` : `  全仓 ${targets.length} 间房`}`)
  print('')
  if (picked.length === 0) {
    print('(账本为空 —— 没有匹配的行。时间轴保留 14 天,更早的已被清掉;')
    print(' 若这台机器上 v3 从没跑过调度,`actors/` 下不会有 scheduler-log-*.jsonl。)')
  }
  for (const entry of picked) {
    const prefix = roomArg ? '' : `[${roomName(entry.roomId) ?? entry.roomId.slice(0, 12)}] `
    print(`${prefix}${formatCollabInspectRow(entry.row, labelOptions)}`)
  }
  flush()
}

/* ── 模式 2:死信汇总(--dead-letters)──────────────────────────────────── */

if (flags.has('--dead-letters')) {
  const entries = collectDeadLetters()
  const groups = groupCollabInspectDeadLetters(entries)
  if (asJson) emitJson({ mode: 'dead-letters', groups })
  print(`# store     ${storePath}`)
  print(`# 扫描      ${roomAccounts.size} 间房的时间轴`)
  print('')
  print(...formatCollabInspectDeadLetters(groups, now))
  flush()
}

/* ── 模式 3:单房详情(--room)──────────────────────────────────────────── */

if (roomArg !== undefined) {
  const roomId = resolveTarget('房', roomArg, [...roomAccounts.keys()].map(id => ({ id, name: roomName(id) })))
  const tail = readSchedulerTail(roomId, { limit: 20, ...(types ? { types } : {}) })
  const summary = roomSummaryOf(roomId, { tail })
  if (!summary) {
    console.error(`[collab-v3-inspect] ${roomId} 的房账读不动`)
    process.exit(1)
  }
  if (asJson) emitJson({ mode: 'room', room: summary, tail })
  print(`# store     ${storePath}`)
  print(...formatCollabInspectRoomDetail(summary, tail, now, labelOptions))
  flush()
}

/* ── 模式 4:单人详情(--agent)─────────────────────────────────────────── */

if (agentArg !== undefined) {
  const candidates = listAgentIds().map(id => ({ id, name: agentNames.get(id) }))
  const agentId = resolveTarget('同事', agentArg, candidates)
  const deadLetters = collectDeadLetters()
    .filter(entry => entry.row.actor === `agent:${agentId}`).length
  const summary = agentSummaryOf(agentId, { deadLetters })
  if (!summary) {
    console.error(`[collab-v3-inspect] ${agentId} 的 agent 账读不动`)
    process.exit(1)
  }
  if (asJson) emitJson({ mode: 'agent', agent: summary })
  print(`# store     ${storePath}`)
  print(...formatCollabInspectAgentDetail(summary, now))
  flush()
}

/* ── 模式 5:系统总览(无参)────────────────────────────────────────────── */

const deadLetterEntries = collectDeadLetters()
const deadLettersByActor = new Map()
for (const entry of deadLetterEntries) {
  const actor = entry.row.actor
  deadLettersByActor.set(actor, (deadLettersByActor.get(actor) ?? 0) + 1)
}

const roomSummaries = []
for (const roomId of roomAccounts.keys()) {
  const summary = roomSummaryOf(roomId, { tail: readSchedulerTail(roomId, { limit: 50 }) })
  if (summary) roomSummaries.push(summary)
}
// 活跃的排前面:有人持牌 > 有人举手 > 时间轴最近动过。
roomSummaries.sort((a, b) =>
  (b.leases.length - a.leases.length)
  || (b.hands.length - a.hands.length)
  || ((b.lastEventAt ?? 0) - (a.lastEventAt ?? 0)))

const agentSummaries = []
for (const agentId of listAgentIds()) {
  const summary = agentSummaryOf(agentId, { deadLetters: deadLettersByActor.get(`agent:${agentId}`) ?? 0 })
  if (summary) agentSummaries.push(summary)
}
agentSummaries.sort((a, b) =>
  (b.leases.length - a.leases.length)
  || (b.inbox.depth - a.inbox.depth)
  || ((b.lastTurnAt ?? 0) - (a.lastTurnAt ?? 0)))

if (asJson) {
  emitJson({
    mode: 'overview',
    totals: {
      rooms: roomSummaries.length,
      agents: agentSummaries.length,
      leases: roomSummaries.reduce((sum, room) => sum + room.leases.length, 0),
      hands: roomSummaries.reduce((sum, room) => sum + room.hands.length, 0),
      deadLetters: deadLetterEntries.length,
      inboxBacklog: agentSummaries.reduce((sum, agent) => sum + agent.inbox.depth, 0),
    },
    rooms: roomSummaries,
    agents: agentSummaries,
  })
}

const totalLeases = roomSummaries.reduce((sum, room) => sum + room.leases.length, 0)
const totalHands = roomSummaries.reduce((sum, room) => sum + room.hands.length, 0)
const totalInbox = agentSummaries.reduce((sum, agent) => sum + agent.inbox.depth, 0)

print(`# store     ${storePath}`)
print(`# 总计      房 ${roomSummaries.length} · 同事 ${agentSummaries.length}`
  + ` · 持牌 ${totalLeases} · 举手 ${totalHands} · 信箱积压 ${totalInbox}`
  + ` · 死信 ${deadLetterEntries.length}`)
print(`# 口径      「持牌」≠「生成中」——${COLLAB_INSPECT_EXECUTING_NOTE}`)
print('')

print(`房(${roomSummaries.length})`)
if (roomSummaries.length === 0) print('  (这个 store 里没有 v3 房账 —— collab/<id>/actors/room.json 一个都没有)')
for (const summary of roomSummaries) print(`  ${formatCollabInspectRoomLine(summary, labelOptions)}`)
print('')

print(`同事(${agentSummaries.length})`)
if (agentSummaries.length === 0) print('  (这个 store 里没有 v3 agent 账 —— agents-v3/<id>/state.json 一个都没有)')
for (const summary of agentSummaries) print(`  ${formatCollabInspectAgentLine(summary, now)}`)

if (deadLetterEntries.length > 0) {
  print('')
  print(`! 死信 ${deadLetterEntries.length} 条 —— 细看:bun scripts/collab-v3-inspect.mjs --dead-letters`)
}
print('')
print(...formatCollabInspectCaveats(['budget-gate']))
flush()

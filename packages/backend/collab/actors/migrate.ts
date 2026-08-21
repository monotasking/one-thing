/**
 * v2 → v3 迁移器的**装配面**(docs/design/collab-actor-v3.md §4,D5)。
 *
 * 规则(映射与对账算式)在纯层 `@onething/runtime/collab/actors` 的
 * `migrate-rules.ts`;这里只做四件带 IO 的事:**读盘、备份、写盘、落 marker**。
 *
 * ## 三条硬纪律
 *
 * 1. **绝不写 `sessions/` 下任何文件**。房间转录、经历流(`agent-exec-*`)、看板
 *    都是零迁移项 —— 迁移器对它们只 `readFileSync`。会话是这个产品里最贵的数据,
 *    一趟单向门里最不该被碰的就是它。
 * 2. **绝不删 v2 账**。v3 的账落在 `collab/<roomId>/actors/` 与 `agents-v3/`,与 v2
 *    并存;D6 切换之后 v2 那份自然失效,想回滚只要 git revert + 还原备份。
 * 3. **幂等重入**。两层闸:marker 存在 → 整体跳过;单间房的 v3 账已存在 → 那间房
 *    跳过、不覆盖。再加一层 —— 回填事件按**确定性 id** 与信箱里已有的比对,同一
 *    条消息永远只投一次(见 `migrate-rules.ts` 的 `backfillEvent`)。
 *
 * ## 为什么备份只拷 `collab/`,不拷 `sessions/`
 *
 * 蓝图 §4 第 6 条写的是「全量快照 `~/.onething`」。实施时收窄到 `collab/**`:
 * 迁移根本不写 `sessions/`,而一份全量快照会把几百 MB 的会话拖进备份目录 ——
 * 代价是每次迁移多花几十秒和几百 MB,换来的是一份**与原文件逐字节相同**的副本。
 * 备份要保的是「被改写的东西」,而被改写的东西全部在 `collab/` 与 `agents-v3/`
 * 里,后者迁移前是空的(没有可备份的旧状态)。
 *
 * ## 为什么读会话是自己解析文件,而不是走 store
 *
 * 这个模块挂在 `collab/actors` 的桶上,而那个桶今天的读者是**重放与测试** ——
 * 跑在没有引擎、没有 store 的环境里(见 index.ts 的那段说明)。import 一次
 * `../../store.js` 就会把半个主进程拖起来。而且迁移器还要能被 `bun scripts/…`
 * 直接跑:那个进程里没有 store,只有磁盘。
 */
import fs from 'node:fs'
import path from 'node:path'

import { DurableMailbox, readActorMailboxLog, type ActorEvent } from '@onething/core/actors'
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from '@onething/core/storage'
import { AGENT_EXEC_SESSION_PREFIX } from '@onething/runtime/agents/identity'
import type { CollabMessageLike } from '@onething/runtime/collab'
import {
  COLLAB_V2_BACKUP_DIR_PREFIX,
  COLLAB_V3_MIGRATION_MARKER_FILE,
  COLLAB_V3_MIGRATION_VERSION,
  parseRoomTranscriptJsonl,
  planCollabAgentRoomMigration,
  planCollabRoomAccountMigration,
  readCollabV2RoomState,
  summarizeCollabMigration,
  type CollabAgentRoomAccount,
  type CollabAgentRoomMigrationSummary,
  type CollabMigrationCheck,
  type CollabRoomAccount,
  type CollabRoomMigrationEntry,
  type CollabRoomPostedVerb,
  type CollabV3MigrationMarker,
  type CollabV3MigrationReport,
} from '@onething/runtime/collab/actors'

import { sessionReads } from '../../session/reads.js'
import {
  getOnethingSessionsDir,
  getOnethingStorePath,
} from '@onething/runtime/storage'
import {
  collabAgentAccountPath,
  collabAgentActorDir,
  COLLAB_AGENT_MAILBOX_NAME,
  createCollabAgentAccountFileStore,
} from './agent-mailbox.js'
import { collabRoomAccountPath, createCollabRoomAccountFileStore } from './room-account.js'
import { collabRoomBroadcastRecipients } from './room-actor.js'

/** `<store>/collab/`。v2 的账根,也是 v3 房间账与 marker 的家。 */
export function collabStoreDir(): string {
  return path.join(getOnethingStorePath(), 'collab')
}

/** `<store>/collab/v3-migrated.json`。存在 = 这台机器迁过了。 */
export function collabV3MigrationMarkerPath(): string {
  return path.join(collabStoreDir(), COLLAB_V3_MIGRATION_MARKER_FILE)
}

/** `<store>/backup/collab-v2-<timestamp>/`。 */
export function collabV2BackupDir(stamp: string): string {
  return path.join(getOnethingStorePath(), 'backup', `${COLLAB_V2_BACKUP_DIR_PREFIX}${stamp}`)
}

/** v2 房间账文件:`<store>/collab/<roomId>/state.json`(只读,永不改写)。 */
function collabV2RoomStatePath(roomId: string): string {
  return path.join(collabStoreDir(), roomId, 'state.json')
}

/** 看板:`<store>/collab/<roomId>/board.json`(零迁移,只校验)。 */
function collabBoardPath(roomId: string): string {
  return path.join(collabStoreDir(), roomId, 'board.json')
}

export interface CollabV3MigrationOptions {
  /** 默认 **true** —— 单向门的默认档必须是「先看一眼」。 */
  dryRun?: boolean
  now?: () => number
  /** 回填上限。缺省走 `COLLAB_MIGRATION_BACKFILL_MAX`(= 未读窗口口径)。 */
  backfillMax?: number
}

/* ── 一趟迁移 ──────────────────────────────────────────────────────────── */

/** 计划出来的一间房的写盘动作。dry-run 只算它,不落它。 */
interface RoomWorkItem {
  entry: CollabRoomMigrationEntry
  account?: CollabRoomAccount
  agents: Array<{
    agentId: string
    roomId: string
    room: CollabAgentRoomAccount
    events: ActorEvent<CollabRoomPostedVerb>[]
  }>
}

/**
 * 迁移一次。
 *
 * **先整份算完,再一次性落盘** —— dry-run 与执行走的是同一条计划代码,区别只在
 * 最后那个 `if`。两条分支各算一遍的话,「dry-run 报告说会做 A,真跑做了 B」这种
 * 事迟早发生,而它恰好是最难在事后查清的那一类。
 */
export async function migrateCollabToV3(
  options: CollabV3MigrationOptions = {},
): Promise<CollabV3MigrationReport> {
  const dryRun = options.dryRun ?? true
  const now = options.now ?? Date.now
  const at = now()
  const storePath = getOnethingStorePath()

  const base = {
    version: COLLAB_V3_MIGRATION_VERSION,
    dryRun,
    at,
    storePath,
  } as const

  // 第一层幂等闸:迁过就整体跳过。marker 是「这台机器的 v2 数据已经搬完」这句话
  // 的唯一凭据 —— 重跑一次的代价不是重复投递(那一层另有防线),而是把一间房在
  // v3 里已经跑出来的新账用陈旧的 v2 数据顶掉。
  if (pathExists(collabV3MigrationMarkerPath())) {
    const rooms: CollabRoomMigrationEntry[] = []
    return { ...base, skipped: true, rooms, totals: summarizeCollabMigration(rooms) }
  }

  const roomIds = listCollabRoomIds()
  const work: RoomWorkItem[] = []
  for (const roomId of roomIds) work.push(planRoom(roomId, options))

  const rooms = work.map(item => item.entry)
  const totals = summarizeCollabMigration(rooms)
  if (dryRun) return { ...base, skipped: false, rooms, totals }

  // 备份**先于**任何一次写:v3 房间账落在 `collab/<roomId>/actors/` 里,也就是
  // 备份树的内部。反过来的话备份下来的是「迁移后的样子」,而那份东西回滚时一点
  // 用都没有。
  const backupDir = collabV2BackupDir(formatBackupStamp(at))
  backupCollabDir(backupDir)

  for (const item of work) applyRoomAccount(item)
  await applyAgentAccounts(work)

  const marker: CollabV3MigrationMarker = { version: COLLAB_V3_MIGRATION_VERSION, at, backupDir, totals }
  writeJsonFile(collabV3MigrationMarkerPath(), marker)

  return { ...base, skipped: false, backupDir, rooms, totals }
}

/* ── 计划:一间房 ──────────────────────────────────────────────────────── */

function planRoom(roomId: string, options: CollabV3MigrationOptions): RoomWorkItem {
  const checks: CollabMigrationCheck[] = []
  const transcript = readRoomTranscript(roomId)
  checks.push(transcriptCheck(roomId, transcript))
  checks.push(boardCheck(roomId))

  // 第二层幂等闸:v3 账已经在盘上就不碰这间房。**不覆盖**是这里的全部意思 ——
  // 一份已经在跑的 v3 账里可能已经有新的水位、新的租约,用 v2 的旧数据盖上去
  // 等于把这间房时间倒流。
  if (pathExists(collabRoomAccountPath(roomId))) {
    return {
      entry: { roomId, status: 'skipped', memberCount: 0, agents: [], checks },
      agents: [],
    }
  }

  const rawState = readJsonFileSafe(collabV2RoomStatePath(roomId))
  if (rawState.error) {
    return {
      entry: {
        roomId,
        status: 'failed',
        error: `state.json 读不动:${rawState.error}`,
        memberCount: 0,
        agents: [],
        checks,
      },
      agents: [],
    }
  }
  const state = readCollabV2RoomState(rawState.value)
  if (!state) {
    return {
      entry: {
        roomId,
        status: 'failed',
        error: 'state.json 认不出形状(缺 version:1 或不是对象)',
        memberCount: 0,
        agents: [],
        checks,
      },
      agents: [],
    }
  }

  const plan = planCollabRoomAccountMigration({ roomId, state })
  const agentIds = listRoomAgentIds(roomId)

  const agents: RoomWorkItem['agents'] = []
  const summaries: CollabAgentRoomMigrationSummary[] = []
  for (const agentId of agentIds) {
    const exec = readExecSessionCursor(agentId, roomId)
    checks.push({
      kind: 'experience',
      roomId,
      agentId,
      status: exec.status,
      ...(exec.detail ? { detail: exec.detail } : {}),
    })
    const agentPlan = planCollabAgentRoomMigration({
      agentId,
      roomId,
      messages: transcript.messages,
      ...(exec.seenMessageId ? { seenMessageId: exec.seenMessageId } : {}),
      ...(exec.seenAt === undefined ? {} : { seenAt: exec.seenAt }),
      recipients: collabRoomBroadcastRecipients,
      ...(options.backfillMax === undefined ? {} : { backfillMax: options.backfillMax }),
    })
    agents.push({ agentId, roomId, room: agentPlan.room, events: agentPlan.events })
    summaries.push(agentPlan.summary)
  }

  return {
    entry: {
      roomId,
      status: 'migrated',
      summary: plan.summary,
      memberCount: agentIds.length,
      agents: summaries,
      checks,
    },
    account: plan.account,
    agents,
  }
}

/* ── 落盘 ──────────────────────────────────────────────────────────────── */

function applyRoomAccount(item: RoomWorkItem): void {
  if (!item.account) return
  createCollabRoomAccountFileStore().save(item.account)
}

/**
 * agent 账与信箱。**按 agent 归并**再写:一个 agent 可能同时在三间房里,
 * 逐房各 load/save 一次会让后写的那次把前两次的 `rooms` 格子覆盖掉
 * (账是整份 JSON 原子写的,不是逐字段 patch)。
 */
async function applyAgentAccounts(work: readonly RoomWorkItem[]): Promise<void> {
  const byAgent = new Map<string, RoomWorkItem['agents']>()
  for (const item of work) {
    for (const entry of item.agents) {
      const bucket = byAgent.get(entry.agentId)
      if (bucket) bucket.push(entry)
      else byAgent.set(entry.agentId, [entry])
    }
  }

  const store = createCollabAgentAccountFileStore()
  for (const [agentId, entries] of byAgent) {
    const account = store.load(agentId)
    const rooms = { ...account.rooms }
    const pending: ActorEvent<CollabRoomPostedVerb>[] = []
    let changed = false
    for (const entry of entries) {
      // 第二层幂等闸的 agent 侧:这一格已经有了就不动它,连带那间房的回填也不投。
      if (rooms[entry.roomId]) continue
      rooms[entry.roomId] = entry.room
      pending.push(...entry.events)
      changed = true
    }
    if (!changed) continue

    // 账**先于**信箱落盘(§3 三面纪律):崩在两者之间时,账里已经有水位而信箱少
    // 几封信,下一轮只是少读几条;反过来则是「信投了但账说没这间房」,那一格会
    // 被下一次迁移当成没迁过再投一遍。
    store.save({ ...account, rooms, seq: account.seq + 1 })
    if (pending.length > 0) await appendBackfill(agentId, pending)
  }
}

/**
 * 把回填事件追加进信箱,**按事件 id 与已有日志比对去重**。
 *
 * `DurableMailbox` 自己的去重窗是在 **ack 之后**才认识一个 id 的(见 core
 * `mailbox.ts` 的 `batches()`),所以「同一批里投了两遍」它挡不住 —— 挡得住的是
 * 消费过之后的重投。迁移器是那个「同一批里」的场景,所以去重要在写入侧做一次。
 */
async function appendBackfill(
  agentId: string,
  events: readonly ActorEvent<CollabRoomPostedVerb>[],
): Promise<void> {
  const dir = collabAgentActorDir(agentId)
  const logPath = path.join(dir, `${COLLAB_AGENT_MAILBOX_NAME}.jsonl`)
  const existing = new Set((await readActorMailboxLog(logPath)).map(event => event.id))

  const mailbox = await DurableMailbox.open<ActorEvent<CollabRoomPostedVerb>>({
    dir,
    ownerId: agentId,
    name: COLLAB_AGENT_MAILBOX_NAME,
  })
  try {
    for (const event of events) {
      if (existing.has(event.id)) continue
      existing.add(event.id)
      await mailbox.append(event)
    }
    await mailbox.flush()
  } finally {
    mailbox.close()
  }
}

/* ── 备份 ──────────────────────────────────────────────────────────────── */

/** `2026-08-03T12-34-56`。文件名里不能有冒号(Windows),所以时刻用短横。 */
function formatBackupStamp(at: number): string {
  return new Date(at).toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')
}

function backupCollabDir(backupDir: string): void {
  const source = collabStoreDir()
  ensureDir(path.dirname(backupDir))
  if (!pathExists(source)) {
    // 没有 v2 账的机器(全新安装)也要留下一个空备份目录:「备份跑过了」与
    // 「备份忘了跑」在事后长得一模一样,除非目录本身在。
    ensureDir(backupDir)
    return
  }
  fs.cpSync(source, backupDir, { recursive: true })
}

/* ── 读盘:枚举与解析 ──────────────────────────────────────────────────── */

/** `<store>/collab/` 下的房间目录。marker、备份、非目录条目一律不算房。 */
function listCollabRoomIds(): string[] {
  const dir = collabStoreDir()
  if (!pathExists(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

/**
 * 一间房要处理的 agent:**成员表 ∪ 曾在册**。
 *
 * 成员表(房间会话的 `room.memberAgentIds`)是「现在谁在这间房」;曾在册是
 * 「谁在这间房跑过」—— 后者从执行会话的存在性反推。为什么要并集:一个退休或被
 * 移出的成员,它的执行会话与游标还在盘上,而 v3 的账如果没有这一格,某天它被
 * 重新拉进房时会以「从没来过」的身份铺底,把它三个月的经历当成不存在。
 */
function listRoomAgentIds(roomId: string): string[] {
  const ids = new Set<string>()
  for (const id of readRoomMembers(roomId)) ids.add(id)

  const suffix = `-${roomId}`
  for (const sessionId of listSessionIds()) {
    if (!sessionId.startsWith(AGENT_EXEC_SESSION_PREFIX)) continue
    if (!sessionId.endsWith(suffix)) continue
    const agentId = sessionId.slice(AGENT_EXEC_SESSION_PREFIX.length, sessionId.length - suffix.length)
    if (agentId) ids.add(agentId)
  }
  return [...ids].sort()
}

function readRoomMembers(roomId: string): string[] {
  const meta = readSessionMeta(roomId)
  const room = meta && typeof meta === 'object' ? (meta as { room?: { memberAgentIds?: unknown } }).room : undefined
  const ids = room?.memberAgentIds
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

interface ExecCursor {
  status: CollabMigrationCheck['status']
  seenMessageId?: string
  seenAt?: number
  detail?: string
}

/** 经历流(执行会话)的游标。零迁移 —— 只读 meta,不动一个字节。 */
function readExecSessionCursor(agentId: string, roomId: string): ExecCursor {
  const sessionId = `${AGENT_EXEC_SESSION_PREFIX}${agentId}-${roomId}`
  const located = locateSession(sessionId)
  if (!located) return { status: 'absent' }
  const meta = readSessionMeta(sessionId)
  if (!meta) return { status: 'unreadable', detail: `${sessionId} 的 meta 解析失败` }
  const collab = (meta as { collab?: { seenMessageId?: unknown; seenAt?: unknown } }).collab
  return {
    status: 'ok',
    ...(typeof collab?.seenMessageId === 'string' ? { seenMessageId: collab.seenMessageId } : {}),
    ...(typeof collab?.seenAt === 'number' ? { seenAt: collab.seenAt } : {}),
  }
}

interface RoomTranscript {
  messages: CollabMessageLike[]
  status: CollabMigrationCheck['status']
  detail?: string
}

/**
 * 房间转录。**零迁移** —— 只读,两种落盘形态都吃:
 * jsonl 目录(`sessions/<id>/messages.jsonl`)与旧整份 JSON(`sessions/<id>.json`)。
 *
 * jsonl 用的是与金重放**同一个**解析器(`parseRoomTranscriptJsonl`):两套解析器
 * 迟早会漂,而「迁移器数出来的条数与重放看到的不一样」是最难查的那种漂。
 */
function readRoomTranscript(roomId: string): RoomTranscript {
  const located = locateSession(roomId)
  if (!located) return { messages: [], status: 'absent' }
  try {
    if (located.kind === 'jsonl') {
      // P0.2 ③:绕驱动直读收进读门面。仍是**只读、零迁移、不进 LRU** —— 门面
      // 拼的就是同一条 `sessions/<id>/messages.jsonl`,缺文件时同样当空转录。
      const text = sessionReads.readTranscriptFile(roomId)
      if (text === undefined) return { messages: [], status: 'ok' }
      const parsed = parseRoomTranscriptJsonl(text, roomId)
      return { messages: parsed.messages, status: 'ok' }
    }
    const raw = JSON.parse(fs.readFileSync(located.path, 'utf-8')) as { messages?: unknown }
    const messages = Array.isArray(raw.messages) ? (raw.messages as CollabMessageLike[]) : []
    return { messages, status: 'ok' }
  } catch (error) {
    return { messages: [], status: 'unreadable', detail: errorText(error) }
  }
}

function transcriptCheck(roomId: string, transcript: RoomTranscript): CollabMigrationCheck {
  return {
    kind: 'transcript',
    roomId,
    status: transcript.status,
    ...(transcript.status === 'ok' ? { count: transcript.messages.length } : {}),
    ...(transcript.detail ? { detail: transcript.detail } : {}),
  }
}

function boardCheck(roomId: string): CollabMigrationCheck {
  const boardPath = collabBoardPath(roomId)
  if (!pathExists(boardPath)) return { kind: 'board', roomId, status: 'absent' }
  const read = readJsonFileSafe(boardPath)
  return read.error
    ? { kind: 'board', roomId, status: 'unreadable', detail: read.error }
    : { kind: 'board', roomId, status: 'ok' }
}

/* ── 读盘:会话文件的两种形态 ──────────────────────────────────────────── */

interface LocatedSession {
  kind: 'jsonl' | 'legacy'
  /** jsonl:会话目录;legacy:`<id>.json` 文件。 */
  path: string
}

function locateSession(sessionId: string): LocatedSession | null {
  const dir = path.join(getOnethingSessionsDir(), sessionId)
  if (pathExists(path.join(dir, 'meta.json'))) return { kind: 'jsonl', path: dir }
  const legacy = path.join(getOnethingSessionsDir(), `${sessionId}.json`)
  if (pathExists(legacy)) return { kind: 'legacy', path: legacy }
  return null
}

/** 会话 meta(jsonl 的 `meta.json` = 整份会话去掉 messages,legacy 就是整份)。 */
function readSessionMeta(sessionId: string): unknown {
  const located = locateSession(sessionId)
  if (!located) return null
  const metaPath = located.kind === 'jsonl' ? path.join(located.path, 'meta.json') : located.path
  const read = readJsonFileSafe(metaPath)
  return read.error ? null : read.value
}

/** `<store>/sessions/` 下的会话 id(两种形态并集)。备份目录不算。 */
function listSessionIds(): string[] {
  const dir = getOnethingSessionsDir()
  if (!pathExists(dir)) return []
  const ids: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'legacy-backup' || entry.name === 'jsonl-backup') continue
      ids.push(entry.name)
    } else if (entry.name.endsWith('.json') && entry.name !== 'index.json') {
      ids.push(entry.name.slice(0, -'.json'.length))
    }
  }
  return ids
}

/**
 * 读一份 JSON,把「文件不在」与「文件坏了」分开。
 *
 * `readJsonFile` 的缺省行为是坏了就退回默认值 —— 运行时那是对的(半份设置不该
 * 拖垮启动),迁移时那是错的:一份读坏的 v2 账会被当成空账迁成一间崭新的房,
 * 而原来的水位、链计数就此消失,且没有任何一行日志说过这件事。
 */
function readJsonFileSafe(filePath: string): { value?: unknown; error?: string } {
  if (!pathExists(filePath)) return {}
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown }
  } catch (error) {
    return { error: errorText(error) }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ── 只读探针(脚本与测试用) ──────────────────────────────────────────── */

/** marker 读出来的样子。没迁过返回 null。 */
export function readCollabV3MigrationMarker(): CollabV3MigrationMarker | null {
  return readJsonFile<CollabV3MigrationMarker | null>(collabV3MigrationMarkerPath(), null)
}

/** 一个 agent 的 v3 账文件在不在(脚本的 `--status` 与测试的断言都读它)。 */
export function collabV3AgentAccountExists(agentId: string): boolean {
  return pathExists(collabAgentAccountPath(agentId))
}

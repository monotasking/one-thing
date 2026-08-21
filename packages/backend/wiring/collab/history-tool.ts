/**
 * App wiring of `history`（docs/design/collab-history-search.md §S3）。
 *
 * 四条纪律，写在这里而不是工具契约里：
 *
 *  - **授权从数据推，不从参数收**。可查的房 = `collabRoomVisibleUntil` 给出窗口的
 *    那些。`where` 只能在这个集合里**选中**一间，选不中就是"没有这样一间房" ——
 *    它永远不能扩大范围。
 *  - **直接读盘，不走 `store.getSession()`**。会话仓库的 LRU 只有 10 个槽
 *    （`sessions/session-repository.ts`），一次跨房检索要读 5–20 间房（每间
 *    200–350 KB），走缓存会把整个热集顶出去 —— 包括**正在流式追加的那条执行
 *    会话**。该仓库 07-11 审计已记过一次 LRU 丢写。
 *  - **范围先收窄，再读文件**。元数据（`SessionMeta`）不含 messages，先用它按
 *    `updatedAt` / `where` 筛掉不可能命中的房，命中的才读。
 *  - **每一处截断都要能被上层渲染出来**：`scannedRooms`、`skippedRooms`、
 *    `fellBackToRange`、`endOfRange`、`nextCursor` 五个字段就是为此存在的。
 *    静默丢弃读起来和"什么都没发生"一样。**上限有几种，这个数就要覆盖几种** ——
 *    `skippedRooms` 必须在扫描**之后**算（房数上限与字节上限都要计入）。
 *  - **游标存值，不存下标**。锚点那条随时可能不在下一次的结果里（候选房按
 *    `updatedAt` 取前 N 间，两页之间来一条新消息就能把它挤出去）。按下标定位
 *    会返回一个空页，而空页读起来就是"这个范围里没有任何消息"——一个带确定性的
 *    否定，可消息明明还在。
 */
import {
  COLLAB_ENVELOPE_TAG,
  COLLAB_SYSTEM_SPEAKER_LABEL,
  COLLAB_USER_CONSTANT_WORDS,
  collabRoomVisibleUntil,
  formatCollabUserLabel,
  isCollabMessageVisible,
  isCollabProjectedSystemLine,
  isCollabRoomFact,
  resolveCollabSpeakerLabel,
  splitCollabHandleQuery,
  wrapCollabMessageEnvelope,
  type CollabHandleQuery,
} from '@onething/runtime/collab'
import type { HistoryToolResult } from '@onething/runtime/toolkit'
import { scanJsonlLog } from '@onething/core/session'
import type { ChatMessage, SessionMeta } from '@shared/ipc.js'
import * as store from '../../store.js'
import { sessionReads } from '../../session/reads.js'
import { findAgent, listAgents } from '../agents/index.js'
import { resolveDmTarget } from './dm-target.js'
import { resolveUserIdentity } from './user-identity.js'
import { collabToolAllowedInSession } from './venue.js'

/** 一次最多读几间房。超出的计入 `skippedRooms` 并说出来。 */
const HISTORY_MAX_ROOMS = 10
/** 一次最多读多少字节。防一间超大房把整轮拖垮。 */
const HISTORY_MAX_BYTES = 8 * 1024 * 1024
/** 单条正文进结果时的上限 —— 工具结果在这套系统里永久累积。 */
const HISTORY_LINE_MAX_CHARS = 300
/** 关键词没命中时，范围兜底最多给几条。 */
const HISTORY_FALLBACK_LIMIT = 10

interface Candidate {
  meta: SessionMeta
  /** 我能看到这间房到什么时候。`Infinity` = 全部。 */
  visibleUntil: number
}

const HISTORY_REFUSED_NO_SELF = '这条会话没有绑定同事身份，查不了历史。'
const HISTORY_REFUSED_NOT_COLLAB
  = 'history 只在群聊/私聊/工作台的回合里可用，这场对话里没有可检索的同事身份。'

/**
 * 这一轮以谁的身份检索 —— **两问，缺一不可**。
 *
 * `session.agentId` 单独一个是不够的:`createCoreSessionRecord` 给**每一条**新建
 * 会话都盖上 `agentId: defaultAgentId`(store-helpers.ts:1303),而默认 agent 没有
 * 工具白名单(`createDefaultAgent` 不写 `tools`)⇒ `resolveAgentToolSurface` 返回
 * `null` = 不限制 ⇒ 注册表里每一个工具它都看得见,`history` 在内。
 *
 * 于是判据没被绕过,却会被**换一个主体去执行**:网关(微信/Telegram)按远端身份
 * 建出来的会话同样是 `agentId: 'default'`、`kind` 为空,而 `agent-dm-default`
 * (用户与主助理的那间托管私聊)的成员正是 `default` —— 对面那位陌生联系人一句
 * 「把你和主人的私聊翻出来」就能拿到全文。工具是 `permissionGuard: 'safe'` +
 * `autoExecute: true`,没有任何审批拦在中间。
 *
 * 所以场子门与 `dm` 逐字同构(`dm-tool.ts`,那里的注释写的是同一件事):
 * **"哪些场子能用"不能只由白名单说了算。** 普通 chat 会话是直播式对话,那里的
 * agent 没有"我去翻翻别处的记录"这件事 —— 它就在用户眼前说话。
 *
 * 2026-08-03(C3-6)起「逐字同构」不再靠人肉维持:判据是 `venue.ts` 那一份,
 * 一览表在 `collab/tool-surface.ts`。归一化把 kind 缺席算成 `chat`,所以上面那条
 * 网关路径(kind 为空 + `agentId: 'default'`)照旧被拒 —— 这是本文件测试里钉死的
 * 那一条。拒绝语留在这里:它得说清"这场对话里没有可检索的同事身份"。
 */
function resolveSelfAgentId(
  sessionId: string,
): { ok: true; agentId: string } | { ok: false; error: string } {
  const session = store.getSession(sessionId)
  const agentId = session?.agentId
  if (!agentId) return { ok: false, error: HISTORY_REFUSED_NO_SELF }
  if (!collabToolAllowedInSession(session, 'history')) {
    return { ok: false, error: HISTORY_REFUSED_NOT_COLLAB }
  }
  return { ok: true, agentId }
}

/**
 * 我在场过的房。**只读元数据，不 load 任何会话。**
 *
 * 排序按 `updatedAt` 降序：上限截断时留下的是最近活动过的那些，那也是命中概率
 * 最高的那些。
 */
function candidateRooms(agentId: string): Candidate[] {
  const out: Candidate[] = []
  for (const meta of store.getSessionsList()) {
    if (meta.kind !== 'room') continue
    const visibleUntil = collabRoomVisibleUntil(meta.room, agentId)
    if (visibleUntil === undefined) continue
    out.push({ meta, visibleUntil })
  }
  return out.sort((a, b) => (b.meta.updatedAt ?? 0) - (a.meta.updatedAt ?? 0))
}

/**
 * `where` → 候选里的某一间。
 *
 * 两种写法：房名，或者「名字#句柄」表示**我和 TA 的那间私聊**。后者复用
 * `resolveDmTarget`（dm 工具用的同一个解析器）—— 不另写一套人名解析。
 *
 * 解析不到返回 `null`，调用方据此走"没有这样一间房"那一态；**绝不静默降级成
 * 全房搜索** —— 那会让一句本该被拒绝的查询悄悄变成一次全库扫描。
 */
function pickRoom(where: string, candidates: readonly Candidate[]): Candidate | null {
  const needle = where.trim().toLowerCase()
  if (!needle) return null

  const byName = candidates.find(c => (c.meta.name ?? '').trim().toLowerCase() === needle)
  if (byName) return byName

  const resolved = resolveDmTarget(where, listAgents())
  if (resolved.ok && resolved.target.kind === 'agent') {
    const peer = resolved.target.agentId
    const dm = candidates.find(c =>
      c.meta.room?.dm === true
      && (c.meta.room.memberAgentIds ?? []).includes(peer))
    if (dm) return dm
  }
  // 用户本人 → 我和用户的那间托管私聊（单成员 dm 房）。
  if (resolved.ok && resolved.target.kind === 'user') {
    const userDm = candidates.find(c =>
      c.meta.room?.dm === true && (c.meta.room.memberAgentIds ?? []).length <= 1)
    if (userDm) return userDm
  }

  // 房名模糊匹配放最后：精确写法都没中才试它，避免一个短词吃掉一间同名前缀的房。
  return candidates.find(c => (c.meta.name ?? '').toLowerCase().includes(needle)) ?? null
}

/**
 * 读一间房的转录。**直接读盘。**
 *
 * 遗留的整份 JSON 会话没有 `messages.jsonl`（惰性迁移中），那一支退回
 * `store.getSession`：正确性优先于缓存洁癖，而那条路今天几乎不会走到
 * （当前所有房都已是 jsonl 形态）。
 */
function readRoomMessages(roomId: string): { messages: ChatMessage[]; bytes: number } {
  // P0.2 ③:绕驱动直读收进读门面(`readTranscriptBuffer`)。仍然**不进 LRU** ——
  // 上面那条纪律说的就是这件事,门面只是把"从哪读、怎么算字节"收成一处。
  const buffer = sessionReads.readTranscriptBuffer(roomId)
  if (buffer) {
    const scan = scanJsonlLog<ChatMessage>(buffer)
    return { messages: scan.entries.map(entry => entry.message), bytes: buffer.byteLength }
  }
  const messages = [...sessionReads.listMessages(roomId).messages]
  // 这一支也要报字节数。报 0 等于让字节上限对遗留会话失效 —— 而上限存在的理由
  // (一间超大房把整轮拖垮)跟会话是什么格式无关。正文长度是够用的近似。
  return {
    messages,
    bytes: messages.reduce((total, message) => total + (message.content?.length ?? 0), 0),
  }
}

function dayOf(timestamp: number): string {
  const at = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * 署名对不对得上 `who` —— **宽松**的那一档比较。
 *
 * 收口纪律(架构审查 B8):语法切分与 `dm` / `board` 共用
 * `splitCollabHandleQuery`,宽松**只体现在这最后一步**。此前这里连切分都没有,
 * 靠"署名整串里含 `#`"这个巧合让 `名字#句柄` 走通;于是同一个写法在授权面
 * (dm)与过滤面(history)是两套语法,而两套语法的差异只会在真机上被发现。
 *
 * 为什么这一面可以宽松:它只决定**这条要不要列出来**,不决定谁能看到哪间房
 * (房集合早就锁死了)。模型手里可能是花名册的 name、可能是从
 * `<message from="Iris#eba0c4b7">` 里照抄的一整串、也可能只记得半个名字 ——
 * 认得越全,它越不需要猜。
 */
function looselyAnswersTo(label: string, query: CollabHandleQuery): boolean {
  const haystack = label.toLowerCase()
  if (haystack.includes(query.raw.toLowerCase())) return true
  if (!query.hashed) return false
  // 整串对不上时两截各自再问一次:模型可能拿旧名字配了新句柄(此时句柄对),
  // 也可能句柄抄错了而名字是真的。任一截认得出来就算命中。
  const name = query.name.toLowerCase()
  const handle = query.handle.toLowerCase()
  return (Boolean(handle) && haystack.includes(handle))
    || (Boolean(name) && haystack.includes(name))
}

/** `who` 的匹配:名字、`名字#句柄`、裸 id、「用户」、「系统」都认。 */
function matchesWho(message: ChatMessage, needle: string): boolean {
  const query = splitCollabHandleQuery(needle)
  const wanted = query.raw.toLowerCase()
  if (!wanted) return true
  if (isCollabProjectedSystemLine(message)) {
    return looselyAnswersTo(COLLAB_SYSTEM_SPEAKER_LABEL, query)
  }
  const agentId = message.agentId
  if (!agentId) {
    // 常量词走同一份表(`dm to:"用户"` 的那份)。改了名的用户如果只能用新名字查,
    // 那工具描述里写的「用户」就是一句谎话 —— 而模型照着描述填,查回来是空。
    if ((COLLAB_USER_CONSTANT_WORDS as readonly string[]).includes(wanted)) return true
    const user = resolveUserIdentity()
    return looselyAnswersTo(formatCollabUserLabel(user.label, user.handle), query)
      || looselyAnswersTo(user.label, query)
  }
  if (agentId.toLowerCase() === wanted) return true
  return looselyAnswersTo(
    resolveCollabSpeakerLabel(agentId, [], id => findAgent(id)?.name),
    query,
  )
}

function clip(text: string): string {
  return text.length > HISTORY_LINE_MAX_CHARS
    ? `${text.slice(0, HISTORY_LINE_MAX_CHARS)}…`
    : text
}

/**
 * 信封头 —— 从 `COLLAB_ENVELOPE_TAG` 现算,不写死。
 *
 * 2026-08-02 把标签从 `say` 改成 `message` 时,一个写死的 `/^<say /` 会静默失配:
 * 不报错,只是每一行都少了 `room` —— 而"这条是哪间房说的"正是这个跨房工具唯一
 * 非说不可的东西。
 */
const ENVELOPE_HEAD = new RegExp(`^<${COLLAB_ENVELOPE_TAG} `)

/** 与房间投影同一个信封（`COLLAB_ENVELOPE_TAG`），额外带 `room` —— 跨房结果必须说清哪间房。 */
function renderLine(message: ChatMessage, roomName: string): string {
  const body = clip(message.content ?? '')
  const speaker = isCollabProjectedSystemLine(message)
    ? COLLAB_SYSTEM_SPEAKER_LABEL
    : message.agentId
      ? resolveCollabSpeakerLabel(message.agentId, [], id => findAgent(id)?.name)
      : formatCollabUserLabel(resolveUserIdentity().label, resolveUserIdentity().handle)
  const envelope = wrapCollabMessageEnvelope(speaker, body, message.timestamp)
  // `room` 挤进已经渲染好的信封头 —— 与其复制一份渲染器，不如在唯一那份的出口
  // 上加一个属性（两份渲染迟早分家，这个仓库为此付过两天代价）。
  return envelope.replace(ENVELOPE_HEAD, `<${COLLAB_ENVELOPE_TAG} room="${escapeAttr(roomName)}" `)
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

/** 查询指纹：换了筛选条件的游标必须被拒绝，而不是被当成本次查询的续页。 */
function fingerprint(input: {
  q?: string; who?: string; where?: string; since?: string; until?: string
}): string {
  const raw = JSON.stringify([input.q ?? '', input.who ?? '', input.where ?? '', input.since ?? '', input.until ?? ''])
  let hash = 5381
  for (let index = 0; index < raw.length; index++) hash = ((hash << 5) + hash + raw.charCodeAt(index)) | 0
  return (hash >>> 0).toString(36)
}

interface Hit {
  message: ChatMessage
  roomId: string
  roomName: string
}

/**
 * 一条命中在全序里的位置。游标存的就是它 —— **值本身，不是"第几条"**。
 *
 * 信封时间到分钟为止，跨房时**单一时间戳不构成全序** —— 两间房里同一分钟的两条
 * 消息谁在前，必须有确定答案，否则 keyset 游标会跳页或重页。三元组：
 * `时间戳 → roomId → messageId`。
 */
interface HitKey {
  at: number
  roomId: string
  id: string
}

function compareKeys(a: HitKey, b: HitKey): number {
  if (a.at !== b.at) return a.at - b.at
  if (a.roomId !== b.roomId) return a.roomId < b.roomId ? -1 : 1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

function keyOf(hit: Hit): HitKey {
  return { at: hit.message.timestamp ?? 0, roomId: hit.roomId, id: hit.message.id ?? '' }
}

function compareHits(a: Hit, b: Hit): number {
  return compareKeys(keyOf(a), keyOf(b))
}

function cursorOf(hit: Hit, print: string): string {
  const key = keyOf(hit)
  return `${key.at}:${key.roomId}:${key.id}|${print}`
}

type CursorParse = { ok: true; key: HitKey; print: string } | { ok: false }

/**
 * 游标解析。**读不懂就说读不懂**，不要退回"当第一页"。
 *
 * 静默当第一页会让模型拿到一份和上一页高度重叠、却没有任何标记的结果 —— 它读起来
 * 就是"翻页翻到了同样的东西"，而真相是它手里那串字符已经不是游标了。
 */
function parseCursor(cursor: string): CursorParse {
  const [key, print] = cursor.split('|')
  if (!key || !print) return { ok: false }
  const first = key.indexOf(':')
  const last = key.lastIndexOf(':')
  if (first <= 0 || last <= first) return { ok: false }
  const at = Number.parseInt(key.slice(0, first), 10)
  if (!Number.isFinite(at)) return { ok: false }
  return { ok: true, key: { at, roomId: key.slice(first + 1, last), id: key.slice(last + 1) }, print }
}

export async function searchCollabHistory(input: {
  sessionId: string
  q?: string
  who?: string
  where?: string
  since?: string
  until?: string
  limit: number
  cursor?: string
}): Promise<HistoryToolResult> {
  const self = resolveSelfAgentId(input.sessionId)
  if (!self.ok) return { ok: false, error: self.error }
  const agentId = self.agentId

  const candidates = candidateRooms(agentId)
  if (candidates.length === 0) return { ok: true, entries: [], total: 0, noRooms: true }

  let scope = candidates
  if (input.where) {
    const picked = pickRoom(input.where, candidates)
    if (!picked) {
      return {
        ok: true,
        entries: [],
        total: 0,
        // 房名是我能查的那些 —— 「不存在」与「不是你的」共用这一句，
        // 分开说等于给出一个探测面。
        unknownRoom: { available: candidates.slice(0, 10).map(c => c.meta.name ?? '未命名') },
      }
    }
    scope = [picked]
  }

  const print = fingerprint(input)
  let anchor: HitKey | undefined
  if (input.cursor) {
    const parsed = parseCursor(input.cursor)
    if (!parsed.ok) {
      return { ok: false, error: '这个游标读不懂。不带 cursor 重新查一次。' }
    }
    if (parsed.print !== print) {
      return {
        ok: false,
        error: '这个游标属于另一次查询（筛选条件变了）。用相同的 q / who / where / since / until 再查一次，或者不带 cursor 从头开始。',
      }
    }
    anchor = parsed.key
  }

  // 范围先收窄：窗口内这间房一个字都没写过 → 不可能命中，连读都省了。
  const sinceMs = input.since ? new Date(`${input.since}T00:00:00`).getTime() : undefined
  const ranged = scope.filter(c =>
    sinceMs === undefined || !Number.isFinite(sinceMs) || (c.meta.updatedAt ?? 0) >= sinceMs)

  const toScan = ranged.slice(0, HISTORY_MAX_ROOMS)

  const q = input.q?.trim().toLowerCase()
  const inRange: Hit[] = []
  const matched: Hit[] = []
  let bytes = 0
  let scannedRooms = 0

  for (const candidate of toScan) {
    if (bytes >= HISTORY_MAX_BYTES) break
    const { messages, bytes: read } = readRoomMessages(candidate.meta.id)
    bytes += read
    scannedRooms += 1
    const roomName = candidate.meta.name ?? '未命名'
    for (const message of messages) {
      if (!isCollabMessageVisible(message.timestamp, candidate.visibleUntil)) continue
      if (!message.content) continue
      if (!isCollabRoomFact({ ...message, content: message.content })) continue
      const day = dayOf(message.timestamp ?? 0)
      if (input.since && day < input.since) continue
      if (input.until && day > input.until) continue
      if (input.who && !matchesWho(message, input.who)) continue
      const hit: Hit = { message, roomId: candidate.meta.id, roomName }
      inRange.push(hit)
      if (!q || (message.content ?? '').toLowerCase().includes(q)) matched.push(hit)
    }
  }

  // 关键词没命中 → **只放宽 q 这一维**，返回范围内最近几条并明说。
  // 模型填错的几乎总是关键词，它填对的 who/where/since 已经足够窄；让一个坏
  // 关键词把一个好范围清零是最贵的失败。
  const fellBackToRange = Boolean(q) && matched.length === 0 && inRange.length > 0
  const pool = fellBackToRange ? inRange : matched

  pool.sort((a, b) => compareHits(b, a)) // 新的在前

  // 房数上限**与**字节上限都算进来。前者扫描前就知道，后者只有循环跑完才知道 ——
  // 用 `ranged.length - scannedRooms` 一口气覆盖两者。此前只减 `toScan.length`，
  // 于是撞上字节上限丢掉的房**一个标记都不留**，而输出读起来和"全查过了"一模一样。
  const skippedRooms = ranged.length - scannedRooms

  /**
   * 续页的定位：**找第一条严格更早的命中**，不是"找到锚点那条再往后一格"。
   *
   * 按下标定位要求锚点那条仍在本次结果里，而它随时可能不在:候选房按 `updatedAt`
   * 取前 `HISTORY_MAX_ROOMS` 间,两页之间任何一间房来一条新消息,就可能把锚点所在
   * 的房挤出扫描集(真机 22 间房、上限 10 间)。找不到时旧写法让 `from` 落到
   * `pool.length` 返回空页,而纯层把空页渲染成「这个范围里没有任何消息」——
   * 一个**带确定性的否定**,可消息明明还在。
   *
   * 游标里存的是**值**(时间戳/房/消息 id 三元组),不是下标。拿它跟全序比大小,
   * 锚点那条在不在都不影响答案。
   */
  const from = anchor
    ? (() => {
        const index = pool.findIndex(hit => compareKeys(keyOf(hit), anchor) < 0)
        return index < 0 ? pool.length : index
      })()
    : 0
  const limit = fellBackToRange ? Math.min(input.limit, HISTORY_FALLBACK_LIMIT) : input.limit
  const page = pool.slice(from, from + limit)
  const last = page[page.length - 1]
  const hasMore = from + page.length < pool.length

  return {
    ok: true,
    entries: page.map(hit => ({ line: renderLine(hit.message, hit.roomName) })),
    total: pool.length,
    scannedRooms,
    // 带着游标翻到了尽头 —— 「没有更早的了」与「这个范围里什么都没有」是两件事,
    // 共用一句话就等于让模型把"翻完了"读成"从来没有过"。
    ...(anchor && page.length === 0 ? { endOfRange: true } : {}),
    ...(skippedRooms > 0 ? { skippedRooms } : {}),
    ...(fellBackToRange ? { fellBackToRange: true } : {}),
    ...(hasMore && last ? { nextCursor: cursorOf(last, print) } : {}),
  }
}


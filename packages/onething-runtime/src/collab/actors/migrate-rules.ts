/**
 * v2 → v3 迁移的**纯规则**(docs/design/collab-actor-v3.md §4,D5)。
 *
 * 这里只做两件事:**映射**(v2 的一格 → v3 的哪一格)与**对账计算**(这一格是怎么
 * 来的、近似了多少、截断了多少)。读盘、备份、写盘、marker 全在装配层的
 * `@onething/backend` `wiring/collab/actors/migrate.ts` —— 迁移是一趟单向门,而单向门上的
 * 每一条判断都必须能在没有磁盘的情况下被逐条问一遍。
 *
 * ## 迁移面有多大(§1.2 的 D2 实施勘误之后)
 *
 * 蓝图 §4 原本列了六条,其中「经历流」那条已作废:v3 的经历流**就是**既有的
 * per-(agent×房) 执行会话(`agent-exec-<agentId>-<roomId>`),AgentActor 接管它的
 * 所有权而不是另起一份。于是真正要搬的只剩三样:
 *
 *  1. **房间账**:`collab/<roomId>/state.json` → `collab/<roomId>/actors/room.json`;
 *  2. **agent 账的两个水位**:执行会话 meta 上的 `collab.seenMessageId` → v3 的
 *     `rooms[roomId].readMessageId`(投递水位初始化 = 已读水位:迁移那一刻没有在途);
 *  3. **未读尾巴回填**:游标之后的房间消息,补成 `room:posted` 事件进 mailbox ——
 *     没有它,一个离开三天的 agent 在 v3 的第一轮会以为世界从迁移那一刻才开始。
 *
 * 房间转录、看板 `board.json`、经历流三样**零迁移**,迁移器对它们只做存在性校验。
 *
 * ## 为什么 `recipients` 是**传进来**的
 *
 * 「这条消息该不该进这个 agent 的信箱」在 v3 只有一条答案:
 * `collabRoomBroadcastRecipients`(房间消息给全体成员**除了作者自己**)。它住在装配
 * 层(与 RoomActor 同文件),纯层够不着。抄一份过来的代价不是重复代码,是**两条会漂
 * 的可见性边界** —— 而可见性边界漂了的样子是「agent 在信箱里读到自己刚说过的话」。
 * 所以它是一个必填参数:调用方必须把真机那一个递进来。
 */
import { createActorEvent, FLOOR_LEASE_INITIAL_EPOCH, type ActorEvent } from '@onething/core/actors'

import { COLLAB_DEFAULT_UNREAD_MAX } from '../history-window.js'
import type { CollabMessageLike } from '../types.js'
import {
  collabActorRef,
  collabRoomPosted,
  type CollabActorVerb,
  type CollabRoomPostedVerb,
} from './protocol.js'
import type { CollabAgentRoomAccount } from './mind-rules.js'
import { orderTranscriptMessages, replayMessageAuthor } from './replay.js'
import {
  collabRoomEventId,
  createCollabRoomAccount,
  type CollabRoomAccount,
} from './room-rules.js'

/** 迁移器的版本号。marker 里记它 —— 将来要补跑某一版的补丁,判据在这。 */
export const COLLAB_V3_MIGRATION_VERSION = 1

/** marker 文件名(落在 `<store>/collab/` 下)。存在 = 这台机器已经迁过了。 */
export const COLLAB_V3_MIGRATION_MARKER_FILE = 'v3-migrated.json'

/** 备份目录前缀:`<store>/backup/collab-v2-<timestamp>/`。 */
export const COLLAB_V2_BACKUP_DIR_PREFIX = 'collab-v2-'

/**
 * 回填上限。
 *
 * **直接复用未读窗口的口径**(`COLLAB_DEFAULT_UNREAD_MAX = 50`),不新造一个数:
 * 回填出来的这些事件,下一轮就是那个 agent 眼里的「未读」,而未读一旦超过窗口
 * 就会被 `planCollabHistoryWindow` 并回历史。如果回填上限比未读窗口宽,多出来的
 * 那一截是纯粹的信箱膨胀 —— 投进去了,却永远不会以「新消息」的身份被读到。
 */
export const COLLAB_MIGRATION_BACKFILL_MAX = COLLAB_DEFAULT_UNREAD_MAX

/* ── 1. 房间账 ──────────────────────────────────────────────────────────── */

/**
 * v2 `collab/<roomId>/state.json` 的**读视图**。
 *
 * 刻意只列迁移要用的四格,而不是 import v2 的 `CollabRoomStateFile`:迁移器读的是
 * **盘上的历史数据**,不是当前代码里那个类型。v2 的类型到 D6 会跟着代码一起删,
 * 而这份读视图必须活到最后一台机器迁完为止。
 */
export interface CollabV2RoomStateView {
  lastProcessedMessageId?: string
  lastProcessedAt?: number
  chainCount: number
  floorEpoch: number
  /** 只用于对账:这份 v2 账里还有哪些格子被迁移**有意丢弃**了。 */
  droppedFields: string[]
}

/** v2 账里**不迁**的那几格。列出来是为了让对账报告能说清「丢了什么」。 */
const V2_DROPPABLE_FIELDS = ['activations', 'plan'] as const

/**
 * 认一份 v2 房间账。认不出形状返回 null —— 由调用方决定是标 failed 还是当新房。
 *
 * 与 `normalizeCollabRoomAccount` 的「认不出就当新账」不同:那是**运行时**,退回
 * 新账的代价只是一次链计数归零;这里是**迁移**,一份读错的账会被写进 v3 然后
 * 顶掉原来的事实,所以宁可标 failed 让人来看一眼。
 */
export function readCollabV2RoomState(value: unknown): CollabV2RoomStateView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  // v2 只发过 `version: 1`。别的数字是别人的文件,不是这间房的账。
  if (raw.version !== 1) return null
  const droppedFields = V2_DROPPABLE_FIELDS.filter(field => {
    const held = raw[field]
    return Array.isArray(held) ? held.length > 0 : held !== undefined && held !== null
  })
  return {
    ...(typeof raw.lastProcessedMessageId === 'string'
      ? { lastProcessedMessageId: raw.lastProcessedMessageId }
      : {}),
    ...(typeof raw.lastProcessedAt === 'number' ? { lastProcessedAt: raw.lastProcessedAt } : {}),
    chainCount: typeof raw.chainCount === 'number' && raw.chainCount >= 0 ? raw.chainCount : 0,
    floorEpoch: typeof raw.floorEpoch === 'number' && raw.floorEpoch >= 0 ? raw.floorEpoch : 0,
    droppedFields: [...droppedFields],
  }
}

/** 一间房的账映射对账行。 */
export interface CollabRoomMigrationSummary {
  roomId: string
  /** v2 的水位 → v3 的水位(同一个值,只是换了个家)。 */
  watermarkMessageId?: string
  watermarkAt?: number
  /** v2 `floorEpoch` → v3 租约代数起点。 */
  epoch: number
  /** 携带过来的链计数(**近似值**,见 `planCollabRoomAccountMigration`)。 */
  chainCount: number
  /** 恒为 true:这个数在 v3 的口径下无法从历史重算,只能延续。 */
  chainCountApproximate: boolean
  /** v2 账里被有意丢弃的格子(`activations` / `plan`)。 */
  droppedFields: string[]
}

export interface CollabRoomMigrationPlan {
  account: CollabRoomAccount
  summary: CollabRoomMigrationSummary
}

/**
 * v2 房间账 → v3 房间账。
 *
 * ## chainCount:延续性近似,不重构租约史
 *
 * v3 的链计数口径是「**上一个清零事件以来发出的租约数**」,而 v2 从来没发过租约
 * ——历史里根本不存在可数的对象。三条路:
 *
 *  - **归零**:迁移当天所有房间的链闸集体失忆,一间正在长接龙里的房会因此多跑
 *    一整轮才撞上闸。这是「迁移悄悄放松了一道安全闸」,最不该选的一条;
 *  - **从转录重构**:要认 harvest / thinking / pass 三种标记再反推「这算不算一张
 *    牌」——那正是 v3 想消灭的 live/重放双实现,为了一个过渡期的数字把它复活一遍
 *    不划算,而且反推错了没有任何东西会报警;
 *  - **延续**(本实现):直接把 v2 的数字搬过来当起点。它在 v3 的口径下不精确,
 *    但方向是**保守**的(v2 数说的话、v3 数发的牌,一句话至少对应一张牌,所以
 *    携带值只会低估不会高估在外的牌数),而且**下一条人类消息就自愈** ——
 *    `collabChainReset` 一到,这个近似值当场清零,此后全是 v3 自己数的。
 *
 * 所以对账报告里它带一个 `chainCountApproximate: true`,而不是假装它是精确的。
 *
 * ## floorEpoch:取大者,代数只增不减
 *
 * v2 的 `floorEpoch` 从 0 起算,v3 的租约初始代数是 1。直接搬 0 过来的话,新发的
 * 牌一出生就比初始代数还旧,`validateFloorLease` 会把它判成 `stale-epoch` ——
 * 一间「谁说话都被拒」的房。取大者让代数在两套体系间只增不减。
 */
export function planCollabRoomAccountMigration(input: {
  roomId: string
  state: CollabV2RoomStateView
}): CollabRoomMigrationPlan {
  const { roomId, state } = input
  const epoch = Math.max(FLOOR_LEASE_INITIAL_EPOCH, state.floorEpoch)
  const fresh = createCollabRoomAccount(roomId, { epoch })
  const account: CollabRoomAccount = {
    ...fresh,
    chainCount: state.chainCount,
    watermark: {
      ...(state.lastProcessedMessageId ? { messageId: state.lastProcessedMessageId } : {}),
      ...(state.lastProcessedAt === undefined ? {} : { at: state.lastProcessedAt }),
    },
    // `phase` 有意留空:v2 没有相位这个概念,编一个初始相位等于替裁判做了一次
    // 它没做过的决定。缺省 = 无相位,第一次 `set-floor-policy` 才写。
  }
  return {
    account,
    summary: {
      roomId,
      ...(state.lastProcessedMessageId ? { watermarkMessageId: state.lastProcessedMessageId } : {}),
      ...(state.lastProcessedAt === undefined ? {} : { watermarkAt: state.lastProcessedAt }),
      epoch,
      chainCount: state.chainCount,
      chainCountApproximate: true,
      droppedFields: [...state.droppedFields],
    },
  }
}

/* ── 2. agent 账 + 未读尾巴回填 ─────────────────────────────────────────── */

/** 可见性边界的注入口。真身是装配层的 `collabRoomBroadcastRecipients`。 */
export type CollabMigrationRecipients = (
  verb: CollabActorVerb,
  memberIds: readonly string[],
) => string[]

/** 一个 (agent × 房) 的对账行。 */
export interface CollabAgentRoomMigrationSummary {
  agentId: string
  roomId: string
  /** v2 执行会话 meta 上的 `collab.seenMessageId`。 */
  seenMessageId?: string
  /**
   * 游标在转录里的下标(0 起)。`-1` = 没有游标,或者游标那条消息已经被删。
   * 两种情况都**不产生回填**(见下),报告里因此看得出「为什么这一格是 0 条」。
   */
  seenIndex: number
  /** 这间房的转录总条数。 */
  transcriptCount: number
  /** 真的写进 mailbox 的条数。 */
  backfilled: number
  /** 因为超过 `COLLAB_MIGRATION_BACKFILL_MAX` 而从**最旧**截掉的条数。 */
  truncated: number
  /** 迁出来的回合数(下界近似,见 `planCollabAgentRoomMigration`)。 */
  turns: number
}

export interface CollabAgentRoomMigrationPlan {
  /** 写进 `agents-v3/<agentId>/state.json` 的 `rooms[roomId]` 这一格。 */
  room: CollabAgentRoomAccount
  /** 追加进 `agents-v3/<agentId>/inbox.jsonl` 的事件,按时间序。 */
  events: ActorEvent<CollabRoomPostedVerb>[]
  summary: CollabAgentRoomMigrationSummary
}

/**
 * 一个 (agent × 房) 的账 + 未读尾巴。
 *
 * ## 两个水位:read 从 v2 来,delivered 初始化 = read
 *
 * v2 只有一个游标(`collab.seenMessageId`,「模型真的读到哪」)。v3 分两个:
 * `delivered`(处理过的最后一条)与 `read`(回合收尾才前进的那个)。迁移那一刻
 * **没有在途**——不存在「投了但还没读」的消息,因为 v2 压根不投递。所以两个水位
 * 同点起跑是这一刻唯一正确的形态;把 delivered 设得比 read 靠前会凭空捏造出一段
 * 「已投递未读」,而那一段的内容谁都说不出来。
 *
 * ## 没有游标 = 不回填
 *
 * 与 `planCollabHistoryWindow` 同一条纪律:游标缺省或定位不到时**不产生未读**。
 * 一个从没在这间房跑过的 agent,整段历史就是它的上下文(首轮铺底会给它);把 325
 * 条历史当成「新消息」塞进信箱,既是一次信箱膨胀,也会让它上来就对着三天前的话题
 * 发言。保守方向只有一个:零回填。
 *
 * ## `turns`:下界近似
 *
 * v2 没有 per-(agent×房) 的回合计数器。`turns === 0` 在 v3 是「首轮铺底」的判据
 * (`agent-actor.ts` 的 `bootstrap`),所以它不能随便填 0 —— 一个带着已读水位的
 * agent 说自己从没跑过,是自相矛盾的,而这个矛盾的代价是它的第一轮拿到全量历史。
 * 取证据的下界:它在这间房说过几句话(转录里 `agentId === 自己` 的条数),再与
 * 「有可定位的已读游标 ⇒ 至少跑过一轮」求大者。
 */
export function planCollabAgentRoomMigration(input: {
  agentId: string
  roomId: string
  /** 房间转录(任意顺序,内部按时间稳定排序)。 */
  messages: readonly CollabMessageLike[]
  seenMessageId?: string
  seenAt?: number
  /** 可见性边界。传装配层的 `collabRoomBroadcastRecipients`。 */
  recipients: CollabMigrationRecipients
  backfillMax?: number
}): CollabAgentRoomMigrationPlan {
  const { agentId, roomId, seenMessageId, recipients } = input
  const backfillMax = normalizeBackfillMax(input.backfillMax)
  const ordered = orderTranscriptMessages(input.messages)

  const seenIndex = seenMessageId
    ? ordered.findIndex(message => message.id === seenMessageId)
    : -1
  const seenAt = input.seenAt ?? (seenIndex >= 0 ? ordered[seenIndex]?.timestamp : undefined)

  const ownMessages = ordered.filter(message => message.agentId === agentId).length
  const turns = Math.max(ownMessages, seenIndex >= 0 ? 1 : 0)

  const room: CollabAgentRoomAccount = {
    // 游标定位不到时不写水位:一个指向已删消息的 id 在 v3 里会被 history-window
    // 读成「从没读过」,写进账只是让排障时多一个骗人的字段。
    ...(seenIndex >= 0 && seenMessageId
      ? {
          deliveredMessageId: seenMessageId,
          readMessageId: seenMessageId,
          ...(seenAt === undefined ? {} : { deliveredAt: seenAt, readAt: seenAt }),
        }
      : {}),
    ...(seenAt === undefined || seenIndex < 0 ? {} : { lastTurnAt: seenAt }),
    turns,
  }

  const events: ActorEvent<CollabRoomPostedVerb>[] = []
  let truncated = 0
  if (seenIndex >= 0) {
    const tail: Array<{ message: CollabMessageLike; ordinal: number }> = []
    for (let index = seenIndex + 1; index < ordered.length; index += 1) {
      const message = ordered[index]
      const verb = postedVerbOf(roomId, message)
      // 可见性边界现问一次 —— 自己说的话不进自己的信箱(它在自己的经历流里)。
      if (!recipients(verb, [agentId]).includes(agentId)) continue
      tail.push({ message, ordinal: index + 1 })
    }
    // 超限从**最旧**截断:留下的是离现在最近的那一截。反过来截(留最旧)会让
    // 一个刚发生的 @ 被丢掉,而那正是回填唯一真正要救的东西。
    truncated = Math.max(0, tail.length - backfillMax)
    for (const entry of tail.slice(truncated)) {
      events.push(backfillEvent({ agentId, roomId, message: entry.message, ordinal: entry.ordinal }))
    }
  }

  return {
    room,
    events,
    summary: {
      agentId,
      roomId,
      ...(seenMessageId ? { seenMessageId } : {}),
      seenIndex,
      transcriptCount: ordered.length,
      backfilled: events.length,
      truncated,
      turns,
    },
  }
}

function normalizeBackfillMax(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return COLLAB_MIGRATION_BACKFILL_MAX
  return Math.floor(value)
}

function postedVerbOf(roomId: string, message: CollabMessageLike): CollabRoomPostedVerb {
  return collabRoomPosted({ roomId, author: replayMessageAuthor(message, roomId), message })
}

/**
 * 一条回填事件。
 *
 * 形状与 `CollabRoomActor.deliver` 投出去的那一封**逐字段相同**(from=房间、
 * to=收件人、type=动词名、payload=动词),因为它就是同一封信 —— 只是晚了几天,
 * 由迁移器补投。
 *
 * ## 事件 id 走 `collabRoomEventId`(`evt:<roomId>:<messageId>`)
 *
 * 不是随手编一个前缀,更不是重放架那个 `replay:` 命名空间(那是测试架的地盘)。
 * 用**真机的那一条派生**换来两件事:
 *  - **迁移器重入不会重复投**:同一条消息第二次算出来还是同一个 id,消费端的
 *    持久去重窗与迁移器自己的日志比对都认得出;
 *  - **与房间将来可能的补播天然同一身份**:如果某天 RoomActor 因为续播补投了
 *    同一条消息,收件人看到的是同一个 id,而不是两条长得一样的信。
 *
 * 缺 id 的老消息退到 `evt:<roomId>:n<ordinal>` —— ordinal 是它在**排序后**转录里
 * 的位置(1 起),同样确定性。
 */
function backfillEvent(input: {
  agentId: string
  roomId: string
  message: CollabMessageLike
  ordinal: number
}): ActorEvent<CollabRoomPostedVerb> {
  const verb = postedVerbOf(input.roomId, input.message)
  return createActorEvent<CollabRoomPostedVerb>({
    id: collabRoomEventId(input.roomId, verb, input.ordinal),
    // 事件时刻取消息落库的时刻,不取迁移的时刻:折叠信封的 `since`、排序、以及
    // 「这事什么时候发生的」全读它,填成 now 会让三天前的话看起来是刚说的。
    at: input.message.timestamp ?? input.ordinal,
    type: verb.type,
    from: collabActorRef('room', input.roomId),
    to: collabActorRef('agent', input.agentId),
    payload: verb,
  })
}

/* ── 3. 零迁移三类的校验口径 ────────────────────────────────────────────── */

/** 零迁移项的校验结论。迁移器不修它们,只回答「还在不在、读不读得动」。 */
export type CollabMigrationCheckStatus =
  /** 在,且读得动。 */
  | 'ok'
  /** 不存在。对这三类都不是错误(没开过看板的房就是没有 board.json)。 */
  | 'absent'
  /** 在,但读不动(半截 JSON / 权限)。这一条要进报告让人看一眼。 */
  | 'unreadable'

export interface CollabMigrationCheck {
  kind: 'transcript' | 'board' | 'experience'
  /** 房间 id;`experience` 另带 agentId。 */
  roomId: string
  agentId?: string
  status: CollabMigrationCheckStatus
  /** 转录的消息条数(`ok` 时才有意义)。 */
  count?: number
  detail?: string
}

/* ── 4. 报告 ────────────────────────────────────────────────────────────── */

/** 一间房的迁移结果。`failed` 不中断全局 —— 一份坏账不该拖住其它十间房。 */
export type CollabRoomMigrationStatus = 'migrated' | 'skipped' | 'failed'

export interface CollabRoomMigrationEntry {
  roomId: string
  status: CollabRoomMigrationStatus
  /** `migrated` 时的账映射摘要。 */
  summary?: CollabRoomMigrationSummary
  /** `failed` 时的原因(半截 JSON、认不出的形状…)。 */
  error?: string
  /** 这间房的成员数(成员表 ∪ 曾在册)。 */
  memberCount: number
  /** 每个 (agent × 房) 的对账行。 */
  agents: CollabAgentRoomMigrationSummary[]
  /** 零迁移三类的校验结论。 */
  checks: CollabMigrationCheck[]
}

export interface CollabMigrationTotals {
  rooms: number
  roomsMigrated: number
  roomsSkipped: number
  roomsFailed: number
  agentPairs: number
  backfilled: number
  truncated: number
  checksUnreadable: number
}

export interface CollabV3MigrationReport {
  version: typeof COLLAB_V3_MIGRATION_VERSION
  dryRun: boolean
  /** 整体跳过了吗(marker 已存在)。 */
  skipped: boolean
  at: number
  storePath: string
  /** 备份目录。dry-run 与整体跳过时为 undefined(没有备份发生)。 */
  backupDir?: string
  rooms: CollabRoomMigrationEntry[]
  totals: CollabMigrationTotals
}

/** 落在 `<store>/collab/v3-migrated.json` 的那份 marker。 */
export interface CollabV3MigrationMarker {
  version: typeof COLLAB_V3_MIGRATION_VERSION
  at: number
  backupDir?: string
  totals: CollabMigrationTotals
}

export function summarizeCollabMigration(
  rooms: readonly CollabRoomMigrationEntry[],
): CollabMigrationTotals {
  const totals: CollabMigrationTotals = {
    rooms: rooms.length,
    roomsMigrated: 0,
    roomsSkipped: 0,
    roomsFailed: 0,
    agentPairs: 0,
    backfilled: 0,
    truncated: 0,
    checksUnreadable: 0,
  }
  for (const room of rooms) {
    if (room.status === 'migrated') totals.roomsMigrated += 1
    else if (room.status === 'skipped') totals.roomsSkipped += 1
    else totals.roomsFailed += 1
    totals.agentPairs += room.agents.length
    for (const agent of room.agents) {
      totals.backfilled += agent.backfilled
      totals.truncated += agent.truncated
    }
    for (const check of room.checks) {
      if (check.status === 'unreadable') totals.checksUnreadable += 1
    }
  }
  return totals
}

/**
 * 对账报告的一行一条形态。
 *
 * 报告是**给人看的**:一趟迁移可能覆盖十几间房、几十个 (agent×房),而人要在
 * `--dry-run` 的输出里一眼看出「哪一格不对劲」。所以每一行都自带它的判据
 * (游标位、回填量、截断量),而不是只给一个总数。
 */
export function formatCollabMigrationReport(report: CollabV3MigrationReport): string[] {
  const lines: string[] = []
  lines.push(`# store     ${report.storePath}`)
  lines.push(`# 模式      ${report.dryRun ? 'dry-run(不写盘)' : '执行'}`)
  if (report.skipped) lines.push('# 状态      已迁过(marker 存在),整体跳过')
  if (report.backupDir) lines.push(`# 备份      ${report.backupDir}`)
  lines.push('')
  for (const room of report.rooms) {
    lines.push(formatRoomLine(room))
    for (const agent of room.agents) lines.push(`    ${formatAgentLine(agent)}`)
    for (const check of room.checks) {
      if (check.status !== 'ok') lines.push(`    ${formatCheckLine(check)}`)
    }
  }
  const { totals } = report
  lines.push('')
  lines.push(
    `总计 房 ${totals.rooms}(迁 ${totals.roomsMigrated} / 跳 ${totals.roomsSkipped} / 失败 ${totals.roomsFailed})`
    + ` · (agent×房) ${totals.agentPairs} · 回填 ${totals.backfilled} 条(截断 ${totals.truncated})`
    + ` · 校验异常 ${totals.checksUnreadable}`,
  )
  return lines
}

function formatRoomLine(room: CollabRoomMigrationEntry): string {
  if (room.status === 'failed') return `[failed]   ${room.roomId}  ${room.error ?? '(未知原因)'}`
  if (room.status === 'skipped') return `[skipped]  ${room.roomId}  v3 账已存在,不覆盖`
  const summary = room.summary
  const watermark = summary?.watermarkMessageId ?? '(无)'
  const dropped = summary?.droppedFields.length ? ` 丢弃=${summary.droppedFields.join(',')}` : ''
  return `[migrated] ${room.roomId}  成员=${room.memberCount}`
    + ` watermark=${watermark} epoch=${summary?.epoch ?? '?'}`
    + ` chain=${summary?.chainCount ?? '?'}(近似)${dropped}`
}

function formatAgentLine(agent: CollabAgentRoomMigrationSummary): string {
  const cursor = agent.seenIndex >= 0
    ? `${agent.seenIndex + 1}/${agent.transcriptCount}`
    : `无游标(${agent.transcriptCount} 条转录)`
  const truncated = agent.truncated > 0 ? ` 截断=${agent.truncated}` : ''
  return `${agent.agentId}  游标=${cursor} 回填=${agent.backfilled}${truncated} turns=${agent.turns}`
}

function formatCheckLine(check: CollabMigrationCheck): string {
  const who = check.agentId ? `${check.agentId}@${check.roomId}` : check.roomId
  return `! ${check.kind} ${who} ${check.status}${check.detail ? ` — ${check.detail}` : ''}`
}

/**
 * 调度时间轴的**纯规则**(docs/design/collab-v3-observability.md §3.3,qm P2-8 落地)。
 *
 * 这个文件回答蓝图四个必答问题里的最后一个 ——「**刚才**为什么是那样?」。前三个问题
 * 问的是此刻,快照答得了;这一个问的是过去,而过去在 D8 之前只活在 inspector 的
 * 内存环里(≤32 条,重启即失忆)。抓瞎最惨的时刻恰恰是进程不对劲的时刻,所以答案
 * 必须在盘上。
 *
 * ## 为什么账本不是"再存一份状态"
 *
 * 房账(`room.json`)是**真账**:它说的是此刻谁持牌、链走到哪。时间轴是**诊断**:
 * 它说的是这一路上发生过什么。两者的耐久等级因此不同(账同步原子写,时间轴普通
 * 追加、不 fsync),生命周期也不同(账永久,时间轴保留 14 天)。把时间轴当账用
 * (比如从它重建租约表)是错的,反过来也是 —— 账里根本没有「裁判为什么这么排」。
 *
 * ## 保密纪律:永不携带消息正文
 *
 * 每一行只带 **id 引用**(消息 id / 牌号 / 裁决 token / 卡号)与**枚举**,一个字的
 * 正文都不进。理由不是省空间:房间转录有成员表这道可见性边界,而一份按房落盘、
 * 谁都能 `cat` 的诊断账绕开了它。文件末尾那条 `COLLAB_SCHEDULER_LOG_CARRIES_NO_TRANSCRIPT`
 * 是类型级的门 —— 哪天有人往行里加一个 `content`,typecheck 当场红。
 *
 * 唯一的例外是裁决的 `why`(≤60 字的一句话理由)与死信的 `error` 首行:它们是
 * **系统自己写的**,不是任何人说的话,而没有它们「刚才为什么没人理我」就还是猜。
 */
import type { CollabActivationReason } from '../activation.js'
import type {
  CollabActorVerb,
  CollabFloorRevokeReason,
  CollabWorkerOutcome,
  CollabYieldReason,
} from './protocol.js'
import type { CollabRaisedHand } from './floor-policy.js'
import {
  resolveCollabRoomHandBlock,
  type CollabRoomAccount,
  type CollabRoomEffects,
  type CollabRoomGates,
  type CollabRoomHandBlock,
} from './room-rules.js'

/* ── 行 ───────────────────────────────────────────────────────────────────── */

/**
 * 每一行都有的两格。
 *
 * `triggeredBy` 是这条账的**脊梁**:一条消息进房之后发生的每一件事都指得回上一件,
 * 于是「谁举了手 → 裁判怎么排 → 牌发给了谁 → 谁说了话」在文件里是一条能走的链,
 * 而不是一堆时间上挨着、逻辑上互不相干的行。没有它,回查只能靠时间戳猜因果,而
 * 并行的房间里那个猜法必然错。
 */
export interface CollabSchedulerLogBase {
  at: number
  /** 上游那件事的 id:消息 id / 裁决 token / 牌号 / 卡号 / 事件 id。 */
  triggeredBy?: string
}

/** 一条消息落进房间。链上的根。 */
export interface CollabSchedulerPostedRow extends CollabSchedulerLogBase {
  type: 'posted'
  /** 下游各行的 `triggeredBy` 就是它。 */
  messageId?: string
  authorKind: 'user' | 'agent' | 'system'
  authorId?: string
  /** 这条消息清了链吗(人类发言 / 带标记的外部注入)。 */
  chainReset?: boolean
}

/** 有人举手。 */
export interface CollabSchedulerHandRow extends CollabSchedulerLogBase {
  type: 'hand'
  agentId: string
  reason: CollabActivationReason
  origin: CollabRaisedHand['origin']
}

/** 裁决窗开了。`candidates` 是开窗那一刻队里的手(裁判读它当下限)。 */
export interface CollabSchedulerJudgeOpenRow extends CollabSchedulerLogBase {
  type: 'judge-open'
  token: string
  candidates: string[]
}

/**
 * 裁判答了。
 *
 * `why` / `elapsedMs` / `model` 三格是这一行存在的**全部理由**:它们在 D8 之前
 * 用完即弃,于是「刚才为什么没人理我」只能猜,换裁决算法时也没有任何对照数据
 * (qm 文档当年就指出没有账本就无法对比算法)。
 */
export interface CollabSchedulerJudgeVerdictRow extends CollabSchedulerLogBase {
  type: 'judge-verdict'
  token: string
  /** 授牌次序。**空数组是一个有效答案**(「这轮谁都不该说」)。 */
  order: string[]
  why?: string
  elapsedMs: number
  /** 买这次调用用的模型。没解析出 provider 时缺席。 */
  model?: string
}

/**
 * 裁决降级 —— 与「空裁决」必须分开的那一件事(referee-rules 的同一条教训)。
 * 前者是链断了(必须修),后者是读懂了的沉默(不用管)。
 */
export interface CollabSchedulerJudgeDegradedRow extends CollabSchedulerLogBase {
  type: 'judge-degraded'
  token: string
  /** 'timeout' | 'error' | 'unreadable' | 'provider-unresolved' | … */
  reason: string
  elapsedMs?: number
}

/** 发牌。`leaseId` 是下游 speak/yield/revoke 的 `triggeredBy`。 */
export interface CollabSchedulerGrantRow extends CollabSchedulerLogBase {
  type: 'grant'
  agentId: string
  leaseId: string
  reason: CollabActivationReason
}

/** 一只手撞在闸上。同一只手同一道闸只记一次(见 `deriveCollabSchedulerLogRows`)。 */
export interface CollabSchedulerGateBlockRow extends CollabSchedulerLogBase {
  type: 'gate-block'
  agentId: string
  gate: CollabRoomHandBlock
}

/** 有人说了一句。**只有 messageId,没有正文**。 */
export interface CollabSchedulerSpeakRow extends CollabSchedulerLogBase {
  type: 'speak'
  agentId: string
  leaseId: string
  messageId?: string
}

/** 让位。 */
export interface CollabSchedulerYieldRow extends CollabSchedulerLogBase {
  type: 'yield'
  agentId: string
  leaseId: string
  reason?: CollabYieldReason
}

/** 收牌(让位结算、换代、过期、喊停)。 */
export interface CollabSchedulerRevokeRow extends CollabSchedulerLogBase {
  type: 'revoke'
  agentId: string
  leaseId: string
  cause: CollabFloorRevokeReason
}

/** 换相。 */
export interface CollabSchedulerPhaseRow extends CollabSchedulerLogBase {
  type: 'phase'
  name: string
  previousPhase?: string
  epoch: number
}

/** 派出一只手。 */
export interface CollabSchedulerWorkerSpawnRow extends CollabSchedulerLogBase {
  type: 'worker-spawn'
  agentId: string
  workerId: string
  cardId: string
}

/** 一只手交活。 */
export interface CollabSchedulerWorkerResultRow extends CollabSchedulerLogBase {
  type: 'worker-result'
  agentId: string
  workerId: string
  cardId: string
  outcome: CollabWorkerOutcome
}

/**
 * 一封信炸了。
 *
 * 这一行是整本账里最值钱的一条:在它之前,事件处理失败让系统**静默变哑** ——
 * 循环继续跑(那是对的),坏信进一个没有消费者的内存环,而用户看到的是「它没回应」。
 * 「它没回应」和「它试过但炸了」是两个完全不同的事故,这一行是分开它们的地方。
 */
export interface CollabSchedulerDeadLetterRow extends CollabSchedulerLogBase {
  type: 'dead-letter'
  /** 哪个 actor(`room:<id>` / `agent:<id>`)。 */
  actor: string
  eventType: string
  /** 错误**首行**。堆栈不进账 —— 它属于 crash-log,不属于调度时间轴。 */
  error: string
}

/* ── 外部通路三类(E6,claude-code-integration-v2 §6)──────────────────────── */
//
// 在这三类之前,一个外部 agent(Claude Code)的回合在时间轴上是**一片空白**:
// 房间那一侧看得见发牌与收牌,中间那几分钟里它跑了什么工具、被哪一次提问卡住、
// 最后是跑完了还是被掐了 —— 一个字都没有。F3 那 2 分 11 秒之所以只能靠截图复盘,
// 根子就在这里。
//
// 三类都**只带 id 与枚举**,与本文件其余十四类同一条保密纪律:提问的题干不入账
// (它在转录与交互卡里,按可见性走),工具的 input 不入账(那是正文的另一种形态)。

/** 外部回合怎么结束的。`aborted` 含人级撤牌与 `connector.interrupt`(E5)。 */
export type CollabExternalTurnOutcome = 'complete' | 'error' | 'aborted'

/**
 * 一次外部回合的起 / 落。
 *
 * 起落写成**同一类的两相**而不是两类:回查时这两行要成对读(「起了却没落」正是
 * 挂死的形状),分成两类只会让 `--type` 过滤每次都要写两个名字。
 */
export interface CollabSchedulerExternalTurnRow extends CollabSchedulerLogBase {
  type: 'external-turn'
  agentId: string
  /** 哪个执行器(`claude-code-agent` / `acp` / …)。 */
  connectorId: string
  phase: 'start' | 'end'
  /** 仅 `end` 有。 */
  outcome?: CollabExternalTurnOutcome
  /** 仅 `end` 有,墙钟毫秒。 */
  elapsedMs?: number
}

/**
 * 外部回合里一次工具调用的**决定**(不是它的结果)。
 *
 * `hostTool` 是这一行最值钱的一格:宿主工具(经进程内 MCP 注入,跑在我们自己的
 * 执行器里,真正的门在下游)与 SDK 自带工具(跑在 CLI 沙箱里,只剩审批这一座桥)
 * 在 `canUseTool` 里是两条完全不同的路。分不开它们,一条 `allow` 就说不清是
 * 「放行给下游去审」还是「用户点了同意」。
 */
export interface CollabSchedulerExternalToolRow extends CollabSchedulerLogBase {
  type: 'external-tool'
  agentId: string
  connectorId: string
  /** 归一化之后的名字(`mcp__onething__` 前缀已剥,与本地回合逐字相同)。 */
  toolName: string
  decision: 'allow' | 'deny'
  hostTool: boolean
  toolCallId?: string
}

/** 一次提问的五相。后四相与 `InteractionOutcome` 逐字同名(属主在 core/interaction)。 */
export type CollabSchedulerInteractionPhase =
  | 'open'
  | 'answered'
  | 'declined'
  | 'timeout'
  | 'aborted'

/**
 * 提问的开与结。
 *
 * `origin` 的字面量属主是 `@onething/core/interaction` 的 `InteractionOrigin`,
 * 这里照抄一份而不是 import —— 本文件是纯规则的叶子,一条通往 core 的边会让
 * 金重放与纯测试跟着搬。抄错不会静默:产生点那一侧是直接把 `request.origin`
 * 赋进来的,core 哪天多一种来源,那一行当场红。
 */
export interface CollabSchedulerInteractionRow extends CollabSchedulerLogBase {
  type: 'interaction'
  phase: CollabSchedulerInteractionPhase
  /** `InteractionRequest.id`。`open` 之后各相的 `triggeredBy` 就是它。 */
  interactionId: string
  /**
   * 谁在问。**只有 `open` 有** —— 结算事件载的是答案,它身上根本没有这一格,
   * 而在这里补一个猜出来的值就是往账里写一句假话。后四相靠 `triggeredBy`
   * 指回 `open` 那一行,回查时两行一起读(这正是因果引用存在的理由)。
   */
  origin?: 'external-agent' | 'host-tool'
  /**
   * 几道题。同样**只有 `open` 有**。
   * **题干不入账** —— 保密纪律,而「几题」已经够回答「它在等多大一件事」。
   */
  questionCount?: number
  /** 提问所属的同事。会话不在任何一轮 v3 回合里时缺席。 */
  agentId?: string
  toolCallId?: string
}

export type CollabSchedulerLogRow =
  | CollabSchedulerPostedRow
  | CollabSchedulerHandRow
  | CollabSchedulerJudgeOpenRow
  | CollabSchedulerJudgeVerdictRow
  | CollabSchedulerJudgeDegradedRow
  | CollabSchedulerGrantRow
  | CollabSchedulerGateBlockRow
  | CollabSchedulerSpeakRow
  | CollabSchedulerYieldRow
  | CollabSchedulerRevokeRow
  | CollabSchedulerPhaseRow
  | CollabSchedulerWorkerSpawnRow
  | CollabSchedulerWorkerResultRow
  | CollabSchedulerDeadLetterRow
  | CollabSchedulerExternalTurnRow
  | CollabSchedulerExternalToolRow
  | CollabSchedulerInteractionRow

export type CollabSchedulerLogType = CollabSchedulerLogRow['type']

/** 行类型全表。解析器与 CLI 的 `--type` 过滤都读它。 */
export const COLLAB_SCHEDULER_LOG_TYPES = [
  'posted',
  'hand',
  'judge-open',
  'judge-verdict',
  'judge-degraded',
  'grant',
  'gate-block',
  'speak',
  'yield',
  'revoke',
  'phase',
  'worker-spawn',
  'worker-result',
  'dead-letter',
  'external-turn',
  'external-tool',
  'interaction',
] as const satisfies readonly CollabSchedulerLogType[]

/** 双向穷尽守卫,与 `COLLAB_ACTOR_VERB_TABLE_IS_EXHAUSTIVE` 同一套(C3 纪律)。 */
type LogTableMissing = Exclude<CollabSchedulerLogType, (typeof COLLAB_SCHEDULER_LOG_TYPES)[number]>
type LogTableStray = Exclude<(typeof COLLAB_SCHEDULER_LOG_TYPES)[number], CollabSchedulerLogType>
export const COLLAB_SCHEDULER_LOG_TABLE_IS_EXHAUSTIVE: [LogTableMissing] extends [never]
  ? [LogTableStray] extends [never]
    ? true
    : never
  : never = true

/**
 * **正文永不入账**的类型级门(蓝图 §7 保密纪律)。
 *
 * 联合上做分配式 `keyof`,与一张禁用字段名表求交。哪天有人往某一行上加
 * `content` / `summary` / `text`,这一行当场红 —— 而那种泄漏在测试里很难被看见
 * (账仍然写得出来、读得回来,只是多了一段不该在那儿的话)。
 */
type CollabSchedulerLogAllKeys<T> = T extends unknown ? keyof T : never
type CollabSchedulerForbiddenKey =
  | 'content'
  | 'text'
  | 'body'
  | 'message'
  | 'summary'
  | 'excerpt'
  | 'prompt'
  | 'persona'
  | 'transcript'
type CollabSchedulerLeakedKey = Extract<
  CollabSchedulerLogAllKeys<CollabSchedulerLogRow>,
  CollabSchedulerForbiddenKey
>
export const COLLAB_SCHEDULER_LOG_CARRIES_NO_TRANSCRIPT: [CollabSchedulerLeakedKey] extends [never]
  ? true
  : never = true

/**
 * 时间轴的写入口。**只写不读** —— 记账的那几个 actor 不回查自己的账。
 *
 * 定义在纯层是因为它是**契约**:房间、裁判、agent 三个产生点各自持有一个,而落盘
 * 那一份(`@onething/backend` 的 `wiring/collab/scheduler-log.ts`)只是它的一个实现。不配 = 不记账,
 * 那正是金重放与纯测试跑的那一档 —— 观测是旁路,有没有账本不该让同一份剧本跑出
 * 两个结果。
 */
export interface CollabSchedulerLogSink {
  append(roomId: string, row: CollabSchedulerLogRow): void
}

export function isCollabSchedulerLogType(value: unknown): value is CollabSchedulerLogType {
  return typeof value === 'string'
    && (COLLAB_SCHEDULER_LOG_TYPES as readonly string[]).includes(value)
}

/* ── 行构造 ───────────────────────────────────────────────────────────────── */

/**
 * 一族薄构造函数:`type` 由函数名钉死,其余按各自的行类型收。
 *
 * 为什么不让调用方直接写对象字面量:调用点散在三个 actor 里,而 `type` 写错一个
 * 字符只会让那一类行在 CLI 的 `--type` 过滤里查不到 —— 一个不报错的哑巴 bug。
 */
export function collabSchedulerPosted(
  input: Omit<CollabSchedulerPostedRow, 'type'>,
): CollabSchedulerPostedRow {
  return { ...input, type: 'posted' }
}

export function collabSchedulerHand(
  input: Omit<CollabSchedulerHandRow, 'type'>,
): CollabSchedulerHandRow {
  return { ...input, type: 'hand' }
}

export function collabSchedulerJudgeOpen(
  input: Omit<CollabSchedulerJudgeOpenRow, 'type'>,
): CollabSchedulerJudgeOpenRow {
  return { ...input, type: 'judge-open' }
}

export function collabSchedulerJudgeVerdict(
  input: Omit<CollabSchedulerJudgeVerdictRow, 'type'>,
): CollabSchedulerJudgeVerdictRow {
  return { ...input, type: 'judge-verdict' }
}

export function collabSchedulerJudgeDegraded(
  input: Omit<CollabSchedulerJudgeDegradedRow, 'type'>,
): CollabSchedulerJudgeDegradedRow {
  return { ...input, type: 'judge-degraded' }
}

export function collabSchedulerGrant(
  input: Omit<CollabSchedulerGrantRow, 'type'>,
): CollabSchedulerGrantRow {
  return { ...input, type: 'grant' }
}

export function collabSchedulerGateBlock(
  input: Omit<CollabSchedulerGateBlockRow, 'type'>,
): CollabSchedulerGateBlockRow {
  return { ...input, type: 'gate-block' }
}

export function collabSchedulerSpeak(
  input: Omit<CollabSchedulerSpeakRow, 'type'>,
): CollabSchedulerSpeakRow {
  return { ...input, type: 'speak' }
}

export function collabSchedulerYield(
  input: Omit<CollabSchedulerYieldRow, 'type'>,
): CollabSchedulerYieldRow {
  return { ...input, type: 'yield' }
}

export function collabSchedulerRevoke(
  input: Omit<CollabSchedulerRevokeRow, 'type'>,
): CollabSchedulerRevokeRow {
  return { ...input, type: 'revoke' }
}

export function collabSchedulerPhase(
  input: Omit<CollabSchedulerPhaseRow, 'type'>,
): CollabSchedulerPhaseRow {
  return { ...input, type: 'phase' }
}

export function collabSchedulerWorkerSpawn(
  input: Omit<CollabSchedulerWorkerSpawnRow, 'type'>,
): CollabSchedulerWorkerSpawnRow {
  return { ...input, type: 'worker-spawn' }
}

export function collabSchedulerWorkerResult(
  input: Omit<CollabSchedulerWorkerResultRow, 'type'>,
): CollabSchedulerWorkerResultRow {
  return { ...input, type: 'worker-result' }
}

export function collabSchedulerDeadLetter(
  input: Omit<CollabSchedulerDeadLetterRow, 'type'>,
): CollabSchedulerDeadLetterRow {
  return { ...input, type: 'dead-letter' }
}

export function collabSchedulerExternalTurn(
  input: Omit<CollabSchedulerExternalTurnRow, 'type'>,
): CollabSchedulerExternalTurnRow {
  return { ...input, type: 'external-turn' }
}

export function collabSchedulerExternalTool(
  input: Omit<CollabSchedulerExternalToolRow, 'type'>,
): CollabSchedulerExternalToolRow {
  return { ...input, type: 'external-tool' }
}

export function collabSchedulerInteraction(
  input: Omit<CollabSchedulerInteractionRow, 'type'>,
): CollabSchedulerInteractionRow {
  return { ...input, type: 'interaction' }
}

/** 错误 → 账上那一行。**只取首行**,长了截断 —— 堆栈归 crash-log。 */
export const COLLAB_SCHEDULER_ERROR_LINE_MAX = 200

export function collabSchedulerErrorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const first = text.split('\n', 1)[0]?.trim() ?? ''
  return first.length > COLLAB_SCHEDULER_ERROR_LINE_MAX
    ? `${first.slice(0, COLLAB_SCHEDULER_ERROR_LINE_MAX)}…`
    : first
}

/* ── JSONL 行级渲染与解析 ─────────────────────────────────────────────────── */

/**
 * 一行 JSONL。
 *
 * 键序**规范化**(`type` / `at` / `triggeredBy` 在前,其余按字母序):同一条行无论
 * 是哪个构造点写出来的,落盘的字节都一样。测试因此可以比字符串,而不是先 parse
 * 再比对象 —— 后者验不出「写出去的是不是稳定的」。
 */
export function formatCollabSchedulerLogLine(row: CollabSchedulerLogRow): string {
  const { type, at, triggeredBy, ...rest } = row as CollabSchedulerLogRow & Record<string, unknown>
  const ordered: Record<string, unknown> = { type, at }
  if (triggeredBy !== undefined) ordered.triggeredBy = triggeredBy
  for (const key of Object.keys(rest).sort()) {
    if (rest[key] !== undefined) ordered[key] = rest[key]
  }
  return JSON.stringify(ordered)
}

/**
 * 一行 → 行。认不出就是 `null`(**跳过,不抛**)。
 *
 * 只验两格:`type` 在表里、`at` 是数字。其余字段**故意宽松** —— 文件里躺的是历史
 * 数据,而枚举会变;为了一个新增的 yield 理由让整个昨天的账读不出来,是把诊断工具
 * 变成第二个故障源。
 */
export function parseCollabSchedulerLogLine(line: string): CollabSchedulerLogRow | null {
  const text = line.trim()
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as { type?: unknown; at?: unknown }
  if (!isCollabSchedulerLogType(record.type)) return null
  if (typeof record.at !== 'number' || !Number.isFinite(record.at)) return null
  return parsed as CollabSchedulerLogRow
}

/* ── 按日切文件 ───────────────────────────────────────────────────────────── */

export const COLLAB_SCHEDULER_LOG_FILE_PREFIX = 'scheduler-log-'
export const COLLAB_SCHEDULER_LOG_FILE_SUFFIX = '.jsonl'
/** 保留天数。与 usage 账本同款做法:按日切、启动清老、不引 DB。 */
export const COLLAB_SCHEDULER_LOG_RETENTION_DAYS = 14

const SCHEDULER_LOG_FILE_RE = /^scheduler-log-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

/** `YYYY-MM-DD`,**本地时区** —— 用户说的"今天"是本地的今天。 */
export function collabSchedulerLogDayKey(ts: number): string {
  const date = new Date(ts)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function collabSchedulerLogFileName(ts: number): string {
  return `${COLLAB_SCHEDULER_LOG_FILE_PREFIX}${collabSchedulerLogDayKey(ts)}${COLLAB_SCHEDULER_LOG_FILE_SUFFIX}`
}

/** 文件名 → 日期键。不是时间轴文件就是 `null`(目录里还躺着 room.json 与信箱)。 */
export function collabSchedulerLogFileDayKey(fileName: string): string | null {
  const match = SCHEDULER_LOG_FILE_RE.exec(fileName)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

/**
 * 这个文件该清了吗。
 *
 * 比的是**日期键的字符串**而不是时间戳差:`YYYY-MM-DD` 的字典序就是时间序,而
 * 时间戳差会在夏令时与跨月上出现"多留一天/少留一天"的偏差 —— 一个没人会去查、
 * 但会让"保留 14 天"这句话不成立的错。
 */
export function isCollabSchedulerLogExpired(
  fileName: string,
  now: number,
  retentionDays: number = COLLAB_SCHEDULER_LOG_RETENTION_DAYS,
): boolean {
  const dayKey = collabSchedulerLogFileDayKey(fileName)
  if (!dayKey) return false
  const cutoff = collabSchedulerLogDayKey(now - (retentionDays - 1) * 86_400_000)
  return dayKey < cutoff
}

/* ── 房间转换 → 行 ────────────────────────────────────────────────────────── */

/**
 * 撞闸闩锁:每 agent 记一格「上次报的是哪道闸」。
 *
 * 没有它,一间冻着的房里每来一条消息就重记一遍同样的「阿般卡在冻结上」,一天下来
 * 账里全是同一句话。**闩锁在闸变了或手没了的时候放开** —— 于是账上留下的是
 * 「换闸」这件事,那才是回查时要看的。
 */
export type CollabSchedulerBlockLatch = Map<string, CollabRoomHandBlock>

export interface CollabSchedulerRoomStepInput {
  /** 进来的那条动词。`bumpEpoch` / `sweepExpiredLeases` 这类无动词转换传 `undefined`。 */
  verb?: CollabActorVerb
  /** 转换**之前**的账 —— 「这一步真的改了什么」只有对比才知道。 */
  before: CollabRoomAccount
  /** 转换**之后**的账。 */
  after: CollabRoomAccount
  effects: CollabRoomEffects
  gates: CollabRoomGates
  at: number
  latch?: CollabSchedulerBlockLatch
}

/**
 * 一次房间转换 → 这一步该记的几行。**账本的单一产生点**(蓝图 §3.3「谁转换状态谁记账」)。
 *
 * 十一类房间行(posted/hand/judge-open/grant/gate-block/speak/yield/revoke/phase)全部
 * 在这一个函数里派生,一类一条规则。散在各个 `apply*` 里记的代价在 v2 已经付过:
 * 同一件事在两处各记一次(于是"刚才"里有重影),或者新加一条路径忘了记(于是账上
 * 有个洞,而洞是看不见的)。
 *
 * 裁决的答案(judge-verdict / judge-degraded)与工作卡(worker-spawn / worker-result)
 * 不在这里 —— 它们不是房间账的转换,产生点分别在 RefereeActor 与 AgentActor。
 */
export function deriveCollabSchedulerLogRows(
  input: CollabSchedulerRoomStepInput,
): CollabSchedulerLogRow[] {
  const { verb, before, after, effects, gates, at } = input
  const rows: CollabSchedulerLogRow[] = []
  const cause = collabSchedulerCauseId(verb)

  // ① 进来的那条动词说了什么。
  if (verb?.type === 'room:posted') {
    const message = verb.message
    rows.push(collabSchedulerPosted({
      at,
      ...(message.id ? { messageId: message.id } : {}),
      authorKind: verb.author.kind === 'agent' ? 'agent' : verb.author.kind === 'user' ? 'user' : 'system',
      ...(verb.author.kind === 'agent' ? { authorId: verb.author.id } : {}),
      ...(after.chainResetMessageId && after.chainResetMessageId === message.id
        ? { chainReset: true }
        : {}),
    }))
  }

  // 举手:**按 seq 判**这一步有没有真改账。已经持牌的人举手是空操作(账原样返回),
  // 记一行「他举手了」会让回查看见一个根本没发生的等待。
  if (verb?.type === 'agent:raise-hand' && after.seq !== before.seq) {
    const hand = after.hands.find(entry => entry.agentId === verb.agentId)
    rows.push(collabSchedulerHand({
      at,
      agentId: verb.agentId,
      reason: hand?.reason ?? 'self-elected',
      origin: hand?.origin ?? 'hand',
      ...(cause ? { triggeredBy: cause } : {}),
    }))
  }

  if (verb?.type === 'agent:speak' && !effects.refusal) {
    // 这一步写下的、署这个人名的那条消息。运营行(冻结/预算/链闸)也在
    // `effects.messages` 里,所以不能取最后一条。
    const spoken = effects.messages.find(message => message.agentId === verb.agentId)
    rows.push(collabSchedulerSpeak({
      at,
      agentId: verb.agentId,
      leaseId: verb.leaseId,
      ...(spoken?.id ? { messageId: spoken.id } : {}),
      triggeredBy: verb.leaseId,
    }))
  }

  if (verb?.type === 'agent:yield') {
    rows.push(collabSchedulerYield({
      at,
      agentId: verb.agentId,
      leaseId: verb.leaseId,
      ...(verb.reason ? { reason: verb.reason } : {}),
      triggeredBy: verb.leaseId,
    }))
  }

  // ② 这一步开出来的裁决窗。
  if (effects.judgment) {
    rows.push(collabSchedulerJudgeOpen({
      at,
      token: effects.judgment.token,
      candidates: effects.judgment.candidates.map(hand => hand.agentId),
      ...(effects.judgment.sourceMessageId ? { triggeredBy: effects.judgment.sourceMessageId } : {}),
    }))
  }

  // ③ 这一步发出去的牌。
  for (const lease of effects.granted) {
    rows.push(collabSchedulerGrant({
      at,
      agentId: lease.agentId,
      leaseId: lease.leaseId,
      reason: after.leaseReasons[lease.leaseId] ?? 'self-elected',
      ...(cause ? { triggeredBy: cause } : {}),
    }))
  }

  // ④ 这一步收回的牌 / 换的相 —— 两者都是**广播出去的动词**,而广播是它们唯一的
  //    产生点(换代、过期、让位结算、喊停四条路都汇到这里)。
  for (const broadcast of effects.broadcast) {
    if (broadcast.type === 'room:floor-revoked') {
      rows.push(collabSchedulerRevoke({
        at,
        agentId: broadcast.agentId,
        leaseId: broadcast.leaseId,
        cause: broadcast.reason,
        triggeredBy: broadcast.leaseId,
      }))
    } else if (broadcast.type === 'room:phase-changed') {
      rows.push(collabSchedulerPhase({
        at,
        name: broadcast.phase,
        ...(broadcast.previousPhase ? { previousPhase: broadcast.previousPhase } : {}),
        epoch: broadcast.epoch,
      }))
    }
  }

  // ⑤ 还举着的手卡在哪 —— 闩锁去重,只记「换闸」。
  rows.push(...deriveCollabSchedulerGateBlocks({ after, gates, at, ...(cause ? { cause } : {}), ...(input.latch ? { latch: input.latch } : {}) }))

  return rows
}

function deriveCollabSchedulerGateBlocks(input: {
  after: CollabRoomAccount
  gates: CollabRoomGates
  at: number
  cause?: string
  latch?: CollabSchedulerBlockLatch
}): CollabSchedulerGateBlockRow[] {
  const { after, gates, at, latch } = input
  const rows: CollabSchedulerGateBlockRow[] = []
  if (after.hands.length === 0) {
    latch?.clear()
    return rows
  }
  const gate = resolveCollabRoomHandBlock(after, gates)
  const live = new Set<string>()
  for (const hand of after.hands) {
    live.add(hand.agentId)
    if (latch?.get(hand.agentId) === gate) continue
    latch?.set(hand.agentId, gate)
    rows.push(collabSchedulerGateBlock({
      at,
      agentId: hand.agentId,
      gate,
      ...(input.cause ? { triggeredBy: input.cause } : {}),
    }))
  }
  // 手没了就放开闩:下次它再被同一道闸拦住,那是**新**的一次撞闸。
  if (latch) {
    for (const agentId of [...latch.keys()]) {
      if (!live.has(agentId)) latch.delete(agentId)
    }
  }
  return rows
}

/**
 * 这一步的**成因 id** —— 下游各行的 `triggeredBy`。
 *
 * 三条来路各有各的身份:一条消息(messageId)、一次举手(它自己的触发消息)、
 * 一份裁决(verdictToken)。这个函数是那三者到一个字段的唯一映射,回查时
 * 「这张牌是因为什么发的」因此永远指得回去。
 */
export function collabSchedulerCauseId(verb: CollabActorVerb | undefined): string | undefined {
  if (!verb) return undefined
  switch (verb.type) {
    case 'room:posted':
      return verb.message.id
    case 'agent:raise-hand':
      return verb.sourceMessageId
    case 'referee:set-floor-policy':
      return verb.params?.verdictToken
    case 'agent:speak':
    case 'agent:yield':
      return verb.leaseId
    default:
      return undefined
  }
}

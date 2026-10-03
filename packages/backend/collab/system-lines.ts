/**
 * Collab system lines — which machinery lines the MODEL is allowed to see
 * (docs/design/multi-agent-collab-im.md §4 W9.1).
 *
 * 事故背景(2026-07-28 真机):投影 skip 全部 system 消息 → 评审人看不到
 * 「开始执行 / 受阻」这些任务事实,只能听信执行者在群里的自述;执行者谎报
 * 「已交付」,评审人就把受阻卡关成 done。文件从未存在。
 *
 * 修复的形状:系统行分两类,靠**来源标记**区分,而不是靠文案猜。
 *  - 任务生命周期(`collab-task`)与成员变更(`collab-membership`,W6):
 *    这些是房间里发生过的**事实**,进模型投影,形态「系统: <文案>」。
 *  - 运营噪声(预算超限、排队、链闸、权限提醒…):只给人看,继续用
 *    COLLAB_MESSAGE_SOURCE,永不进投影——它们是机器的账,不是房间的事实。
 *
 * 判定收在 isCollabProjectedSystemLine 一个函数里(投影/意愿窗口/未来的
 * 成员变更行同源同规则),新增一类只需往 PROJECTED_SOURCES 里加一个来源。
 */
import type { CollabTaskEvidence } from './board.js'
import { truncateAtCodePoint } from './truncate.js'
import type { CollabAgentLike } from './types.js'

/**
 * The system-line markers and the "does the model read this?" predicate live in
 * `classify.ts` since R3 — one switch decides what a room message IS, and every
 * marker is read off `source`/`origin.source` in exactly one place. Re-exported
 * so every existing import site keeps working unchanged.
 */
export {
  COLLAB_PROJECTED_SYSTEM_SOURCES,
  COLLAB_SYSTEM_SOURCE_MEMBERSHIP,
  COLLAB_SYSTEM_SOURCE_TASK,
  isCollabProjectedSystemLine,
} from './classify.js'

/** Speaker label the projected line is signed with (IM-relay style, v3). */
export const COLLAB_SYSTEM_SPEAKER_LABEL = '系统'


/** `系统: <文案>` — the shape a projected system line takes in the transcript. */
export function formatCollabProjectedSystemLine(content: string): string {
  return `${COLLAB_SYSTEM_SPEAKER_LABEL}: ${content}`
}

// ---------------------------------------------------------------------------
// Membership changes (W6 / §3.5 C) — 群公告
//
// These are room FACTS, not machine bookkeeping: an agent that does not know
// who joined or left cannot address the room correctly (and a removed member
// silently vanishing reads as a bug). They therefore carry
// COLLAB_SYSTEM_SOURCE_MEMBERSHIP and reach the model, exactly like the task
// lifecycle lines.
// ---------------------------------------------------------------------------

/** `🔎 小研 加入了群聊` — the avatar is the member's identity mark, not decor. */
export function buildCollabMemberJoinedLine(member: { name: string; avatar?: string }): string {
  const mark = member.avatar ? `${member.avatar} ` : ''
  return `${mark}${member.name} 加入了群聊`
}

/** `小研 已被移出群聊` — passive, because the actor may be user or config sync. */
export function buildCollabMemberRemovedLine(member: { name: string }): string {
  return `${member.name} 已被移出群聊`
}

/** `阿明 成为群负责人`. */
export function buildCollabPmAssignedLine(member: { name: string }): string {
  return `${member.name} 成为群负责人`
}

/**
 * The room lost its PM. When the previous PM is the one who just left, the
 * removal line already named them — this line only states the resulting fact.
 */
export function buildCollabPmClearedLine(previous?: { name: string }): string {
  return previous ? `${previous.name} 不再是群负责人` : '群里暂时没有负责人'
}

export interface CollabMembershipChangeOptions {
  previousMemberIds: readonly string[]
  nextMemberIds: readonly string[]
  previousPmAgentId?: string
  nextPmAgentId?: string
  /** Identities for labelling; an unknown id falls back to the raw id. */
  agents?: readonly CollabAgentLike[]
}

/**
 * Diff two rosters into the announcement lines the room should read, in the
 * order a human would say them: who arrived, who left, then who is in charge.
 * Returns [] when nothing changed — a no-op save must not post a line.
 */
export function buildCollabMembershipLines(options: CollabMembershipChangeOptions): string[] {
  const label = (agentId: string): { name: string; avatar?: string } => {
    const agent = options.agents?.find(candidate => candidate.id === agentId)
    return { name: agent?.name || agentId, ...(agent?.avatar ? { avatar: agent.avatar } : {}) }
  }
  const previous = new Set(options.previousMemberIds)
  const next = new Set(options.nextMemberIds)
  const lines: string[] = []

  for (const agentId of options.nextMemberIds) {
    if (!previous.has(agentId)) lines.push(buildCollabMemberJoinedLine(label(agentId)))
  }
  for (const agentId of options.previousMemberIds) {
    if (!next.has(agentId)) lines.push(buildCollabMemberRemovedLine(label(agentId)))
  }

  const previousPm = options.previousPmAgentId || undefined
  const nextPm = options.nextPmAgentId || undefined
  if (nextPm !== previousPm) {
    if (nextPm) {
      lines.push(buildCollabPmAssignedLine(label(nextPm)))
    } else if (previousPm) {
      // Removed-and-demoted in one change: the removal line already named them.
      lines.push(buildCollabPmClearedLine(next.has(previousPm) ? label(previousPm) : undefined))
    }
  }
  return lines
}

/**
 * 链闸冻结行(collab-turn-protocol-and-identity.md C)。
 *
 * 群房与用户私聊里解冻的真源是**一条人类消息**,所以文案可以召唤用户。
 * agent ⇄ agent 的 pair 房里没有人类可召唤 —— 用户看得见那间房、能插话,但
 * 「你说一句话」在那里读起来像是对着空气喊。那一版说的是这间房真实的解冻条件:
 * 跨房 dm 注入(外部输入)会把链长清零,房内的乒乓继续被 6 条闸拦住。
 *
 * 一个函数而不是三份副本:贴这行文案的地方有三处(queue/plan-runner/turn 的
 * chainNoticePosted 闩锁),三份副本迟早会有一份先改。
 */
export function buildCollabChainHoldLine(options: {
  maxChain: number
  /** agent ⇄ agent 的双成员私聊房吗? */
  pairDm?: boolean
}): string {
  return options.pairDm
    ? `他们连着聊了 ${options.maxChain} 条,先按住了——有新话题进来会继续`
    : `他们连着聊了 ${options.maxChain} 条,我先按住了——你说一句话,讨论就继续`
}

/** Disposition instruction for a halted task — decide, do not review. */
export const COLLAB_TASK_HALTED_DISPOSITION =
  '请负责人决定下一步:重新指派、换人、改方案,或向用户说明——受阻的卡不能按已交付处理。'

/** How much of the block reason the transcript line carries (W9b.3). */
export const COLLAB_HALT_REASON_EXCERPT_CHARS = 80

/** One-line reason excerpt: collapsed whitespace, hard-capped, ellipsised. */
export function excerptCollabHaltReason(
  reason: string | undefined,
  maxChars = COLLAB_HALT_REASON_EXCERPT_CHARS,
): string {
  const flat = (reason ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > maxChars ? `${truncateAtCodePoint(flat, maxChars)}…` : flat
}

/**
 * The halted line (W9.2 + W9b.3). It states the fact FIRST (task not
 * delivered) and only then the disposition — the failure mode being fixed is a
 * reviewer that read a delivery report into a blocked card, so "任务未交付"
 * must be in the transcript the reviewer reads, not merely in the drive it
 * never sees. W9b.3 replaces the dangling "原因见看板任务卡" pointer with the
 * actual reason whenever one is knowable.
 */
export function buildCollabTaskHaltedLine(options: {
  title: string
  /** Who was executing it, when known. */
  assigneeName?: string
  /** Block reason (board `reason` arg, or the worker's fallback excerpt). */
  reason?: string
}): string {
  const who = options.assigneeName ? `${options.assigneeName} ` : ''
  const reason = excerptCollabHaltReason(options.reason)
  const cause = reason ? `原因: ${reason}` : '原因见看板任务卡'
  return `「${options.title}」受阻:${who}无法继续,任务未交付(${cause})。${COLLAB_TASK_HALTED_DISPOSITION}`
}

/**
 * The halt cap line (W9b.2): from COLLAB_MAX_HALTS on, the room stops
 * disposing of this card by itself — no PM activation, no auto re-execution.
 * States the count so the loop is visible as a loop, and hands the decision to
 * the user rather than pretending progress.
 */
export function buildCollabTaskHaltCapLine(options: {
  title: string
  haltedCount: number
  assigneeName?: string
  reason?: string
}): string {
  const who = options.assigneeName ? `${options.assigneeName} ` : ''
  const reason = excerptCollabHaltReason(options.reason)
  const cause = reason ? `(原因: ${reason})` : ''
  return `「${options.title}」第 ${options.haltedCount} 次受阻:${who}仍无法继续${cause}。`
    + '已停止自动处置(不再自动重派、不再叫负责人),等用户决定下一步。'
}

/**
 * 指派通知行(collab-team-v2 §3.2)。
 *
 * 指派曾经等于开工:`task-assigned` 直接 spawn 工作台,被指派的人在那一瞬间
 * 就有了一条正在跑的会话,没有提问的余地。官僚感就是从这儿来的 —— 派活的人
 * 只是"指了一下",系统却替被派的人做了"接了"的决定。
 *
 * 现在指派只是把话带到,开工是被指派者自己的动作。代价是多一个决策回合,
 * 换来的是 agent 可以先把需求问清楚再动手。
 */
export function buildCollabTaskAssignedLine(options: {
  title: string
  taskId: string
  assigneeName: string
  /** 打回/解阻重派时把原因带上 —— 不带原因的"再来一次"没法执行。 */
  reason?: string
}): string {
  const reason = excerptCollabHaltReason(options.reason)
  const why = reason ? `(此前受阻/被打回,原因: ${reason})` : ''
  return `「${options.title}」已指派给 ${options.assigneeName}${why}。`
    + `${options.assigneeName} 可以先在群里问清楚,确认后用 board 的 start 开工`
    + `(taskId: ${options.taskId.slice(0, 8)});做不了就 block 并说明原因。`
}

/**
 * 中断的收敛行(collab-team-v2 §5.2 / §5.4)。
 *
 * 中断 ≠ 受阻。受阻的语义是「需要人裁决」,而超时、被停、重启这三样都不是:
 * 卡本身没出问题,只是执行被打断了。此前它们全都落进 blocked,于是每一次
 * force-quit 都在给一张健康的卡贴「等你定夺」,看板上真正需要裁决的那几张
 * 被淹掉了。
 *
 * 所以中断一律收敛到 **todo(保留 assignee)** —— 有了 `board start` 之后,
 * 「有主的待办」天然就是可续做态,不需要第七种状态来表达它。行文里点名续做
 * 的人和动作,因为看板上一张 todo 卡不会自己告诉别人它是被打断的。
 */
export function buildCollabTaskInterruptedLine(options: {
  title: string
  assigneeName?: string
  /** 超时 / 被中止 / 执行出错 / 因重启中断 —— 一句话说清是谁打断的。 */
  cause: string
  /** 还有没有工作现场可续。没有(比如从没跑起来过)就不许诺现场。 */
  hasWorkSession?: boolean
}): string {
  const who = options.assigneeName ?? '负责这张卡的成员'
  const scene = options.hasWorkSession === false
    ? ''
    : '(此前的工作现场保留在原工作会话里,续做时接着往下做即可)'
  return `「${options.title}」${options.cause},已回到待办。${who} 可以用 board 的 start 续做${scene}。`
}

/** Auto re-execution refused because the card already hit the halt cap. */
export function buildCollabTaskRequeueRefusedLine(options: {
  title: string
  haltedCount: number
}): string {
  return `「${options.title}」已受阻 ${options.haltedCount} 次,自动重执行已停止 —— 这次重派没有派出任何执行,`
    + '需要用户点头(或用户自己把卡挪回 todo)才会再执行。'
}

/** `write×1, read×2` — deterministic order (count desc, then name). */
export function formatCollabTaskEvidence(evidence?: CollabTaskEvidence): string {
  const entries = Object.entries(evidence?.toolCounts ?? {}).filter(([, count]) => count > 0)
  if (entries.length === 0) return ''
  return entries
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}×${count}`)
    .join(', ')
}

/** No tool call ever ran for this card — the theatre tell (W9b.4). */
export const COLLAB_NO_EVIDENCE_TEXT = '无执行记录'

/**
 * Delivery line (W9b.4). The summary next to it is the executor's own words;
 * this line is the machine's: what the work session actually DID. Evidence is
 * counted from persisted tool calls, so a card closed by a member whose only
 * tool is `board` reads 无执行记录 no matter what its report claims.
 */
export function buildCollabTaskDeliveredLine(options: {
  title: string
  assigneeName?: string
  evidence?: CollabTaskEvidence
}): string {
  const who = options.assigneeName ? `${options.assigneeName} ` : ''
  const trace = formatCollabTaskEvidence(options.evidence)
  return trace
    ? `「${options.title}」${who}交付进入评审。执行记录: ${trace}`
    : `「${options.title}」${who}交付进入评审。${COLLAB_NO_EVIDENCE_TEXT}:该工作会话没有任何工具调用,交付内容未经实际执行。`
}

/** How much of a silent worker's own text the fallback line carries (W14b). */
export const COLLAB_SILENT_SUMMARY_EXCERPT_CHARS = 200

/**
 * Fallback for a worker that finished (or made progress) WITHOUT saying
 * anything in the room (W14b 交付自主化).
 *
 * 用户实锤:"交付像程序编排的 trigger,不是 agent 自主行为"。So the
 * coordinator no longer ghost-writes 「【交付】…」 under the worker's name —
 * delivery is the worker's own `say`. When it says nothing, the room still
 * needs to know the card moved, and this is that line: a SYSTEM line, signed
 * by nobody, carrying the report so the fact is not lost. The distinction is
 * the point — 冒名发言 is what was retired, not the information.
 */
export function buildCollabSilentDeliveryLine(options: {
  title: string
  assigneeName?: string
  /** The board report / last work text, excerpted. */
  summary?: string
  /** Progress (turn ended, card not completed) vs delivery (card in review). */
  kind?: 'delivery' | 'progress'
}): string {
  const who = options.assigneeName ? `${options.assigneeName} ` : ''
  const excerpt = excerptCollabHaltReason(options.summary, COLLAB_SILENT_SUMMARY_EXCERPT_CHARS)
  const head = options.kind === 'progress'
    ? `「${options.title}」本轮结束,${who}没有在群里说明,任务仍未标记完成`
    : `「${options.title}」${who}已标记交付,但没有在群里说明`
  return excerpt ? `${head}。工作会话最后的内容: ${excerpt}` : `${head}。`
}

/** Done line (W9b.4) — same evidence, stamped at the close of the card. */
export function buildCollabTaskDoneLine(options: {
  title: string
  evidence?: CollabTaskEvidence
}): string {
  const trace = formatCollabTaskEvidence(options.evidence)
  return trace
    ? `「${options.title}」已标记完成。执行记录: ${trace}`
    : `「${options.title}」已标记完成。${COLLAB_NO_EVIDENCE_TEXT}:这张卡没有任何工作会话执行痕迹,完成状态未经执行验证。`
}

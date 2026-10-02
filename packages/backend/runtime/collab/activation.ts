import { resolveCollabMentionIds } from './mentions.js'
import type { CollabAgentLike, CollabMentionLike } from './types.js'

/** Why an agent is about to speak. 'self-elected' = it passed its own
 *  response-willingness judgement (docs/design/multi-agent-collab-im.md §2);
 *  the old 'default-responder' path is gone — nobody answers by position. */
export type CollabActivationReason = 'mention' | 'self-elected' | 'task-event' | 'schedule' | 'relay'

export interface CollabActivationRequest {
  agentId: string
  reason: CollabActivationReason
}

/** Human-readable label stamped on the drive message of each reason. */
export const COLLAB_ACTIVATION_LABELS: Record<CollabActivationReason, string> = {
  mention: '被 @ 激活',
  'self-elected': '主动接话',
  'task-event': '任务事件',
  schedule: '定时触发',
  // 顺序模式(接力)。它是一条**对话性**激活,所以链长闸、floor 世代号作废、冻结
  // 门全部照常适用 —— 只有意愿判定被省掉了(轮到你了,不必再问你想不想说)。
  relay: '轮到发言',
}

/**
 * Effective chain cap for an activation reason:
 *  - 'task-event'  — exempt (Infinity). The work pipeline has its own bounds
 *    (per-task 打回 ≤2, concurrency caps) and freezing a review mid-delivery
 *    stalls real work (真机实测修订, predates W21).
 *  - 其余(主动接话 / 被 @ / 定时)—— 房间自己那一格,共用同一个数。
 *
 * W21 rule 2 曾给主动接话单开一道固定 4 条的更严闸(理由:agent 之间自顾自聊
 * 比被点名后回答更容易失控)。它现在撤掉了 —— 房间既然能把连续发言上限调成
 * 自己想要的数,再压一道调不动的暗闸,结果就是"我把上限调到 32,他们还是聊
 * 四条就停",而界面上没有任何东西解释为什么。一个可配置的闸,配置了就要算数。
 *
 * 想让主动接话更短,把这一格调小即可 —— 它对所有非任务事件的激活一视同仁。
 */
export function resolveCollabChainCap(
  reason: CollabActivationReason,
  maxChain: number,
): number {
  if (reason === 'task-event') return Number.POSITIVE_INFINITY
  return maxChain
}

/**
 * 链闸的**唯一判据**(2026-08-03 收敛,架构审查 A1)。
 *
 * 五处判定此前各写各的公式(驱动强制点、续排预筛、级联预筛、决策预筛、编排
 * 推进),其中编排那一处干脆绕过了 `resolveCollabChainCap`。公式只有一条:
 * 「已经说出口的 + 已经拿到发言权还没说的 < 这条激活的上限」。
 *
 * `occupied` 是并行化补上的那一半:`chainCount` 要到收尾(harvest)才 += 说了
 * 几句,所以同时起跑的 N 条回合读到的是**同一个**旧计数,各自都能过闸 ——
 * 一道设成 8 的闸会放过 8+N 条。已经过闸的每条按至少一句预占一格,闸的语义
 * (无人类输入时最多连着说几条)因此在并行下仍然成立。
 *
 * **预筛处不传它**:那些地方问的是"这次判定/这次续排还值不值得买",少算一格
 * 只会多买一次调用,而不会多说出一句话 —— 说不说得出口由强制点回答。
 *
 * 住在这里而不是 `chain.ts`:那个模块管的是"从转录里数出几条",这里管的是
 * "够不够格再说一条";两者共用的只有 `resolveCollabChainCap`,而把这个函数
 * 放进 chain.ts 会让 chain ⇄ activation 成环。
 */
export function collabChainGateAllows(input: {
  reason: CollabActivationReason
  chainCount: number
  maxChain: number
  /** 已经过闸、还没把自己那句算进 `chainCount` 的回合数。缺省 0(预筛)。 */
  occupied?: number
}): boolean {
  const cap = resolveCollabChainCap(input.reason, input.maxChain)
  return input.chainCount + (input.occupied ?? 0) < cap
}

/** A delivery landed on the board and the lead is being pulled in to review. */
export const COLLAB_DRIVE_LABEL_TASK_REVIEW = '任务交付待评审'
/**
 * A card was HALTED (worker could not continue). The lead is being pulled in
 * to DISPOSE of it, not to review a delivery — the 2026-07-28 incident is a
 * lead that reviewed a blocked card as if it had been delivered (W9.2).
 * The disposition itself travels in the projected system line
 * (buildCollabTaskHaltedLine): drives are excluded from the model projection,
 * so this label is transcript/audit signal only.
 */
export const COLLAB_DRIVE_LABEL_TASK_HALTED = '任务受阻待处置'
/**
 * A card was put on this member (collab-team-v2 §3.2). 指派 ≠ 开工:the drive
 * exists so the assignee can ask questions, start the work, or say it cannot —
 * not so a work session materialises under it. The card's content and the
 * "start when ready" wording travel in the projected system line
 * (buildCollabTaskAssignedLine); drives never enter the projection.
 */
export const COLLAB_DRIVE_LABEL_TASK_ASSIGNED = '任务已指派待开工'

/** The drive line's reason label, with an optional call-site override. */
export function formatCollabActivationLabel(
  reason: CollabActivationReason,
  override?: string,
): string {
  const trimmed = override?.trim()
  if (trimmed) return trimmed
  return COLLAB_ACTIVATION_LABELS[reason] ?? reason
}

export interface DecideCollabActivationsOptions {
  /** Who authored the message that landed in the room. */
  authorKind: 'user' | 'agent'
  authorAgentId?: string
  text: string
  /**
   * Identity-resolved mentions carried BY the message (W14a). When present
   * they decide alone — the ids were fixed when the message was authored, so
   * a rename cannot break the activation and 重名 cannot broaden it. Omit the
   * field (not `[]`) for messages that never carried one: that is what selects
   * the name-text fallback for pre-W14a transcripts.
   */
  mentions?: readonly CollabMentionLike[]
  /** Room members (the only agents that can be activated). */
  members: readonly CollabAgentLike[]
  /**
   * 单成员 dm 房的免判激活(agent-im-dm.md D6)。
   *
   * 一对一里"要不要接话"没有悬念,所以用户的每一句话**等价于 @ 了唯一那位
   * 成员**——这里就是这么实现的:合成一个 mention,于是下游一行不用改地继承
   * @ 的全部语义(reason 'mention'、满格链长闸、冻结时 blockedByFrozen 会说话)。
   * 省掉的只有意愿判定那次模型调用,一道闸都没省。
   *
   * 只对**用户**消息成立:agent 自己的 say 走 D3(双成员房,IM P3)。
   * 唯一成员已退休/查无此人时 `members` 是空的(调用方按在职过滤),于是这里
   * 合成不出任何 mention —— 死房的兜底由调用方贴系统行,不在这条纯规则里。
   */
  dmSoleMember?: boolean
  /**
   * 双成员 dm 房的免判激活(agent-im-dm.md D6 的另一半,IM P3)。
   *
   * 一对一里"要不要接话"同样没有悬念,只是这一次说话的是 agent:A 在私聊里
   * 开口,B 就是被说的那个人。手法与 `dmSoleMember` 一模一样——**合成一个
   * mention**,于是 reason 'mention'、满格链长闸、冻结播报、入队去重、驱动侧的
   * 退休/成员/预算门全都一行不改地继承。省掉的仍然只有意愿判定那次模型调用。
   *
   * 只对**agent** 的发言成立:用户在双成员房里插话是旁观者说话,不该强行把两个
   * 人同时拉起来,所以用户消息照走既有的 mention/意愿判定(§3.3 差异点 1)。
   * 防乒乓交给链长闸——双成员房默认收紧到 `COLLAB_DM_PAIR_MAX_CHAIN`。
   */
  dmPairPeer?: boolean
  /** Consecutive agent messages since the last human input (post-reset). */
  chainCount: number
  maxChain: number
  /** Room-wide pause switch. */
  frozen?: boolean
}

export interface DecideCollabActivationsResult {
  activations: CollabActivationRequest[]
  /** True when mentions existed but the chain cap swallowed them (§6.2: post the system line). */
  blockedByChain?: boolean
  /**
   * True when the room is frozen AND somebody was actually named (P2-17).
   *
   * A freeze that eats an @ silently is the worst shape this brake can take:
   * the user writes 「@小李 看一下」 into a room they paused an hour ago and
   * nothing happens at all — not an answer, not a refusal. The flag exists so
   * the coordinator can say so once. A frozen room with no mentions stays
   * silent, because there is nothing to be sorry about.
   */
  blockedByFrozen?: boolean
}

/**
 * 免判合成出来的那个 mention,或 undefined(不是 dm 房 / 形态对不上)。
 *
 * 两档人数各自要求作者身份对得上,少一条都不合成:单成员房只认用户开口,双成员
 * 房只认成员开口(而且作者必须真的是这间房的成员——否则"对面那位"无从谈起)。
 * 人数由调用方传进来的 `members` 决定,而 members 已经按在职过滤过,所以一位
 * 成员退休的双成员房在这里自动退化成"合成不出 mention",死路由调用方兜底。
 */
function resolveDmImplicitMentionId(
  options: DecideCollabActivationsOptions,
): string | undefined {
  if (options.dmSoleMember && options.authorKind === 'user' && options.members.length === 1) {
    return options.members[0].id
  }
  if (options.dmPairPeer && options.authorKind === 'agent' && options.members.length === 2) {
    const authorAgentId = options.authorAgentId
    if (!authorAgentId || !options.members.some(member => member.id === authorAgentId)) return undefined
    return options.members.find(member => member.id !== authorAgentId)?.id
  }
  return undefined
}

/**
 * The deterministic half of activation (D4): every agent utterance still needs
 * an explicit reason, but only the SHORT-CIRCUIT lives here — @ is the
 * strongest social signal and skips the judgement entirely. Everyone else is
 * decided by their own willingness call in the coordinator ('self-elected').
 *  - the author never activates itself
 *  - agent-authored messages activate nothing once the chain cap is reached
 *  - a frozen room activates nobody
 */
export function decideCollabActivations(
  options: DecideCollabActivationsOptions,
): DecideCollabActivationsResult {
  const memberIds = new Set(options.members.map(member => member.id))
  // D6 免判:dm 房里"这句话是说给谁听的"没有悬念,于是合成一个 mention 而不是
  // 另开一条激活路径 —— 冻结/链长/去重/驱动那一整条链因此继承同一套语义。
  //  - 单成员房:用户说话 = 点名唯一那位;
  //  - 双成员房:agent 说话 = 点名对面那位(用户插话不算,见 dmPairPeer 注释)。
  const implicitMentionId = resolveDmImplicitMentionId(options)

  if (options.frozen) {
    // P2-17: report the swallowed @ rather than just swallowing it. The same
    // membership filter as the live path, so a mention of somebody who is not
    // in the room does not make the room apologise for the freeze.
    const named = resolveCollabMentionIds(
      { content: options.text, ...(options.mentions ? { mentions: options.mentions } : {}) },
      options.members,
    ).filter(agentId => memberIds.has(agentId) && agentId !== options.authorAgentId)
    // 私聊里"没写 @"也是点名(D6),所以冻结的私聊房照样要开口说自己被按住了
    // ——否则用户在一间自己一小时前暂停掉的私聊里说话,得到的是纯粹的沉默。
    if (named.length === 0 && implicitMentionId) return { activations: [], blockedByFrozen: true }
    return named.length > 0
      ? { activations: [], blockedByFrozen: true }
      : { activations: [] }
  }

  // W14a: ids win, name text degrades. The membership filter still applies to
  // BOTH paths — a mention of someone who has since left the room activates
  // nobody, id or not.
  const resolved = resolveCollabMentionIds(
    { content: options.text, ...(options.mentions ? { mentions: options.mentions } : {}) },
    options.members,
  )
    .filter(agentId => memberIds.has(agentId))
    .filter(agentId => agentId !== options.authorAgentId)
  // 免判的那位并进来(去重):私聊里用户既可能真写了 @,也可能什么都没写,
  // 两种写法必须落成同一条激活,不能变成两条。
  const mentioned = implicitMentionId && !resolved.includes(implicitMentionId)
    ? [...resolved, implicitMentionId]
    : resolved

  // Only mentions are decided here, so this is the FULL cap by construction
  // (W21 tiering: self-election gates tighter, and it gates in the coordinator
  // where the willingness round is paid for). 走同一个判据函数,五处判定因此
  // 只有一条公式 —— 这里是**预筛**(不传 occupied):最终答案在驱动强制点。
  if (
    options.authorKind === 'agent'
    && !collabChainGateAllows({
      reason: 'mention',
      chainCount: options.chainCount,
      maxChain: options.maxChain,
    })
  ) {
    return { activations: [], blockedByChain: mentioned.length > 0 }
  }

  if (mentioned.length > 0) {
    return { activations: mentioned.map(agentId => ({ agentId, reason: 'mention' as const })) }
  }

  // No mention: nobody is activated by position. The coordinator asks the
  // remaining members whether they want to speak.
  return { activations: [] }
}

/**
 * Room header member strip — pure logic (W7,
 * docs/design/multi-agent-collab-im.md §3.5 C).
 *
 * The strip is the IM-side entry to membership: a row of chips, a ＋ that pulls
 * somebody in, a right-click that pushes somebody out or hands over the lead.
 * Every write goes through W6's existing room update (`collabApi.roomUpdate`), so the
 * only thing this module decides is WHAT the next roster should be — the
 * dialog does the same via room-settings-form. Kept DOM-free so the roster
 * arithmetic (unknown ids, the last-member floor, PM hand-over) is testable.
 */

import {
  isActiveAgent,
  isColleague,
  type AgentKind,
  type AgentStatus,
  type CollabAgentActivitySnapshot,
} from '@shared/ipc'
import { agentTombstoneLabel } from '@onething/runtime/agents/model'
import { AGENT_AVATAR_FALLBACK } from '@/components/common/agent-avatar'

/** The agent fields the strip reads; an AgentDefinition satisfies it. */
export interface RoomStripAgent {
  id: string
  name: string
  title?: string
  avatar?: string
  /** Media file name of the picture avatar; the chip prefers it over the emoji. */
  avatarImage?: string
  isDefault?: boolean
  /** 分类(agent-domain-model.md M2);缺省 colleague。 */
  kind?: AgentKind
  /** 生命周期(M3);缺省 active。 */
  status?: AgentStatus
}

/**
 * 墓碑的名字(域模型 M4):查无此人与已退休共用这一个词。
 *
 * 文案属主在 `@onething/runtime/agents/model`(架构审查 B8);这里保留具名常量
 * 是因为下面的 tooltip 要拿它**当判据**用(「名字就是墓碑词」= 名字不可考)。
 */
export const ROOM_MEMBER_TOMBSTONE_NAME = agentTombstoneLabel('ui')

export interface RoomMemberEntry {
  id: string
  name: string
  title?: string
  avatar: string
  avatarImage?: string
  isPm: boolean
  /**
   * 墓碑态(域模型 §3.2 / M4):**已退休** 或 **查无此人**。
   *
   * 两种情况在成员条上是同一件事 —— 这个名字还挂在房间的花名册里,但它不会再
   * 说话了,所以照旧显示(绝不静默丢弃,否则"把这个陈旧成员踢掉"就没了入口),
   * 只是灰显 + 「已注销」。区别只在有没有名字可显示:退休的还叫自己的名字。
   */
  isRetired: boolean
}

/** Chip fallback when an agent carries no emoji of its own. */
export const ROOM_MEMBER_FALLBACK_AVATAR = AGENT_AVATAR_FALLBACK

/** Tooltip text: 名字 · 职务 (the title is dropped when there is none). */
export function formatRoomMemberTooltip(entry: RoomMemberEntry): string {
  const parts = [entry.name]
  if (entry.title) parts.push(entry.title)
  if (entry.isPm) parts.push('负责人')
  // 墓碑上加一句 —— 「这个人还在花名册里,但已经注销了」比一个灰掉的名字更明白。
  // 查无此人时把 id 也带上:名字已经不可考,id 是唯一能对上号的东西。
  if (entry.isRetired) {
    parts.push(entry.name === ROOM_MEMBER_TOMBSTONE_NAME ? entry.id : ROOM_MEMBER_TOMBSTONE_NAME)
  }
  return parts.join(' · ')
}

/**
 * One chip per member, in roster order.
 *
 * 三态(域模型 §3.2 的成员条一行):在职 → 正常;已退休 → 名字照旧、灰显;
 * 查无此人 → 墓碑「已注销」。后两种共用 `isRetired`,因为在这一行上它们是同一
 * 件事:名字还挂在房间上,人不会再说话了。任何一种都照旧出一个 chip —— 藏起来
 * 就等于藏掉了"把这个陈旧成员踢出去"的唯一入口。
 */
export function buildRoomMemberEntries(options: {
  memberAgentIds: readonly string[]
  agents: readonly RoomStripAgent[]
  pmAgentId?: string
}): RoomMemberEntry[] {
  return options.memberAgentIds.map(id => {
    const agent = options.agents.find(candidate => candidate.id === id)
    return {
      id,
      name: agent?.name || ROOM_MEMBER_TOMBSTONE_NAME,
      title: agent?.title,
      avatar: agent?.avatar || ROOM_MEMBER_FALLBACK_AVATAR,
      avatarImage: agent?.avatarImage,
      isPm: Boolean(options.pmAgentId) && options.pmAgentId === id,
      isRetired: !agent || !isActiveAgent(agent),
    }
  })
}

/* ── 在场徽标:四态,读 agents 账(D8 观测体系 §4.4)────────────────────────
 *
 * 这四个格子替掉的是 C4 审查里那个「四口径」问题的**最后一块**:「谁在忙」从前是
 * 从看板的 doing 卡现算的 —— 一张卡躺在「在做」列里,这个人就被画成在忙,哪怕
 * TA 此刻一个字都没在写,甚至根本没有那间房的发言权。
 *
 * 现在判据只有一本账(collabBoard 的 `agents`),而且它说得出旧口径根本表达不了的
 * 那一格:**持牌等大脑**。
 *
 * 判据是**按人**而不是按房的,这是刻意的:一个大脑同一时刻至多在一间房里想
 * (v3 宪法),所以「TA 在生成」是一个关于这个人的事实,不是关于这间房的。真正
 * 有用的那半句「在**哪儿**」交给 tooltip —— 「TA 怎么不理我」的答案往往正是
 * 「TA 在别的房忙着」,而按房过滤会把这句话直接删掉。
 */

export type RoomMemberPresence = 'waiting' | 'generating' | 'holding' | 'working' | 'idle'

/** 两条等待链各自的一句话(与大脑面同一套措辞)。 */
const MEMBER_WAITING_TEXT: Readonly<Record<'interaction' | 'permission', string>> = {
  interaction: '等你回答',
  permission: '等你审批',
}

/**
 * 一位同事此刻的在场态。拿不到快照 = 空闲(「读不到」与「空闲」在徽标上是同一
 * 个样子:都不画,而人本来就该是空闲居多)。
 *
 * 次序即优先级:等人 > 在写字 > 拿着牌还没开始 > 在干活 > 闲着。
 *
 * **等人排在最前**(E6):它与「在生成」在真机上同时成立(大脑那一轮还开着),
 * 但只有它需要用户做点什么。把它压在下面,徽标就会一直说「生成中」—— 而那正是
 * F3 里没人去找那张卡的原因。
 */
export function resolveRoomMemberPresence(
  activity: CollabAgentActivitySnapshot | null | undefined,
): RoomMemberPresence {
  if (!activity) return 'idle'
  if (activity.waitingOn) return 'waiting'
  if (activity.mind.state === 'thinking') return 'generating'
  // 大脑循环那一格拿不到时退回牌上的登记簿标志(两者在真机上说的是同一件事)。
  if (activity.heldLeases.some(lease => lease.executing)) return 'generating'
  if (activity.heldLeases.length > 0) return 'holding'
  if (activity.workers.some(worker => worker.status === 'running')) return 'working'
  return 'idle'
}

/** 徽标的 tooltip 后缀。`resolveRoomName` 翻不出名字就退回 id。 */
export function formatRoomMemberPresence(
  activity: CollabAgentActivitySnapshot | null | undefined,
  resolveRoomName: (roomSessionId: string) => string,
): string {
  const presence = resolveRoomMemberPresence(activity)
  if (presence === 'idle' || !activity) return ''
  if (presence === 'waiting' && activity.waitingOn) {
    return MEMBER_WAITING_TEXT[activity.waitingOn.kind]
  }
  if (presence === 'generating') {
    const room = activity.mind.state === 'thinking'
      ? (resolveRoomName(activity.mind.roomSessionId) || activity.mind.roomSessionId)
      : ''
    return room ? `在「${room}」生成中` : '生成中'
  }
  if (presence === 'holding') return `持 ${activity.heldLeases.length} 张牌,等大脑`
  const running = activity.workers.filter(worker => worker.status === 'running').length
  return `在干活(${running} 张卡)`
}

/**
 * Who the ＋ can pull in: every agent that is not already a member. The blank
 * default persona is not a room role (same rule as the settings dialog).
 *
 * 这是一个**社交面**(域模型 M2/§3.2):只收在职的同事 —— service(radio-dj 等
 * 后台设施)与已退休的都不出现在这个 ＋ 里。
 */
export function buildAddableRoomAgents(options: {
  memberAgentIds: readonly string[]
  agents: readonly RoomStripAgent[]
}): RoomStripAgent[] {
  return options.agents.filter(agent =>
    !agent.isDefault
    && isColleague(agent)
    && isActiveAgent(agent)
    && !options.memberAgentIds.includes(agent.id))
}

/** Next roster after pulling somebody in. Idempotent. */
export function planRoomMemberAdd(
  memberAgentIds: readonly string[],
  agentId: string,
): string[] | null {
  if (!agentId || memberAgentIds.includes(agentId)) return null
  return [...memberAgentIds, agentId]
}

export interface RoomMemberRemovalPlan {
  memberAgentIds: string[]
  /** Sent only when the removal also vacates the lead seat. */
  pmAgentId?: null
}

/**
 * Next roster after pushing somebody out. Returns a reason instead of a plan
 * when the app layer would refuse it (a room needs at least one member) — the
 * caller surfaces that as a line of ink, never as a silent no-op.
 */
export function planRoomMemberRemoval(options: {
  memberAgentIds: readonly string[]
  pmAgentId?: string
  agentId: string
}): { plan: RoomMemberRemovalPlan } | { error: string } {
  if (!options.memberAgentIds.includes(options.agentId)) {
    return { error: 'TA 已经不在这个群里' }
  }
  if (options.memberAgentIds.length <= 1) {
    return { error: '房间至少需要一名成员' }
  }
  const memberAgentIds = options.memberAgentIds.filter(id => id !== options.agentId)
  return {
    plan: options.pmAgentId === options.agentId
      ? { memberAgentIds, pmAgentId: null }
      : { memberAgentIds },
  }
}

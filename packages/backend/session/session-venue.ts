/**
 * 会话的「场子」—— 这条会话是群房、执行会话、工作台还是普通对话(越层清零 A2,2026-10-04)。
 *
 * 这些判据问的全是会话记录上 `kind` / `collab` 两个字段的含义,字段在 session 的记录上,
 * 七个功能都要问,所以从协作搬到这里:场子类型、归一化与「挂不挂房」来自
 * `collab/collab-tool-surface.ts`,按会话取场子的三个函数来自 `collab/collab-venue.ts`,
 * `isCollabCoordinatorDrivenSession` 来自 `collab/collab-ingress.ts`。每个函数逐字搬,两条判据
 * 不合并:「认不出的一律算 chat」(含 work)与「coordinator-driven 只认 room|agent」(不含 work)。
 *
 * 「哪个协作工具在哪个场子成立」不在这里 —— 那是工具的事,留在 `collab/tools/collab-tool-surface.ts`。
 * 本文件只引兄弟文件,不引 session 入口(那会是一个入口环)。
 */
import { getSession } from './session-store.js'

// ---------------------------------------------------------------------------
// 场子(venue)—— 「这条会话是什么场合」,以及每个协作工具在哪些场合里成立
// ---------------------------------------------------------------------------

/**
 * 一条会话的**场子**。会话 `kind` 的同构改名,外加一件 kind 说不出的事:
 * 缺省(`undefined`)不是"未知",是**普通对话**。
 *
 * 这个区分正是 A3 那个洞的形状:网关(微信/Telegram)按远端身份建出来的会话
 * `kind` 为空、`agentId` 落成 `default`,而判据若写成「kind 不是 chat 就放行」,
 * 那条会话就从"普通对话"变成了"说不准,先放过" —— 陌生联系人一句话就能把用户
 * 和主助理的私聊全文拉走(collab-history-tool.ts 的门注释写的是同一件事)。所以归一化
 * 只有一个方向:**认不出的一律算 `chat`**。
 */
export type CollabVenue = 'room' | 'agent' | 'work' | 'chat'

/** 认得出的三个协作场子。写成数组是为了让归一化只有一处判据。 */
const COLLAB_VENUES: readonly CollabVenue[] = ['room', 'agent', 'work']

/**
 * 会话 kind → 场子。**判定只有这一处实现**(架构收敛 C3-6)。
 *
 * 此前 say/board/dm/history 四个工具各手写一遍这句 if,而四份手写的门只要有一份
 * 漏了就是一个静默的授权洞 —— 它们不会报错,只会多放一个人进来。
 */
export function resolveCollabVenue(kind?: string | null): CollabVenue {
  return COLLAB_VENUES.includes(kind as CollabVenue) ? (kind as CollabVenue) : 'chat'
}

/**
 * 「这个场子挂着一间房吗」—— work / agent 两个场子的会话在 `collab.roomSessionId`
 * 里指着它服务的那间房(work 是母房,agent 是这一轮在答的那间房,W18)。
 *
 * 抽出来是因为它也是**同一条 kind 判据的第五、第六份手写**(say-tool
 * `resolveSayContext`、dm-tool `resolveWakeRoom`),而它与上面那张门共享同一个
 * 前提:`room` 场子的房就是它自己,`chat` 场子根本没有房。
 */
export function collabVenueLinksRoom(venue: CollabVenue): boolean {
  return venue === 'work' || venue === 'agent'
}

/** 会话形状里门要用到的那一小块。传对象而不是 id,调用方多半已经取过会话了。 */
export interface CollabVenueSession {
  kind?: string | null
  collab?: { roomSessionId?: string } | null
}

/** 这条会话是什么场子。认不出的 kind 一律 `chat`(见产品层归一化注释)。 */
export function collabVenueOf(session: CollabVenueSession | null | undefined): CollabVenue {
  return resolveCollabVenue(session?.kind ?? undefined)
}

/** 同上,但从 store 取会话 —— 手上只有 id 的调用点用这个。 */
export function collabVenueOfSession(sessionId: string): CollabVenue {
  return collabVenueOf(getSession(sessionId) as CollabVenueSession | undefined)
}

/**
 * 这条会话挂着的那间房 —— work 的母房、agent 这一轮在答的那间房(W18),
 * 其余场子没有。`room` 场子**不**从这里出答案:它的房是它自己,那是调用点的
 * 事实,不是这个字段的事实。
 */
export function collabLinkedRoomSessionId(
  session: CollabVenueSession | null | undefined,
): string | undefined {
  if (!session) return undefined
  if (!collabVenueLinksRoom(collabVenueOf(session))) return undefined
  return session.collab?.roomSessionId
}

/**
 * The sessions only the coordinator may stream: the room itself (pre-W18 shape,
 * and still where a legacy drive would land) and an agent's execution session,
 * which is where every room turn has run since W18. Both are surfaces the
 * coordinator owns end to end — anyone else driving one produces a turn with
 * the wrong persona, no mention resolution, and none of the three gates.
 */
export function isCollabCoordinatorDrivenSession(sessionId: string): boolean {
  const kind = getSession(sessionId)?.kind
  return kind === 'room' || kind === 'agent'
}

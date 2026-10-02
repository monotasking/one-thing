/**
 * 在场面(Presence)—— 四面模型里唯一不落库的那一面
 * (M1/M6,docs/design/agent-domain-model.md §2 §5)。
 *
 * 身份/心智/能力三面是 agents.json 里的字段;"这个 agent 现在在哪些房间、有哪
 * 些执行会话、干着哪些活"没有任何字段,它**永远现算**——落库就会有两份真相,
 * 而这一面的真相全在会话索引里(`memberAgentIds` / `session.agentId` /
 * `collab.roomSessionId`)。
 *
 * 本文件是纯函数:吃一个会话元数据数组,吐 presence。app 层的
 * `app/agents/presence.ts` 负责去 store 取数组,renderer 将来从 sessionsStore
 * 现算时喂同一个函数 —— 两处口径靠"共用这一份实现"收敛,而不是靠两边各写一遍
 * 再靠人盯。
 *
 * 归属一律读结构化字段,绝不反解 id(纪律见 identity.ts 头注释)。唯一用到
 * id 的地方是把 `userDmRoomId(agentId)` 算出来与会话 id **相等比对** —— 那是
 * 把派生 id 当幂等键用,不是从 id 里抠 agentId。
 */
import { userDmRoomId } from './identity.js'

/**
 * presence 推导要读的会话字段 —— 一个 `SessionMeta`(shared 包的 chat 契约文件)
 * 或 renderer 的 session 索引条目都结构上满足它。
 *
 * 刻意在本层自己声明而不 import 那个类型:产品层不许碰 shared 的 IPC 契约层
 * (boundary checker 强制,连注释里出现那条路径都算越界),而这里要的本来就是
 * 一个「最小结构类型」——声明清楚要读哪几个字段,反而比拖进一个 30 字段的
 * 会话元数据类型更能说明这条规则依赖什么。
 *
 * `room.dm` 自 IM P1 起真的会落库(agent-im-dm.md D1),但仍声明为可选:标记之前
 * 建的房没有这个字段,所以下面那条"或者 id 恰是幂等键"的兜底继续为历史数据服务。
 */
export interface AgentPresenceSessionLike {
  id: string
  kind?: string
  agentId?: string
  collab?: { roomSessionId?: string; taskId?: string } | null
  room?: { memberAgentIds?: string[]; dm?: boolean } | null
}

/** 一个 agent 此刻的在场情况。四路都是会话 id,顺序保持输入顺序(排序归调用方)。 */
export interface AgentPresence {
  /** 用户与它的托管私聊房;还没建过就是 null。 */
  dmRoomId: string | null
  /** 它作为成员在的房间(不含上面那间 dm 房;agent 互聊房算在这里)。 */
  roomSessionIds: string[]
  /** 它的常驻执行会话(每群一条)。 */
  execSessionIds: string[]
  /** 它正在/曾经执行的工作台会话。 */
  workSessionIds: string[]
}

function pushUnique(list: string[], id: string): void {
  if (id && !list.includes(id)) list.push(id)
}

/**
 * 从会话元数据里现算一个 agent 的在场面。
 *
 * 分类规则(全部读结构化字段):
 *  - `kind='room'` 且 `memberAgentIds` 含它 → 房间;其中"成员恰好只有它自己"
 *    且(带 `room.dm` 标记 或 id 恰好是 `userDmRoomId(agentId)` 这个幂等键)
 *    的那间,是用户与它的托管私聊房,单独占 `dmRoomId` 一栏而不再计入房间数;
 *  - `kind='agent'` 且 `session.agentId` 是它 → 执行会话;
 *  - `kind='work'` 且 `session.agentId` 是它 → 工作台会话。
 *
 * 空 agentId 直接返回全空(未知 agent 不该"匹配到"任何东西)。
 */
export function computeAgentPresence(
  agentId: string | undefined | null,
  sessions: readonly AgentPresenceSessionLike[] | undefined | null,
): AgentPresence {
  const presence: AgentPresence = {
    dmRoomId: null,
    roomSessionIds: [],
    execSessionIds: [],
    workSessionIds: [],
  }
  const target = typeof agentId === 'string' ? agentId.trim() : ''
  if (!target || !sessions?.length) return presence

  const dmKey = userDmRoomId(target)

  for (const session of sessions) {
    if (!session?.id) continue
    switch (session.kind) {
      case 'room': {
        const members = session.room?.memberAgentIds ?? []
        if (!members.includes(target)) break
        const soleMember = members.length === 1
        const isUserDm = soleMember && (session.room?.dm === true || session.id === dmKey)
        if (isUserDm && !presence.dmRoomId) {
          presence.dmRoomId = session.id
          break
        }
        pushUnique(presence.roomSessionIds, session.id)
        break
      }
      case 'agent': {
        if (session.agentId === target) pushUnique(presence.execSessionIds, session.id)
        break
      }
      case 'work': {
        if (session.agentId === target) pushUnique(presence.workSessionIds, session.id)
        break
      }
      default:
        break
    }
  }

  return presence
}

/**
 * 四路全空 = 这个 agent 在场面上没有任何痕迹。
 *
 * 注意这**不等于**「从未被引用过」:在场面是履历的四栏(dm 房/房间/执行会话/
 * 工作台),按定义不认 `kind='chat'` 的直聊会话——而一条直聊会话的 `agentId`
 * 正是它的 persona 绑定,那也是一处引用。硬删判定请用 `hasAgentReference`。
 */
export function isEmptyAgentPresence(presence: AgentPresence): boolean {
  return !presence.dmRoomId
    && presence.roomSessionIds.length === 0
    && presence.execSessionIds.length === 0
    && presence.workSessionIds.length === 0
}

/**
 * 引用判定要读的会话形状:在场面那几个字段全可选 —— 调用方(server 的会话
 * 摘要)可能只递得出 `agentId`,而少一个字段只该让判定更保守,不该让它炸。
 */
export interface AgentReferenceSessionLike extends Partial<AgentPresenceSessionLike> {
  agentId?: string
}

/**
 * 这个 agent 被任何会话引用过吗?—— A2「硬删 vs 退休」的判定(§3.2)。
 *
 * 引用 = 在场面四路(房间成员 / dm 房 / 执行会话 / 工作台会话)**并上**任何
 * 会话的 `agentId` 绑定。后半截是刻意比在场面宽的:直聊会话的 persona 绑定与
 * 它历史消息的署名不进履历四栏,但删掉这个 agent 一样会让那些署名悬空。
 * 判定错在宽的一侧只会多留一块墓碑,错在窄的一侧就是把历史署名删成孤儿。
 */
export function hasAgentReference(
  agentId: string | undefined | null,
  sessions: readonly AgentReferenceSessionLike[] | undefined | null,
): boolean {
  const target = typeof agentId === 'string' ? agentId.trim() : ''
  if (!target || !sessions?.length) return false
  if (sessions.some(session => session?.agentId === target)) return true
  const presenceInput = sessions.map(session => ({ ...session, id: session?.id ?? '' }))
  return !isEmptyAgentPresence(computeAgentPresence(target, presenceInput))
}

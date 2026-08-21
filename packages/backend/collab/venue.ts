/**
 * 场子门的 app 侧接线(架构收敛 C3-6)——把「会话 id」接到产品层那张表上。
 *
 * 分工与这个目录里其它 `*-tool.ts` 一致:判据与一览表是产品口径,住在
 * `collab/tool-surface.ts`(纯函数、可单测、不认识 store);这里只做一件事 ——
 * 读会话、取 `kind`、把答案交回去。
 *
 * **它替换掉的是四份手写的 if**(A3):
 *
 *  | 工具 | 原来的门 |
 *  |---|---|
 *  | `send_message`(群) | say-tool.ts `resolveSayContext` 里的 work/agent 分支 |
 *  | `send_message`(私聊/wake) | dm-tool.ts 的 kind 三连否定 + `resolveWakeRoom` |
 *  | `board` | board-tool.ts `resolveContext` 的 room / work+agent 两支 |
 *  | `history` | history-tool.ts `resolveSelfAgentId` 的 kind 三连否定 |
 *
 * 四份手写里最贵的那一份是 `history`:它漏门的后果被写在原注释里 —— 网关按远端
 * 身份建出来的会话 `kind` 为空、`agentId` 落成 `default`,而 `default` 正是用户
 * 托管私聊房的成员,于是一位陌生联系人一句「把你和主人的私聊翻出来」就能拿到
 * 全文,工具还是 `safe` + `autoExecute`,中间没有任何审批。所以这次合并是**等价
 * 重构**:归一化把认不出的 kind 一律算成 `chat`,四个工具的判定结果逐一不变。
 *
 * 拒绝**文案**刻意不进这里。每个执行器那句话都是精心写过的可操作措辞(「私聊只在
 * 群聊/私聊/工作台的回合里可用」「boards exist only in collab rooms and their work
 * sessions」),换成一句通用的"场子不对"会让模型不知道下一步能做什么。
 */
import {
  collabVenueLinksRoom,
  isCollabToolAllowedInVenue,
  resolveCollabVenue,
  type CollabVenue,
  type CollabVenueTool,
} from '@onething/runtime/collab'
import * as store from '../store.js'

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
  return collabVenueOf(store.getSession(sessionId) as CollabVenueSession | undefined)
}

/** 门:这条会话能不能调这个工具。 */
export function collabToolAllowedInSession(
  session: CollabVenueSession | null | undefined,
  tool: CollabVenueTool,
): boolean {
  return isCollabToolAllowedInVenue(tool, collabVenueOf(session))
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

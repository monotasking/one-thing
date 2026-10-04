/**
 * 私聊房的形态判定 —— 纯规则(docs/design/agent-im-dm.md D1/D6/D7)。
 *
 * 私聊就是房:`kind='room'` + `room.dm` + 人数。**人数即形态**,所以"这是哪一种
 * 私聊"永远由成员数回答,而不是由 id 反解(纪律见 agents/identity.ts 头注释):
 *
 *  - 单成员 → 用户 ↔ agent 的托管式私聊。免判激活(D6)、union 工具面(D7)、
 *    dm 版情况说明,三处都读这一个判定;
 *  - 双成员 → agent ↔ agent 私聊(D3),IM P3 才接线。本期它只是"不是单成员房",
 *    于是所有单成员分支自动不认它,群房语义原样适用。
 *
 * 收在一个函数里的动机是"三处读同一个答案":任何一处自己写
 * `room.dm && members.length === 1`,下一次形态变化(比如三人 dm)就会漏改一处。
 */

/** 判定要读的房间配置字段 —— 最小结构类型(产品层不碰 shared 的 IPC 契约)。 */
export interface CollabDmRoomLike {
  dm?: boolean
  memberAgentIds?: readonly string[]
}

/**
 * 这是用户 ↔ agent 的托管式私聊房吗?(带 dm 标记的**单成员**房。)
 *
 * 刻意**不**接受"没有标记但 id 恰好是幂等键"的房:标记是本期落库的事实,而
 * `presence.ts` 那处的 id 兜底是为了读历史数据(标记落库前建的房不存在)。
 * 引擎侧的行为分支(免判、工具面、提示词)只认写进去的事实。
 */
export function isUserDmRoom(room: CollabDmRoomLike | null | undefined): boolean {
  return room?.dm === true && (room.memberAgentIds?.length ?? 0) === 1
}

/** 这是 agent ↔ agent 私聊房吗?(带 dm 标记的双成员房。IM P3 才有消费方。) */
export function isAgentPairDmRoom(room: CollabDmRoomLike | null | undefined): boolean {
  return room?.dm === true && (room.memberAgentIds?.length ?? 0) === 2
}

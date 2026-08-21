/**
 * 用户 ↔ agent 的托管式私聊房(agent-im-dm.md D1/§2.1)。
 *
 * 「私聊就是房」是本方案的结构决定:`kind='room'` + `room.dm` + 单成员。选 room
 * 而不是普通 chat 会话,是因为「说话走 say、干活在幕后」的整套机制只长在 room 上
 * ——ingress 门、per-room 执行会话、看板、断路器、墙钟、冻结、boot 对账、停止/
 * 恢复,一件都不用重造。chat 会话形态做不到"工作内容不进对话"。
 *
 * 手法与 `agent-session.ts` 同构:derive id → get → create(不动 current-session
 * 指针)。区别只有两条,都是刻意的:
 *  - **不 archived**:执行会话是基础设施(藏),私聊是台面上的对话(不藏);
 *  - **房名 = agent 名字**,不加任何前缀——它就是"和小李的对话"。
 */
import { isActiveAgent } from '@shared/ipc.js'
import { isColleague, userDmRoomId } from '@onething/runtime/agents'
import * as store from '../../store.js'
import { findAgent } from '../agents/index.js'
import { emitCollabRoomUpdated } from './room-runtime.js'

/**
 * Get(或惰性创建)某个 agent 的托管私聊房,返回房间会话 id。
 *
 * 幂等由构造保证:id 从 agentId 派生(`userDmRoomId`,A3 唯一属主——这里绝不
 * 自己拼字面量),所以 "ensure" 就是一次读加最多一次建,不需要任何映射表。
 *
 * 三道校验,不满足一律返回 null(**不开房**):
 *  - `findAgent` 严格解析:查无此人不给房(A1 纪律,绝不 default 冒充);
 *  - `isColleague`:service agent(电台 DJ 之类)不是同事,不该有私聊;
 *  - `isActiveAgent`:退休的人只留墓碑与历史,不新开一间空房。
 *
 * 已经建过的房则**只补名字**:agent 改名后房名跟随。同步点选在 ensure(用户
 * 点开联系人的那一刻),取舍是"改名后不点开就还是旧名字"——代价是列表里可能
 * 短暂显示旧名,收益是不需要在 agent 改名链路上挂一个跨模块的 rooms 遍历。
 * 房名本来就只是显示层的东西,归属永远读 `memberAgentIds`。
 */
export function ensureUserDmRoom(agentId: string): string | null {
  const roomSessionId = userDmRoomId(agentId)
  if (!roomSessionId) return null
  const agent = findAgent(agentId)
  if (!agent || !isColleague(agent) || !isActiveAgent(agent)) return null

  const existing = store.getSession(roomSessionId)
  if (!existing) {
    // 建房这件事本身不该切换用户在看的东西 —— 指针纪律收在 store 那一侧
    // (stores/sessions.ts 的 createSessionWithoutFocus)。
    store.createSessionWithoutFocus(roomSessionId, agent.name)
  }

  const session = store.getSession(roomSessionId)
  if (!session) return null

  // 形态:单成员 + dm 标记。members 与标记一起写,于是"人数即形态"这条约定
  // (D1/D3)在数据落库的那一刻就成立。
  const memberAgentIds = session.room?.memberAgentIds ?? []
  const shapeOk = session.kind === 'room'
    && session.room?.dm === true
    && memberAgentIds.length === 1
    && memberAgentIds[0] === agentId
  if (!shapeOk) {
    // 这条修复分支会把名册**改写**成单成员,所以它和协调器的移人路径是同一件事,
    // 必须留同一款痕:被挤掉的人记进 `formerMembers`(collab-history-search.md §3)。
    // 不记的话 `collabRoomVisibleUntil` 对他返回 undefined —— 那不是"看不到内容",
    // 是"这间房从不存在",他当时确实读过的那段历史会被判成越权。
    const displaced = memberAgentIds.filter(id => id !== agentId)
    const removedAt = Date.now()
    store.updateSessionCollab(roomSessionId, {
      kind: 'room',
      room: {
        ...(session.room ?? {}),
        memberAgentIds: [agentId],
        dm: true,
        ...(displaced.length > 0
          ? {
              formerMembers: [
                ...(session.room?.formerMembers ?? []),
                ...displaced.map(id => ({ agentId: id, removedAt })),
              ],
            }
          : {}),
      },
    })
    // 名册被改写过 —— 播一份房间快照,会话表上那一格(成员、dm 标记)当场跟上,
    // 而不是等某个调用方想起来全量重拉(架构收敛 C4 §3)。
    emitCollabRoomUpdated(roomSessionId)
  }
  if (session.agentId !== agentId) store.updateSessionAgent(roomSessionId, agentId)
  if (agent.name && session.name !== agent.name) store.renameSession(roomSessionId, agent.name)

  return roomSessionId
}

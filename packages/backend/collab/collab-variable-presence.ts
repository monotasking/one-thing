/**
 * agent 自我状态的在场块(`my_cards` / `my_rooms` / `my_dms`),由协作提供给变量系统
 * (越层清零 A4,2026-10-04 从 `variable/variable-gateways.ts` 的 `agentSelfGateway` 逐字搬来)。
 *
 * 全部现算,零新增存储:在场面从会话索引推(agent 的 `computeAgentPresence` 纯函数),卡从各房看板
 * 读。与「在场面永不落库」那条铁律同源 —— 落一份库就有两份真相。变量系统只登记表里读这一格
 * (`registerAgentPresenceSource`),装配期 `configureAppRuntimeAdapters()` 登记一次。
 */
import * as store from '@onething/backend/session'
import { isAgentPairDmRoom } from '@onething/backend/session'
import { computeAgentPresence, findAgent } from '@onething/backend/agent'
import {
  registerAgentPresenceSource,
  type AgentSelfCardFact,
  type AgentSelfChatFact,
  type AgentSelfStateFacts,
} from '@onething/backend/variable'
import { getCollabSelfTaskFacts } from './collab-board-store.js'
import { resolveUserIdentity } from './collab-user-identity.js'

/** 一个 agent(在这条会话上)此刻的卡 / 房 / 私聊。 */
export function collabAgentPresenceFacts(_sessionId: string, agentId: string): AgentSelfStateFacts {
  // 会话索引只取一次:presence 与房名/时间/形态判定共用同一份快照,免得
  // 一个变量组遍历三遍索引。
  const sessions = store.getSessionsList()
  const presence = computeAgentPresence(agentId, sessions)
  const byId = new Map(sessions.map(meta => [meta.id, meta]))

  const cards: AgentSelfCardFact[] = []
  const rooms: AgentSelfChatFact[] = []
  const dms: AgentSelfChatFact[] = []

  if (presence.dmRoomId) {
    const meta = byId.get(presence.dmRoomId)
    dms.push({ name: resolveUserIdentity().label, lastActiveAt: meta?.updatedAt })
  }

  // 一个房一次 board.json 读取(小文件,同步)。此前 `<your_cards>` 是一次;
  // 现在是"这个 agent 在的房"的条数 —— 在场面本来就是它的活动半径,而卡只
  // 可能挂在这些房的板上。
  for (const roomId of [...(presence.dmRoomId ? [presence.dmRoomId] : []), ...presence.roomSessionIds]) {
    for (const fact of getCollabSelfTaskFacts(roomId, agentId)) {
      cards.push({ id: fact.id, title: fact.title, status: fact.status })
    }
  }

  for (const roomId of presence.roomSessionIds) {
    const meta = byId.get(roomId)
    if (!meta) continue
    // 双成员 dm 房在 presence 里算"房"(它确实是 kind='room'),但对 agent
    // 而言那是私聊 —— 归到 my_dms,并且写对面那个人而不是房名。
    if (isAgentPairDmRoom(meta.room)) {
      const peerId = meta.room?.memberAgentIds?.find(id => id !== agentId)
      const peerName = peerId ? findAgent(peerId)?.name : undefined
      dms.push({ name: peerName || '另一位同事', lastActiveAt: meta.updatedAt })
      continue
    }
    rooms.push({ name: meta.name, lastActiveAt: meta.updatedAt })
  }

  return { cards, rooms, dms }
}

export function registerCollabAgentPresence(): void {
  registerAgentPresenceSource(collabAgentPresenceFacts)
}

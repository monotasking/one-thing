/**
 * agent ↔ agent 的私聊房(双成员 dm 房,agent-im-dm.md D3/§3.1)。
 *
 * 与 `user-dm-room.ts` 同构,连取舍都同款 —— 两者是同一个 `kind='room'` +
 * `room.dm` 机制的两个人数档,**人数即形态**。选房而不是另造一条 session 间的
 * 直邮通道,理由写在 D3 里:直邮 = 零围栏裸奔,而房子上现成挂着 ingress 门、
 * per-room 执行会话、看板、断路器、墙钟、冻结、boot 对账、停止/恢复一整套。
 *
 * 与单成员房的三点差异,都是形态带来的:
 *  - 成员两位,**字典序**存放(id 也是字典序派生的,两者同源同序);
 *  - 房名是「A ⇄ B」,现算,ensure 时跟随改名;
 *  - 没有 pmAgentId —— 两个人的房间没有"负责人"这件事。
 *
 * 不 archived:它是台面上的对话(D4 透明制,用户可旁观可插话),不是执行会话
 * 那种基础设施。
 */
import { isActiveAgent } from '@shared/ipc.js'
import { agentDmRoomId, isColleague } from '@onething/runtime/agents'
import * as store from '../../store.js'
import { findAgent } from '../agents/index.js'

/** 房名分隔符。「⇄」而不是「/」或「&」:一眼看出这是双向的一对一。 */
const PAIR_NAME_SEPARATOR = ' ⇄ '

/**
 * Get(或惰性创建)两个 agent 之间的私聊房,返回房间会话 id。
 *
 * 幂等由构造保证:id 由 `agentDmRoomId` 从两个 agentId 字典序派生(A3 唯一属主
 * ——这里绝不自己拼字面量),所以"同一对 agent 无论谁发起都落在同一间房"是
 * 算出来的,不是靠映射表维护出来的。自己和自己没有私聊房(`agentDmRoomId` 返回
 * null),空 id 同理。
 *
 * 校验对**两侧**各做三道,任何一侧不满足一律返回 null(**不开房**):
 *  - `findAgent` 严格解析:查无此人不给房(A1 纪律,绝不 default 冒充);
 *  - `isColleague`:service agent(电台 DJ 之类)不是同事,不参与社交面;
 *  - `isActiveAgent`:退休的人只留墓碑与历史,不新开一间空房。
 *
 * 已经建过的房则**只补名字**:任一方改名后房名跟随。同步点选在 ensure(有人
 * 发起 dm 的那一刻),取舍与单成员房一字不差 —— 代价是"改名后没人再 dm 过就
 * 还是旧名字",收益是不必在 agent 改名链路上挂一个跨模块的 rooms 遍历。房名
 * 本来就只是显示层的东西,归属永远读 `memberAgentIds`。
 */
export function ensureAgentDmRoom(agentIdA: string, agentIdB: string): string | null {
  const roomSessionId = agentDmRoomId(agentIdA, agentIdB)
  if (!roomSessionId) return null

  // 成员按字典序落库,与 id 的派生顺序同源:两处各排一次而不是互相推导,是因为
  // id 一侧禁止反解(agents/identity.ts 纪律),而同一个比较函数在两边都是一行。
  const [firstId, secondId] = [agentIdA.trim(), agentIdB.trim()].sort()
  const first = findAgent(firstId)
  const second = findAgent(secondId)
  for (const agent of [first, second]) {
    if (!agent || !isColleague(agent) || !isActiveAgent(agent)) return null
  }
  const memberAgentIds = [firstId, secondId]
  const roomName = `${first!.name}${PAIR_NAME_SEPARATOR}${second!.name}`

  const existing = store.getSession(roomSessionId)
  if (!existing) {
    // 建房的发起者是一个 agent 的回合,把用户正在看的标签页抢走完全说不通 ——
    // 所以走不动指针的那个变体(指针纪律见 stores/sessions.ts)。
    store.createSessionWithoutFocus(roomSessionId, roomName)
  }

  const session = store.getSession(roomSessionId)
  if (!session) return null

  // 形态:双成员 + dm 标记。members 与标记一起写,于是"人数即形态"这条约定
  // (D1/D3)在数据落库的那一刻就成立。
  const currentMembers = session.room?.memberAgentIds ?? []
  const shapeOk = session.kind === 'room'
    && session.room?.dm === true
    && currentMembers.length === 2
    && currentMembers[0] === memberAgentIds[0]
    && currentMembers[1] === memberAgentIds[1]
  if (!shapeOk) {
    // 与 `user-dm-room.ts` 同款留痕:这条分支把名册**改写**成这两位,和协调器的
    // 移人路径是同一件事,必须留同一款痕(collab-history-search.md §3)。不记的话
    // `collabRoomVisibleUntil` 对被挤掉的人返回 undefined —— 那不是「看不到内容」,
    // 是「这间房从不存在」,他当时确实读过的那段历史会被判成越权。
    const displaced = currentMembers.filter(id => !memberAgentIds.includes(id))
    const removedAt = Date.now()
    store.updateSessionCollab(roomSessionId, {
      kind: 'room',
      room: {
        ...(session.room ?? {}),
        memberAgentIds,
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
  }
  if (session.name !== roomName) store.renameSession(roomSessionId, roomName)

  return roomSessionId
}

/**
 * 「这条会话所在的房间里,有没有人类能回答一次提问」(D191,从 `interaction/interaction-no-human.ts` 搬来)。
 *
 * 判据本身在 2026-08 之前只长在外部 agent 那条桥上,因为当时只有 SDK 自带的 `AskUserQuestion` 会提问。
 * 原生 `ask_user` 落地之后它有了第二个消费者,而这条判据**不允许有第二份手写** —— 两份门只要有一份漏了,
 * 那一侧的提问就在一间没有人的房里空等到 deadline(而 `ask_user` 刻意没有短 deadline,空等就是永远)。
 *
 * 为什么住在 session:它只读一条会话记录(`getSession`)和一个纯判定(`isAgentPairDmRoom`),两者都是会话的事实。
 * 从前住在 interaction 时,interaction 入口一交出它就成环(会话入口经 `session-permission-events` 又引 interaction
 * 入口),所以外面三个读者(工具目录的提问适配器、外部 agent 的连接器登记表、ACP 的提问桥)只能深层引它。
 * 搬进 session 之后它们都经会话入口拿。本文件只引兄弟文件,不引 session 入口。
 */
import { isAgentPairDmRoom } from './session-dm-room.js'
import { getSession } from './session-store.js'

/**
 * 这次提问所在的房间(执行会话 → 它服务的那间房)。与
 * `permission-policy.ts` 的 collab 提醒桥取法逐字一致。
 */
function resolveRoomSessionId(sessionId: string): string | undefined {
  const session = getSession(sessionId) as
    | { id: string; kind?: string; collab?: { roomSessionId?: string } }
    | undefined
  if (!session) return undefined
  return session.kind === 'room' ? session.id : session.collab?.roomSessionId
}

/**
 * pair 房 = 两个 agent 的私聊,**没有人类在场**。在那里发起一次提问就是发起一次
 * 空等:没有人会看见卡片,只能等 deadline 到点。所以当场 declined,并把「这里没人
 * 能回答你」直接写给模型 —— 方案 §4 末段、原则 3。
 */
export function noHumanInTheRoom(sessionId: string): boolean {
  const roomSessionId = resolveRoomSessionId(sessionId)
  if (!roomSessionId) return false
  const room = (getSession(roomSessionId) as { room?: Parameters<typeof isAgentPairDmRoom>[0] } | undefined)?.room
  return isAgentPairDmRoom(room)
}

export const NO_HUMAN_DECLINE_REASON =
  '这是两个 agent 的私聊,没有人类在场,没有人能回答你的问题。请不要再提问,按你自己的判断继续,并在回答里说明你替对方做了哪个假设。'

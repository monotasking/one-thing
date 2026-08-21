/**
 * 「这条会话所在的场合里,有没有人类能回答一次提问」。
 *
 * 判据本身在 2026-08 之前只长在外部 agent 那条桥上
 * (`app/external-agents/index.ts` 的 `noHumanInTheRoom`),因为当时只有 SDK 自带的
 * `AskUserQuestion` 会提问。原生 `ask_user` 落地之后它有了第二个消费者,而这条
 * 判据**不允许有第二份手写** —— 两份门只要有一份漏了,那一侧的提问就在一间
 * 没有人的房里空等到 deadline(而 `ask_user` 刻意没有短 deadline,空等就是永远)。
 *
 * 依赖刻意压到最小(store 读一条会话 + 一个纯判定),这样它可以被 builtin 工具
 * 的装配直接引用,而不必把整棵 external-agents 图(spawn / 权限策略 / 后台状态)
 * 拖进工具 barrel。
 */
import { isAgentPairDmRoom } from '@onething/runtime/collab'

import { getSession } from '../../store.js'

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

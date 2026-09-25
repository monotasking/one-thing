import { useCallback, useMemo } from 'react'
import { respondChatPermission, useChatSourceOf } from '../../data/chat-source'
import type { ProjectedMessage } from '../../data/chat-fold'
import type { PermissionAsk } from '../../data/permission-ask'
import type { PermissionResponse } from '@shared/ipc/permissions'
import { PermissionCard } from './PermissionCard'
import cardStyles from './PermissionCard.module.css'

/**
 * **一次调用的审批槽** —— 工具卡里那一格,九成的时间什么都不画。
 *
 * ── 为什么一步一个槽,而不是一张卡一个 ────────────────────────────────────
 * 判据是**订阅的粒度**。一张卡一个槽的话,选择器得交出「这张卡上那几条 ask」——
 * 一个数组,而数组每次都是新对象,于是每一帧推屏都把这张卡重渲一遍(09-03
 * 流式卡死那条病的形状)。一步一个槽交出的是 `permissions[callId]`:要么是
 * `undefined`,要么是车道上那个**身份恒定**的对象,zustand 的 `Object.is` 当场
 * 挡住 —— 没有审批的那九成帧里,这只组件一次都不重渲染。
 *
 * 代价是一条会话里有几步就有几格订阅。它们各自只做一次 Map 取值,而车道本身
 * 一帧最多变一次;与「每帧重渲两百张卡」不在一个量级上。
 *
 * ── 它画在卡的**末尾**,不在行里 ──────────────────────────────────────────
 * 行在收起态是 `hidden` 的(工具卡 §6.5 第 1 条:行不重挂,靠属性藏),而一张
 * 等着人答的卡**在收起态也必须看得见** —— 藏起一个正在等人的问题,人就永远
 * 等不到答案。所以槽长在 `ToolCard` 的行列之外。
 */
export function PermissionSlot({
  sessionId,
  toolCallId,
}: {
  sessionId: string
  toolCallId: string
}) {
  const ask = useChatSourceOf(sessionId, (state) => state.permissions[toolCallId])
  const respond = useCallback(
    (id: string, decision: PermissionResponse) => respondChatPermission(id, decision, sessionId),
    [sessionId],
  )
  if (!ask) return null
  return <PermissionCard ask={ask} onRespond={respond} />
}

/**
 * **没有工具卡可挂的审批**(ACP A3-d,`gate:acp-shell` ⑥ 真机量出来的缺口)。
 *
 * 上面那只槽长在工具卡里,判据是「一次审批问的是这一次调用能不能做」。可 agent 的
 * 文件读写与起终端(A3-b 的 `acp-fs-*` / `acp-terminal-*`)是 agent 向**客户端**要
 * 东西,不是一次它报过的工具调用 —— 账本上没有那一步,屏上就没有那张工具卡,于是
 * 那张卡在壳里**无处可画**:人看不见,agent 那一轮永远停在那儿等。
 *
 * 所以:审批车道里那些 `toolCallId` 在这条会话的消息里**找不到调用**的,排在消息列
 * 末尾(座位垫块之前)各画一张。它们仍是同一只 `PermissionCard`、同一个应答口 ——
 * 与工具卡里那张只差「住在哪」。一旦那次调用出现在账本上(先问后记的那一族),
 * 这一格自己退场、工具卡里那只槽接手:判据每次都现算,两处不会同时画同一张。
 *
 * 订阅粒度:没有审批的那九成时间,车道是那张恒等的空表,`useMemo` 直接交回空数组
 * 常量 —— 不遍历消息。
 */
export function OrphanPermissions({
  sessionId,
  messages,
}: {
  sessionId: string
  messages: readonly ProjectedMessage[]
}) {
  const lane = useChatSourceOf(sessionId, (state) => state.permissions)
  const orphans = useMemo(() => orphanAsksOf(lane, messages), [lane, messages])
  const respond = useCallback(
    (id: string, decision: PermissionResponse) => respondChatPermission(id, decision, sessionId),
    [sessionId],
  )
  if (orphans.length === 0) return null
  return (
    <div className={cardStyles.orphans} data-permission-orphans="">
      {orphans.map((ask) => (
        <PermissionCard key={ask.toolCallId} ask={ask} onRespond={respond} />
      ))}
    </div>
  )
}

const NONE: readonly PermissionAsk[] = Object.freeze([])

/** 车道里找不到调用的那几张(纯函数;判词在 `OrphanPermissions` 上)。 */
export function orphanAsksOf(
  lane: Readonly<Record<string, PermissionAsk>>,
  messages: readonly ProjectedMessage[],
): readonly PermissionAsk[] {
  const asks = Object.values(lane)
  if (asks.length === 0) return NONE
  const known = new Set<string>()
  const walkSteps = (steps: ProjectedMessage['steps']) => {
    for (const step of steps ?? []) {
      if (step.toolCallId) known.add(step.toolCallId)
      if (step.toolCall?.id) known.add(step.toolCall.id)
      walkSteps(step.childSteps)
    }
  }
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) known.add(call.id)
    walkSteps(message.steps)
  }
  const orphans = asks.filter((ask) => !known.has(ask.toolCallId))
  return orphans.length === 0 ? NONE : orphans
}

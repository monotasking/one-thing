import { useCallback } from 'react'
import { respondChatPermission, useChatSourceOf } from '../../data/chat-source'
import type { PermissionResponse } from '@shared/ipc/permissions'
import { PermissionCard } from './PermissionCard'

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

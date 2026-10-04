/**
 * **会话生命周期的全局订阅口**(共享层读侧补齐 E 批;C0 从
 * `packages/renderer/platform/session-lifecycle.ts` 搬来,改吃事件枢纽)。
 *
 * ## 为什么它不是传输面上的一格
 *
 * 因为它不需要传输面出一分力。`session:event` 那条推送面本来就把**所有会话**的
 * 事件送到客户端,缺的只是"从那条流里认出建/删这两件事"的那一层折叠 —— 折叠是
 * 客户端的活,不是通道的活。所以这里是枢纽之上的一个纯函数 + 一行订阅,
 * `Transport` 一行不动。
 *
 * ## 两件事各自的产地
 *
 * | 事件 | 从哪儿来 |
 * |---|---|
 * | 建 | 账本第一条 `session/created`,B 期起随 `session:ledger-event` 原样下发 |
 * | 删 | `session:removed` 会话事件(E 批新增的词,不是新通道)——账本连同目录一起没了,所以它在账本上没有对应的一条 |
 *
 * 两条走的是**同一条** `session:event`,所以桌面与 web 收到的是同一份事实,
 * 不存在"某一侧多一层翻译"。
 *
 * ## 归属过滤在服务端,不在这里
 *
 * server 侧那条通配订阅逐条问受众;这里看到的每一条都已经过闸。
 * 客户端**不许**自己再判一次 —— 判据只有一把尺。
 */
import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import type { SessionEventEnvelope } from '@shared/events/index.js'
import { IPC_CHANNELS } from '@shared/ipc/channels.js'
import type { EventHub, Unsubscribe } from './subscriptions.js'

/** 一条会话被建出来了。 */
export interface SessionCreatedLifecycleEvent {
  type: 'created'
  sessionId: string
  /** 建的时候盖在账本上的形态(`room` / 缺席 = 普通对话)。 */
  kind?: string
  agentId?: string
}

/** 一条会话没有了。级联删子会话时每条各来一次。 */
export interface SessionDeletedLifecycleEvent {
  type: 'deleted'
  sessionId: string
  /** 这次删除动作里一起没掉的全部会话(含自己)。 */
  cascadedSessionIds: readonly string[]
}

export type SessionLifecycleEvent =
  | SessionCreatedLifecycleEvent
  | SessionDeletedLifecycleEvent

/**
 * 把一条 `session:event` 折成生命周期事件;不是这两件事就回 `undefined`。
 *
 * 纯函数、不碰任何传输 —— 单测因此不需要造一个宿主。
 */
export function foldSessionLifecycleEvent(
  envelope: SessionEventEnvelope,
): SessionLifecycleEvent | undefined {
  const event = envelope?.event as { type?: unknown } | undefined
  if (!event || typeof event.type !== 'string') return undefined

  if (event.type === SESSION_EVENT_TYPES.SESSION_REMOVED) {
    const deleted = event as unknown as {
      sessionId?: string
      cascadedSessionIds?: readonly string[]
    }
    const sessionId = deleted.sessionId ?? envelope.sessionId
    if (!sessionId) return undefined
    return {
      type: 'deleted',
      sessionId,
      cascadedSessionIds: deleted.cascadedSessionIds ?? [sessionId],
    }
  }

  if (event.type !== SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT) return undefined

  // 账本原词汇:只认 `session/created` 那一条,其余(消息 / 工具 / run …)不是
  // 生命周期,原样放过。
  const record = (event as unknown as { record?: { type?: unknown; data?: unknown } }).record
  if (!record || record.type !== 'session/created') return undefined
  const data = (record.data ?? {}) as { sessionId?: string; kind?: string; agentId?: string }
  const sessionId = data.sessionId ?? envelope.sessionId
  if (!sessionId) return undefined
  return {
    type: 'created',
    sessionId,
    ...(data.kind ? { kind: data.kind } : {}),
    ...(data.agentId ? { agentId: data.agentId } : {}),
  }
}

/** 订阅"会话被建 / 被删",跨全部会话。返回退订函数。 */
export function onSessionLifecycle(
  hub: EventHub,
  callback: (event: SessionLifecycleEvent) => void,
): Unsubscribe {
  return hub.on(IPC_CHANNELS.SESSION_EVENT, envelope => {
    const lifecycle = foldSessionLifecycleEvent(envelope)
    if (lifecycle) callback(lifecycle)
  })
}

/**
 * W19 真实 typing — the wiring half (docs/design/multi-agent-collab-im.md §4 W19).
 *
 * The pure tracker (`@onething/runtime/collab`) turns a stream of session events
 * into typing pulses; this file is the only place that knows where those events
 * come from and where the pulses go.
 *
 * **Where it listens**: the session where the turn actually runs — an agent
 * execution session (W18) or a work session. Per-session `onAny`, hung for the
 * duration of one turn window and torn down the moment the window closes. There
 * is deliberately no global observer: `tool:*` events fire on every chat in the
 * app, and a resident per-chunk listener would tax sessions that have nothing to
 * do with any room.
 *
 * **Where it points**: the room the session is bound to — the drive's target
 * room for an execution session, the parent room for a work session. Resolving
 * it here (rather than from the call's `room` argument) is what makes the light
 * come on while the arguments are still streaming; a `send_message` that
 * explicitly names a different room lights this one for the length of that call
 * (W19 §2, accepted). The room id is handed to the tracker so that a call which
 * turns out NOT to be for this room (a private message, an explicit other room)
 * stops lighting it the moment its arguments are readable
 * (collab-send-channel-and-wake.md §4).
 */
import { createCollabTypingTracker, type CollabTypingSignal } from '@onething/runtime/collab'
import { getEventBus } from '../../events/index.js'
import { broadcastCollabCoordinator, setCollabTypingState } from './inspector.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

/**
 * IM typing indicator (§2.4). Since W19 `true` means "this member's `say` call
 * is streaming its words right now"; `false` means that line is done — or that
 * the turn settled without one, the "typed and deleted" case the design wants
 * the room to see as a light that came on and went out.
 *
 * 这道漏斗同时**记账**(架构收敛 C4 §2):四个生产点全从这里过,所以协调器快照里
 * 的 `typing` 与发出去的这条事件不可能分家。事件本身留着 —— 向后兼容,以及给
 * 网关那类不读快照的消费者;渲染层的账本只有快照那一本。
 */
export function emitCollabTyping(roomSessionId: string, agentId: string, typing: boolean): void {
  setCollabTypingState(roomSessionId, agentId, typing)
  void getEventBus().emit(roomSessionId, {
    type: SESSION_EVENT_TYPES.COLLAB_TYPING,
    agentId,
    typing,
  } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
}

/**
 * The room's turn window opened or closed (collab-team-v2 §5.1 入口①).
 *
 * Neighbour of `emitCollabTyping` and deliberately NOT the same signal. Typing
 * says "words are streaming right now" and flickers several times inside one
 * turn; this says "this room has a stream you can stop", once at each edge of
 * the window `abortRoomTurn` aims at. A stop button driven by the typing light
 * would disappear between two `say` calls, in the exact seconds a user who
 * wants to interrupt is reaching for it.
 */
export function emitCollabTurnActive(roomSessionId: string, agentId: string, active: boolean): void {
  // 回合窗的两条边正是 `activeTurns` 的登记与摘除,而快照的 `speaking` 读的就是
  // 那张表 —— 在这里推一发,「谁在说」与「有没有可以停的东西」就永远同源同时
  // (架构收敛 C4 §1)。走活动窗口:停止按钮要在人伸手的那一刻就已经画好。
  broadcastCollabCoordinator(roomSessionId, { activity: true })
  void getEventBus().emit(roomSessionId, {
    type: SESSION_EVENT_TYPES.COLLAB_TURN_ACTIVE,
    agentId,
    active,
  } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
}

/**
 * Watch one turn window and mirror its `say` calls into the room as typing.
 *
 * Returns the detach function, which is also the 兜底: it unsubscribes AND
 * forces the indicator off if the window closed with the light still on (a
 * crash mid-arguments, an aborted stream, a provider that never sent input-end).
 * Call it in a `finally` — an early return that skips it leaks a bus handler.
 */
export function observeCollabSayTyping(options: {
  /** The session the turn runs in (agent execution session, or work session). */
  sessionId: string
  /** The room whose typing line lights up. */
  roomSessionId: string
  agentId: string
}): () => void {
  const { sessionId, roomSessionId, agentId } = options
  // 灯挂在哪间房要告诉 tracker:合并之后私聊档也顶着 `send_message` 这个名字,
  // 而"发给某个人"与"发进别的房"都不该点亮这一间(collab-send-channel-and-wake.md §4)。
  const tracker = createCollabTypingTracker({ roomSessionId })
  const unsubscribe = getEventBus().onAny(sessionId, envelope => {
    const signal = (envelope as { event?: CollabTypingSignal } | undefined)?.event
    const next = tracker.observe(signal)
    if (next !== null) emitCollabTyping(roomSessionId, agentId, next)
  }, 'collab-typing')

  let detached = false
  return () => {
    if (detached) return
    detached = true
    unsubscribe()
    const final = tracker.finish()
    if (final !== null) emitCollabTyping(roomSessionId, agentId, final)
  }
}

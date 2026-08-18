/**
 * 回合工具调用断路器 — the pure half (W22,
 * docs/design/multi-agent-collab-im.md §4 W22).
 *
 * 现场 2026-07-28: one agent made 77 `stay_silent` calls across four turns,
 * another 61 across two. The tool is gone (see `tool-surface.ts`), but the
 * SHAPE of that failure is not specific to it — a tool loop that never reaches
 * a tool-less round burns one full-context request per lap and only stops when
 * the wall clock does. Ten minutes of that is real money.
 *
 * So this is the structural floor under every room turn, independent of which
 * tool is spinning: count the calls, and when a turn goes past what an IM reply
 * could possibly need, abort it.
 *
 * Two caps, because they answer different questions:
 *
 *  - **total** (`COLLAB_TURN_MAX_TOOL_CALLS`) — "is this turn still doing
 *    something, or is it stuck?" Says, board reads, board writes all count.
 *  - **say** (`COLLAB_TURN_MAX_SAY_CALLS`) — "is this a person sending a few
 *    short lines, or a member flooding the room?" IM 连发 is a feature (W19
 *    lights a pulse per line), so the cap sits well above normal use; six lines
 *    in one turn is already more than anyone reads.
 *
 * Deliberately NOT here: the wall-clock timeout (`waitForRoomTurn` owns it, and
 * it is the wrong instrument — a loop can burn a lot of money inside ten
 * minutes), and the work session (a card is real work with real tool use; its
 * bound is the clock).
 *
 * Counting happens on `tool:execution-start`, one per executed call, deduped by
 * `toolCallId`: it is the event that exists for every provider (a provider that
 * does not stream tool arguments emits no `tool:input-start`), and it fires
 * before the result goes back to the model — so tripping on it cuts the lap
 * that would otherwise pay for the next full-context request.
 */
import {
  isCollabSendCall,
  isCollabSendDmCall,
  type CollabSendArgsLike,
  type CollabTurnToolCallLike,
} from './say.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

/**
 * Most tool calls one room turn may make. A turn that says its piece and reads
 * the board uses two or three; forty is "something is wrong" with room to
 * spare, not a budget anyone should be pressed against.
 *
 * Raised from 12 (2026-07-28, 用户实锤): the original caps were set the same
 * afternoon the 死循环 happened, sized against a turn that had gone wrong rather
 * than against the longest legitimate turn anyone had actually seen. A backstop
 * that trips on real work is not a backstop, it is a behaviour — and the failure
 * it exists for is hundreds of laps, not a few dozen, so the higher floor costs
 * it nothing.
 */
export const COLLAB_TURN_MAX_TOOL_CALLS = 40

/** Most `say` calls one room turn may make (IM 连发 stays legal well past what
 *  anybody actually sends). Raised from 6 for the reason above — that one was
 *  the cap users hit first, because 连发 is a feature. */
export const COLLAB_TURN_MAX_SAY_CALLS = 20

/**
 * The two caps as a room configures them (`CollabRoomBudgets`), where **0 means
 * off**. Same convention as the room's other gates (日预算 0 = 不限额, maxChain
 * 0 = 不限), so one number in the settings form covers both "raise it" and
 * "remove it" and nobody has to edit a constant to get out of the way.
 */
export interface CollabTurnBreakerLimits {
  maxToolCalls?: number
  maxSayCalls?: number
}

/** A cap is live only if it is a positive finite number; 0, negatives and
 *  garbage all mean "no cap" (see the 0 = off convention above). */
function capOf(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) return Infinity
  return Math.floor(value)
}

/**
 * Room config → effective caps, with `enabled: false` when the room has turned
 * both of them off. Callers use that to skip subscribing at all rather than
 * running a breaker that can never trip.
 */
export function resolveCollabTurnBreakerLimits(limits?: CollabTurnBreakerLimits): {
  maxToolCalls: number
  maxSayCalls: number
  enabled: boolean
} {
  const maxToolCalls = capOf(limits?.maxToolCalls, COLLAB_TURN_MAX_TOOL_CALLS)
  const maxSayCalls = capOf(limits?.maxSayCalls, COLLAB_TURN_MAX_SAY_CALLS)
  return {
    maxToolCalls,
    maxSayCalls,
    enabled: Number.isFinite(maxToolCalls) || Number.isFinite(maxSayCalls),
  }
}

/** Structural view of the session events the breaker reads — the same event
 *  shape the typing tracker consumes, for the same reason (one source of
 *  truth about how a tool name can be spelled across the wire forms). */
export interface CollabTurnBreakerSignal {
  type?: string
  toolCallId?: string
  /** `tool:execution-start` carries the resolved tool name here. */
  toolName?: string
  /** `tool:execution-start` carries the settled arguments here. */
  args?: CollabSendArgsLike
  toolCall?: (CollabTurnToolCallLike & { id?: string; arguments?: CollabSendArgsLike }) | undefined
}

/** Which cap gave way, and what the turn had done by then. */
export interface CollabTurnBreakerTrip {
  reason: 'total' | 'say'
  /** The cap that was exceeded. */
  limit: number
  toolCalls: number
  sayCalls: number
}

export interface CollabTurnCircuitBreaker {
  /**
   * Feed one session event. Returns the trip exactly ONCE — the call that goes
   * past a cap — and `null` forever after, so a caller can abort in the
   * handler without guarding against a second abort for the same turn.
   */
  observe(signal: CollabTurnBreakerSignal | null | undefined): CollabTurnBreakerTrip | null
  readonly tripped: CollabTurnBreakerTrip | null
  readonly toolCalls: number
  readonly sayCalls: number
}

function toolNameOf(signal: CollabTurnBreakerSignal): string | undefined {
  return signal.toolName
    || signal.toolCall?.toolName
    || signal.toolCall?.toolId
    || signal.toolCall?.name
    || undefined
}

function toolCallIdOf(signal: CollabTurnBreakerSignal): string | undefined {
  return signal.toolCallId || signal.toolCall?.id || undefined
}

/**
 * The caps are maxima, not thresholds: a turn making exactly
 * `COLLAB_TURN_MAX_SAY_CALLS` says is fine, and the call AFTER it trips. Stated
 * plainly because the off-by-one is the difference between a breaker and a
 * behaviour change (真机验收: 正常多 say 不能被误伤).
 */
export function createCollabTurnCircuitBreaker(
  limits?: CollabTurnBreakerLimits,
): CollabTurnCircuitBreaker {
  // 0 = off flows through the same resolver the caller uses to decide whether
  // to subscribe, so a breaker built anyway (tests, other call sites) behaves
  // identically to one that was never wired.
  const { maxToolCalls, maxSayCalls } = resolveCollabTurnBreakerLimits(limits)

  /** Executed calls already counted, so a provider (or a bus replay) that
   *  repeats an execution-start cannot inflate the count. */
  const counted = new Set<string>()
  let toolCalls = 0
  let sayCalls = 0
  let tripped: CollabTurnBreakerTrip | null = null

  return {
    get tripped() {
      return tripped
    },
    get toolCalls() {
      return toolCalls
    },
    get sayCalls() {
      return sayCalls
    },

    observe(signal) {
      if (tripped) return null
      if (signal?.type !== SESSION_EVENT_TYPES.TOOL_EXECUTION_START) return null

      // P2-15: a call with no id is COUNTED, just not de-duplicated. It used to
      // be dropped entirely, which points this component's failure mode the
      // wrong way: a structural backstop against runaway loops must never
      // under-count — an emitter that stops stamping ids would silently switch
      // the breaker off, exactly when the loop it guards against is running.
      // Over-counting costs at worst an early trip on a turn that was already
      // near the cap, and the note says which cap it hit.
      const toolCallId = toolCallIdOf(signal)
      if (toolCallId) {
        if (counted.has(toolCallId)) return null
        counted.add(toolCallId)
      }

      toolCalls += 1
      // 私聊档不计进「发言」那一格(collab-send-channel-and-wake.md §4):合并
      // 之前 `dm` 是另一个工具名,它从来只吃 total 那道闸;合并只换了名字,不该
      // 顺手把"给八个人各发一张牌"判成刷屏。总数照计 —— 那道闸问的是"这一轮还
      // 在做事吗",与话说给谁听无关。
      //
      // 名字按 `isCollabSendCall` 归一(架构审查 B7):事件流带的是模型吐出来的
      // 原始名,一次 `say` 调用发得出消息却不进这一格,刷屏闸就在最需要它的那种
      // 回合(模型正照着旧范例连发)上静默失灵。
      if (
        isCollabSendCall(toolNameOf(signal))
        && !isCollabSendDmCall(signal.args ?? signal.toolCall?.arguments)
      ) {
        sayCalls += 1
      }

      if (sayCalls > maxSayCalls) {
        tripped = { reason: 'say', limit: maxSayCalls, toolCalls, sayCalls }
        return tripped
      }
      if (toolCalls > maxToolCalls) {
        tripped = { reason: 'total', limit: maxToolCalls, toolCalls, sayCalls }
        return tripped
      }
      return null
    },
  }
}

/**
 * The line the execution session keeps. Written for a human reading the agent
 * tab later (W20) — it names the cap that gave way and the counts, because
 * "why did this turn stop" is the only question anyone asks of it.
 */
export function formatCollabTurnBreakerNote(trip: CollabTurnBreakerTrip): string {
  const what = trip.reason === 'say'
    ? `这一轮发言 ${trip.sayCalls} 条,超过单轮上限 ${trip.limit} 条`
    : `这一轮工具调用 ${trip.toolCalls} 次,超过单轮上限 ${trip.limit} 次`
  return `(回合断路器:${what},已中止本轮。)`
}

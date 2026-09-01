import { SESSION_EVENT_TYPES } from '../events/session-event-types.js'
import type { EventBase, StreamChunkBase, StreamDeltaStamp } from '../events/index.js'
import { toLogger, type CompatLogger } from '../logging/index.js'
import type { JsonObject } from '../json.js'
import type { CoreIPCEmitter, CoreReasoningPlacement } from './ipc-emitter.js'
import type { CoreToolArgsFinalizedBy } from './stream-processor.js'

export type CoreEventOnlyStreamChunk =
  | {
      type: 'text-delta'
      text: string
      turnIndex?: number
      voiceSpeakText?: string
      stamp?: StreamDeltaStamp
    }
  | {
      type: 'reasoning-delta'
      reasoning: string
      turnIndex?: number
      placement?: CoreReasoningPlacement
      stamp?: StreamDeltaStamp
    }
  | {
      type: 'tool-input-delta'
      toolCallId: string
      argsTextDelta: string
      stamp?: StreamDeltaStamp
    }

type CoreEventOnlySessionEventBody<
  TStep = unknown,
  TToolCall = unknown,
  TToolPartialResult = unknown,
  TToolResult = unknown,
  TContentPart = unknown,
  TStreamCompleteData = unknown,
  TStreamErrorData = unknown,
> =
  | { type: typeof SESSION_EVENT_TYPES.TOOL_CALL; toolCall: TToolCall }
  | { type: typeof SESSION_EVENT_TYPES.TOOL_RESULT; toolCall: TToolCall }
  | { type: typeof SESSION_EVENT_TYPES.TOOL_INPUT_START; toolCallId: string; toolName: string; toolCall: TToolCall }
  | { type: typeof SESSION_EVENT_TYPES.TOOL_INPUT_END; toolCallId: string; stepId?: string; toolCall: TToolCall; receivedAt: number; finalizedBy: CoreToolArgsFinalizedBy }
  | { type: typeof SESSION_EVENT_TYPES.TOOL_EXECUTION_START; toolCallId: string; stepId: string; toolName: string; args: JsonObject; startTime?: number }
  | { type: typeof SESSION_EVENT_TYPES.TOOL_EXECUTION_UPDATE; toolCallId: string; stepId: string; partialResult: TToolPartialResult }
  | { type: typeof SESSION_EVENT_TYPES.TOOL_EXECUTION_END; toolCallId: string; stepId: string; result?: TToolResult; isError?: boolean; error?: string; durationMs?: number }
  | { type: typeof SESSION_EVENT_TYPES.CONTENT_PART; part: TContentPart }
  | { type: typeof SESSION_EVENT_TYPES.CONTENT_CONTINUATION; turnIndex?: number }
  | { type: typeof SESSION_EVENT_TYPES.STEP_ADDED; step: TStep }
  | { type: typeof SESSION_EVENT_TYPES.STEP_UPDATED; stepId: string; updates: Partial<TStep> }
  | { type: typeof SESSION_EVENT_TYPES.STREAM_COMPLETE; data: TStreamCompleteData }
  | { type: typeof SESSION_EVENT_TYPES.STREAM_ERROR; data: TStreamErrorData }
  | { type: typeof SESSION_EVENT_TYPES.STREAM_ABORTED; reason?: string }
  | { type: typeof SESSION_EVENT_TYPES.CONTEXT_SIZE_UPDATED; contextSize: number }
  | { type: typeof SESSION_EVENT_TYPES.SKILL_ACTIVATED; skillName: string }

/**
 * 每条事件都盖上它所属的 assistant 消息号。
 *
 * 从前只有 `stream:start` 一条带号,工具与步骤事件一律不带 —— 于是渲染侧只能靠
 * 「当前这条流是谁」去兜(`chat.ts` 的 `activeStreams` + `resolveMessageId`),而那
 * 个绑定是**本窗口本次会话**的短暂事实:窗口在一轮跑到一半时重载、开第二个窗口、
 * 或者跑起来之后才切进这个会话,绑定就不在了,后续 tool/step 事件被整批丢弃或泊死。
 * 卡片因此长不出来,而带着真号来的 `permission:request` 找得到消息、找不到调用,
 * 只能进缓存空等 —— 后端一直挂着等审批,前端一张卡都不出。
 *
 * 号由发射器自己盖(`assistantMessageId` 本就在闭包里,写 store 时一直在用),
 * 消费者不必再猜。可选是为了兼容旧的重放数据,新发出的事件一律带号。
 */
export type CoreEventOnlySessionEvent<
  TStep = unknown,
  TToolCall = unknown,
  TToolPartialResult = unknown,
  TToolResult = unknown,
  TContentPart = unknown,
  TStreamCompleteData = unknown,
  TStreamErrorData = unknown,
> = CoreEventOnlySessionEventBody<
  TStep,
  TToolCall,
  TToolPartialResult,
  TToolResult,
  TContentPart,
  TStreamCompleteData,
  TStreamErrorData
> & { messageId?: string }

export interface CoreEventOnlyEventBusLike<TEvent extends EventBase = EventBase> {
  emit(sessionId: string, event: TEvent): Promise<unknown>
}

export interface CoreEventOnlyStreamChannelLike<TChunk extends StreamChunkBase = StreamChunkBase> {
  push(sessionId: string, chunk: TChunk): void
}

export interface CoreEventOnlyStoreHooks<TStep = unknown> {
  addMessageStep?(sessionId: string, assistantMessageId: string, step: TStep): void
  updateMessageStep?(sessionId: string, assistantMessageId: string, stepId: string, updates: Partial<TStep>): void
  updateSessionContextSize?(sessionId: string, contextSize: number): void
  updateMessageSkill?(sessionId: string, assistantMessageId: string, skillName: string): void
}

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CoreEventOnlyLogger = CompatLogger

export interface CreateCoreEventOnlyEmitterOptions<
  TStep = unknown,
  TToolCall = unknown,
  TToolPartialResult = unknown,
  TToolResult = unknown,
  TContentPart = unknown,
  TStreamCompleteData = unknown,
  TStreamErrorData = unknown,
> {
  sessionId: string
  assistantMessageId: string
  getEventBus?: () => CoreEventOnlyEventBusLike<
    CoreEventOnlySessionEvent<
      TStep,
      TToolCall,
      TToolPartialResult,
      TToolResult,
      TContentPart,
      TStreamCompleteData,
      TStreamErrorData
    >
  > | null | undefined
  getStreamChannel?: () => CoreEventOnlyStreamChannelLike<CoreEventOnlyStreamChunk> | null | undefined
  store?: CoreEventOnlyStoreHooks<TStep>
  /** @deprecated 等级过滤取代开关(§8.1):trace 开了就打。留一个版本的兼容位。 */
  debugStream?: boolean | (() => boolean)
  logger?: CoreEventOnlyLogger
  now?: () => number
  nowIso?: () => string
  /**
   * **这条 delta 的账本身份章**(R 线 R1)。
   *
   * 口在这里、产地不在这里:章由引擎侧给打包行编号的那台机器铸好之后交到台面上
   * (`backend/events/delta-stamp.ts`),发射器只按 `(kind, 这条 delta 的原文)`
   * 去取。**对不上就不盖** —— 没走过那台机器的正文(重放 / 生图这类旁路)拿不到
   * 章,老行为逐字不变;宁可缺一枚章,不肯盖一枚错的。
   */
  resolveDeltaStamp?: (
    kind: 'text' | 'reasoning' | 'tool-input',
    text: string,
    toolCallId?: string,
  ) => StreamDeltaStamp | undefined
}

const debugLastPushAt = new Map<string, number>()

function previewText(value: string, maxLength = 240): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function debugGapMs(key: string, now: number): number | undefined {
  const previous = debugLastPushAt.get(key)
  debugLastPushAt.set(key, now)
  return previous === undefined ? undefined : now - previous
}

export function createCoreEventOnlyEmitter<
  TStep = unknown,
  TToolCall = unknown,
  TToolPartialResult = unknown,
  TToolResult = unknown,
  TContentPart = unknown,
  TStreamCompleteData = unknown,
  TStreamErrorData = unknown,
>(
  options: CreateCoreEventOnlyEmitterOptions<
    TStep,
    TToolCall,
    TToolPartialResult,
    TToolResult,
    TContentPart,
    TStreamCompleteData,
    TStreamErrorData
  >
): CoreIPCEmitter<
  TStep,
  TToolCall,
  TToolPartialResult,
  TToolResult,
  TContentPart,
  TStreamCompleteData,
  TStreamErrorData
> {
  const {
    sessionId,
    assistantMessageId,
    getEventBus,
    getStreamChannel,
    store,
    logger: injectedLogger,
    now = Date.now,
    nowIso = () => new Date().toISOString(),
  } = options
  const log = toLogger(injectedLogger)

  type EventBusAdapter = CoreEventOnlyEventBusLike<
    CoreEventOnlySessionEvent<
      TStep,
      TToolCall,
      TToolPartialResult,
      TToolResult,
      TContentPart,
      TStreamCompleteData,
      TStreamErrorData
    >
  >
  type StreamChannelAdapter = CoreEventOnlyStreamChannelLike<CoreEventOnlyStreamChunk>

  let eventBus: EventBusAdapter | null = null
  let streamChannel: StreamChannelAdapter | null = null

  function bus(): EventBusAdapter | null {
    if (!eventBus && getEventBus) {
      try {
        eventBus = getEventBus() ?? null
      } catch {
        eventBus = null
      }
    }
    return eventBus
  }

  function stream(): StreamChannelAdapter | null {
    if (!streamChannel && getStreamChannel) {
      try {
        streamChannel = getStreamChannel() ?? null
      } catch {
        streamChannel = null
      }
    }
    return streamChannel
  }

  function emitSafe(event: CoreEventOnlySessionEvent<
    TStep,
    TToolCall,
    TToolPartialResult,
    TToolResult,
    TContentPart,
    TStreamCompleteData,
    TStreamErrorData
  >): void {
    const eventBus = bus()
    if (!eventBus) return

    // 盖号(见 CoreEventOnlySessionEvent 的注释):事件自己说得清属于哪条消息,
    // 消费者就不必靠「当前活跃流」去猜 —— 那个绑定丢了,整批事件就没了下落。
    eventBus.emit(sessionId, { ...event, messageId: assistantMessageId }).catch(err => {
      log.error('[EventOnlyEmitter] EventBus emit error:', err)
    })
  }

  function pushSafe(chunk: CoreEventOnlyStreamChunk, debug?: () => void): void {
    const streamChannel = stream()
    if (!streamChannel) return

    try {
      debug?.()
      streamChannel.push(sessionId, chunk)
    } catch (err) {
      log.error('[EventOnlyEmitter] StreamChannel error:', undefined, err)
    }
  }

  return {
    sendTextChunk(text, turnIndex, voiceSpeakText) {
      const stamp = options.resolveDeltaStamp?.('text', text)
      pushSafe({
        type: 'text-delta',
        text,
        ...(turnIndex !== undefined ? { turnIndex } : {}),
        ...(voiceSpeakText !== undefined ? { voiceSpeakText } : {}),
        ...(stamp ? { stamp } : {}),
      }, () => {
        if (!log.isLevelEnabled('trace')) return
        const key = `${sessionId}:${assistantMessageId}:text`
        log.trace('[EventOnlyEmitter] push text-delta', {
          time: nowIso(),
          gapMs: debugGapMs(key, now()),
          sessionId,
          assistantMessageId,
          chars: text.length,
          text: previewText(text),
          turnIndex,
        })
      })
    },

    sendReasoningChunk(reasoning, turnIndex, placement) {
      const stamp = options.resolveDeltaStamp?.('reasoning', reasoning)
      pushSafe({
        type: 'reasoning-delta',
        reasoning,
        ...(turnIndex !== undefined ? { turnIndex } : {}),
        ...(placement ? { placement } : {}),
        ...(stamp ? { stamp } : {}),
      }, () => {
        if (!log.isLevelEnabled('trace')) return
        const key = `${sessionId}:${assistantMessageId}:reasoning`
        log.trace('[EventOnlyEmitter] push reasoning-delta', {
          time: nowIso(),
          gapMs: debugGapMs(key, now()),
          sessionId,
          assistantMessageId,
          chars: reasoning.length,
          text: previewText(reasoning),
          turnIndex,
          placement,
        })
      })
    },

    sendToolInputDelta(toolCallId, argsTextDelta) {
      const stamp = options.resolveDeltaStamp?.('tool-input', argsTextDelta, toolCallId)
      pushSafe({
        type: 'tool-input-delta',
        toolCallId,
        argsTextDelta,
        ...(stamp ? { stamp } : {}),
      })
    },

    sendToolCall(toolCall) {
      emitSafe({ type: SESSION_EVENT_TYPES.TOOL_CALL, toolCall })
    },

    sendToolResult(toolCall) {
      emitSafe({ type: SESSION_EVENT_TYPES.TOOL_RESULT, toolCall })
    },

    sendToolInputStart(toolCallId, toolName, toolCall) {
      emitSafe({ type: SESSION_EVENT_TYPES.TOOL_INPUT_START, toolCallId, toolName, toolCall })
    },

    sendToolInputEnd(toolCallId, stepId, toolCall, receivedAt, finalizedBy) {
      emitSafe({ type: SESSION_EVENT_TYPES.TOOL_INPUT_END, toolCallId, stepId, toolCall, receivedAt, finalizedBy })
    },

    sendToolExecutionStart(toolCallId, stepId, toolName, args, startTime) {
      emitSafe({ type: SESSION_EVENT_TYPES.TOOL_EXECUTION_START, toolCallId, stepId, toolName, args, startTime })
    },

    sendToolExecutionUpdate(toolCallId, stepId, partialResult) {
      emitSafe({ type: SESSION_EVENT_TYPES.TOOL_EXECUTION_UPDATE, toolCallId, stepId, partialResult })
    },

    sendToolExecutionEnd(toolCallId, stepId, result, isError, error, durationMs) {
      emitSafe({ type: SESSION_EVENT_TYPES.TOOL_EXECUTION_END, toolCallId, stepId, result, isError, error, durationMs })
    },

    sendContentPart(part) {
      emitSafe({ type: SESSION_EVENT_TYPES.CONTENT_PART, part })
    },

    sendContinuation(turnIndex?) {
      emitSafe({ type: SESSION_EVENT_TYPES.CONTENT_CONTINUATION, turnIndex })
    },

    sendStepAdded(step) {
      store?.addMessageStep?.(sessionId, assistantMessageId, step)
      emitSafe({ type: SESSION_EVENT_TYPES.STEP_ADDED, step })
    },

    sendStepUpdated(stepId, updates) {
      store?.updateMessageStep?.(sessionId, assistantMessageId, stepId, updates)
      emitSafe({ type: SESSION_EVENT_TYPES.STEP_UPDATED, stepId, updates })
    },

    sendStreamComplete(data) {
      emitSafe({ type: SESSION_EVENT_TYPES.STREAM_COMPLETE, data })
    },

    sendStreamError(data) {
      emitSafe({ type: SESSION_EVENT_TYPES.STREAM_ERROR, data })
    },

    sendStreamAborted(reason) {
      emitSafe({ type: SESSION_EVENT_TYPES.STREAM_ABORTED, reason })
    },

    sendContextSizeUpdate(contextSize) {
      store?.updateSessionContextSize?.(sessionId, contextSize)
      emitSafe({ type: SESSION_EVENT_TYPES.CONTEXT_SIZE_UPDATED, contextSize })
    },

    sendSkillActivated(skillName) {
      store?.updateMessageSkill?.(sessionId, assistantMessageId, skillName)
      emitSafe({ type: SESSION_EVENT_TYPES.SKILL_ACTIVATED, skillName })
    },
  }
}

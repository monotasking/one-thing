import type { EventBase, StreamChunkBase } from '../events/index.js'
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
    }
  | {
      type: 'reasoning-delta'
      reasoning: string
      turnIndex?: number
      placement?: CoreReasoningPlacement
    }
  | {
      type: 'tool-input-delta'
      toolCallId: string
      argsTextDelta: string
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
  | { type: 'tool:call'; toolCall: TToolCall }
  | { type: 'tool:result'; toolCall: TToolCall }
  | { type: 'tool:input-start'; toolCallId: string; toolName: string; toolCall: TToolCall }
  | { type: 'tool:input-end'; toolCallId: string; stepId?: string; toolCall: TToolCall; receivedAt: number; finalizedBy: CoreToolArgsFinalizedBy }
  | { type: 'tool:execution-start'; toolCallId: string; stepId: string; toolName: string; args: JsonObject; startTime?: number }
  | { type: 'tool:execution-update'; toolCallId: string; stepId: string; partialResult: TToolPartialResult }
  | { type: 'tool:execution-end'; toolCallId: string; stepId: string; result?: TToolResult; isError?: boolean; error?: string; durationMs?: number }
  | { type: 'content:part'; part: TContentPart }
  | { type: 'content:continuation'; turnIndex?: number }
  | { type: 'step:added'; step: TStep }
  | { type: 'step:updated'; stepId: string; updates: Partial<TStep> }
  | { type: 'stream:complete'; data: TStreamCompleteData }
  | { type: 'stream:error'; data: TStreamErrorData }
  | { type: 'stream:aborted'; reason?: string }
  | { type: 'context:size-updated'; contextSize: number }
  | { type: 'skill:activated'; skillName: string }

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
      pushSafe({
        type: 'text-delta',
        text,
        ...(turnIndex !== undefined ? { turnIndex } : {}),
        ...(voiceSpeakText !== undefined ? { voiceSpeakText } : {}),
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
      pushSafe({
        type: 'reasoning-delta',
        reasoning,
        ...(turnIndex !== undefined ? { turnIndex } : {}),
        ...(placement ? { placement } : {}),
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
      pushSafe({ type: 'tool-input-delta', toolCallId, argsTextDelta })
    },

    sendToolCall(toolCall) {
      emitSafe({ type: 'tool:call', toolCall })
    },

    sendToolResult(toolCall) {
      emitSafe({ type: 'tool:result', toolCall })
    },

    sendToolInputStart(toolCallId, toolName, toolCall) {
      emitSafe({ type: 'tool:input-start', toolCallId, toolName, toolCall })
    },

    sendToolInputEnd(toolCallId, stepId, toolCall, receivedAt, finalizedBy) {
      emitSafe({ type: 'tool:input-end', toolCallId, stepId, toolCall, receivedAt, finalizedBy })
    },

    sendToolExecutionStart(toolCallId, stepId, toolName, args, startTime) {
      emitSafe({ type: 'tool:execution-start', toolCallId, stepId, toolName, args, startTime })
    },

    sendToolExecutionUpdate(toolCallId, stepId, partialResult) {
      emitSafe({ type: 'tool:execution-update', toolCallId, stepId, partialResult })
    },

    sendToolExecutionEnd(toolCallId, stepId, result, isError, error, durationMs) {
      emitSafe({ type: 'tool:execution-end', toolCallId, stepId, result, isError, error, durationMs })
    },

    sendContentPart(part) {
      emitSafe({ type: 'content:part', part })
    },

    sendContinuation(turnIndex?) {
      emitSafe({ type: 'content:continuation', turnIndex })
    },

    sendStepAdded(step) {
      store?.addMessageStep?.(sessionId, assistantMessageId, step)
      emitSafe({ type: 'step:added', step })
    },

    sendStepUpdated(stepId, updates) {
      store?.updateMessageStep?.(sessionId, assistantMessageId, stepId, updates)
      emitSafe({ type: 'step:updated', stepId, updates })
    },

    sendStreamComplete(data) {
      emitSafe({ type: 'stream:complete', data })
    },

    sendStreamError(data) {
      emitSafe({ type: 'stream:error', data })
    },

    sendStreamAborted(reason) {
      emitSafe({ type: 'stream:aborted', reason })
    },

    sendContextSizeUpdate(contextSize) {
      store?.updateSessionContextSize?.(sessionId, contextSize)
      emitSafe({ type: 'context:size-updated', contextSize })
    },

    sendSkillActivated(skillName) {
      store?.updateMessageSkill?.(sessionId, assistantMessageId, skillName)
      emitSafe({ type: 'skill:activated', skillName })
    },
  }
}

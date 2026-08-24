/**
 * Event-Only Emitter
 *
 * Main-process wrapper around the core event-only emitter. The core factory
 * owns IPCEmitter-to-EventBus/StreamChannel mapping; this file only injects
 * main singletons and store side effects.
 */

import * as store from '../store.js'
import type { SessionEvent, StreamChunk } from '@shared/events/index.js'
import type { ContentPart, Step, ToolCall, ToolPartialResult, ToolResult } from '@shared/ipc.js'
import type { StreamContext } from '../wiring/engine/stream/stream-processor.js'
import type { StreamCompleteData, StreamErrorData } from '@shared/events/session-events.js'
import type { IPCEmitter } from '@onething/runtime/engine/ipc-emitter.wiring'
import { createCoreEventOnlyEmitter, type CoreEventOnlyStoreHooks } from '@onething/core/engine'
import type { CoreEventOnlySessionEvent, CoreEventOnlyStreamChunk, CoreEventOnlyEventBusLike, CoreEventOnlyStreamChannelLike } from '@onething/core/engine'
import { getEventBus, getStreamChannel } from './index.js'
import { appendSessionLogEvent } from '../session/event-log.js'
import { currentSessionRunId } from '../session/runs.js'
import { getLogger } from '../wiring/logging/index.js'
import type { JsonObject } from '@onething/core'
import type { CreateCoreEventOnlyEmitterOptions } from '@onething/core/engine'

/**
 * core 因边界规则(不得 import `@shared`)把事件与流块的形状重抄了一份,泛型
 * 留空。两份手抄之间从前只有一个 `as SessionEvent` 焊着 —— shared 侧改字段而
 * core 那份没跟上时,cast 会静默放行,漂移要到运行时才现形。
 *
 * 这里是全仓**唯一**两边类型都 import 得到的地方,所以断言落在这里。
 *
 * 单向包含,不是双向:core 只发得出这十几种事件,而 `SessionEvent` 还包含
 * permission / collab / message 等一大批 core 根本不产的成员 —— 反向断言必然
 * 为假,也没有意义。要守的事实只有一条:**core 发出的东西必须是 shared 认识的
 * 东西**。core 那份改坏了字段,下面这行就红。
 */
type EmittedSessionEvent = CoreEventOnlySessionEvent<
  Step,
  ToolCall,
  ToolPartialResult,
  ToolResult,
  ContentPart,
  StreamCompleteData,
  StreamErrorData
>
const _emittedEventsAreSessionEvents: EmittedSessionEvent extends SessionEvent ? true : never = true
void _emittedEventsAreSessionEvents

/** 同上,流块那一侧:core 发出的 ⊆ shared `StreamChunk`。 */
const _emittedChunksAreStreamChunks: CoreEventOnlyStreamChunk extends StreamChunk ? true : never = true
void _emittedChunksAreStreamChunks

/**
 * core 的 emitter 仍然自带一份形状转储(那半在 area ① 迁移);这里只把"要不要打"
 * 从旧的 `ONETHING_DEBUG_STREAM` 开关换成等级过滤:`ONETHING_LOG=engine.stream=trace`。
 */
const streamLog = getLogger('engine.stream.emitter')

function shouldTraceStream(): boolean {
  return streamLog.isLevelEnabled('trace')
}

/**
 * Create an event-only emitter that sends to EventBus/StreamChannel.
 * IPCBridge translates these events to renderer IPC.
 */
export function createEventOnlyEmitter(ctx: StreamContext): IPCEmitter {
  const sessionId = ctx.sessionId
  const assistantMessageId = ctx.assistantMessageId

  const storePort: CoreEventOnlyStoreHooks<Step> = {
    addMessageStep: store.addMessageStep,
    updateMessageStep: store.updateMessageStep,
    updateSessionContextSize: (targetSessionId, contextSize) =>
      store.updateSessionContextSize(targetSessionId, contextSize, 'provider-finish'),
    /*
     * S3.1(§10.11):技能宣告的**两个落点挂在同一次宣告上** —— 消息上的
     * `skillUsed`(产品事实)与事件账本的 `skill/activated`(那条 run 的账)。
     * 判定点只有一个,在引擎里;这里只负责把它宣告过的事记两处,所以两处
     * 永远同源。以前 `skill/activated` 是记录器自己认出来写的,与引擎那一份
     * 各认各的,真机上就出现过"账本有、消息没有"。
     *
     * 记账坏了绝不能影响聊天:自吞异常,与记录器同一条规矩。
     */
    updateMessageSkill: (targetSessionId, targetMessageId, skillName) => {
      store.updateMessageSkill(targetSessionId, targetMessageId, skillName)
      try {
        const runId = currentSessionRunId(targetSessionId)
        appendSessionLogEvent(targetSessionId, 'skill/activated', {
          messageId: targetMessageId,
          skill: skillName,
          ...(runId ? { runId } : {}),
        })
      } catch (error) {
        streamLog.warn('skill activated event append failed', {
          sessionId: targetSessionId,
        }, error)
      }
    },
  };
  const createCoreEventOnlyEmitterOptions: CreateCoreEventOnlyEmitterOptions<Step, ToolCall, ToolPartialResult, ToolResult<JsonObject | undefined>, ContentPart, StreamCompleteData, StreamErrorData> = {
    sessionId,
    assistantMessageId,
    getEventBus: (): CoreEventOnlyEventBusLike<
      CoreEventOnlySessionEvent<
        Step,
        ToolCall,
        ToolPartialResult,
        ToolResult,
        ContentPart,
        StreamCompleteData,
        StreamErrorData
      >
    > => {
      const eventBus = getEventBus()
      return {
        emit: (targetSessionId, event) => eventBus.emit(targetSessionId, event),
      }
    },
    getStreamChannel: (): CoreEventOnlyStreamChannelLike<CoreEventOnlyStreamChunk> => {
      const streamChannel = getStreamChannel()
      return {
        push: (targetSessionId, chunk) => streamChannel.push(targetSessionId, chunk),
      }
    },
    store: storePort,
    debugStream: shouldTraceStream,
  };
  return createCoreEventOnlyEmitter<
    Step,
    ToolCall,
    ToolPartialResult,
    ToolResult,
    ContentPart,
    StreamCompleteData,
    StreamErrorData
  >(createCoreEventOnlyEmitterOptions)
}

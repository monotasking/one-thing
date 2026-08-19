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
import type { StreamContext } from '../engine/stream/stream-processor.js'
import type { IPCEmitter, StreamCompleteData, StreamErrorData } from '../engine/stream/ipc-emitter.js'
import { createCoreEventOnlyEmitter } from '@onething/core/engine'
import type { CoreEventOnlySessionEvent, CoreEventOnlyStreamChunk } from '@onething/core/engine'
import { getEventBus, getStreamChannel } from './index.js'
import { getLogger } from '../logging/index.js'

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

  return createCoreEventOnlyEmitter<
    Step,
    ToolCall,
    ToolPartialResult,
    ToolResult,
    ContentPart,
    StreamCompleteData,
    StreamErrorData
  >({
    sessionId,
    assistantMessageId,
    getEventBus: () => {
      const eventBus = getEventBus()
      return {
        emit: (targetSessionId, event) => eventBus.emit(targetSessionId, event),
      }
    },
    getStreamChannel: () => {
      const streamChannel = getStreamChannel()
      return {
        push: (targetSessionId, chunk) => streamChannel.push(targetSessionId, chunk),
      }
    },
    store: {
      addMessageStep: store.addMessageStep,
      updateMessageStep: store.updateMessageStep,
      updateSessionContextSize: (targetSessionId, contextSize) =>
        store.updateSessionContextSize(targetSessionId, contextSize, 'provider-finish'),
      updateMessageSkill: store.updateMessageSkill,
    },
    debugStream: shouldTraceStream,
  })
}

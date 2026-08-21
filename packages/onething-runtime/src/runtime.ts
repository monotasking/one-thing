import {
  CoreStreamEngine,
  type CoreEventBusEmitterLike,
  type CoreStreamEngineRuntime,
} from '@onething/core/engine'
import type { StreamChunkBase } from '@onething/core/events'
import type {
  CoreConversationRuntime,
  CoreSessionRuntime,
  CoreStreamChannelLike,
} from '@onething/core/gateway-runtime'
import {
  createOnethingConversationRuntimeFromStreamEngine,
} from './gateway-runtime.js'
import {
  NoopOnethingStreamSender,
  type OnethingStreamSender,
} from './stream-sender.js'
import {
  createOnethingStreamEngineRuntime,
  type OnethingStreamRuntimeOptions,
} from './stream-runtime.js'

export interface OnethingRuntime<
  TEventBus extends CoreEventBusEmitterLike = CoreEventBusEmitterLike,
  TSender extends OnethingStreamSender = OnethingStreamSender,
  TChunk extends StreamChunkBase = StreamChunkBase,
  TEngine extends CoreStreamEngine<TEventBus, TSender> = CoreStreamEngine<TEventBus, TSender>,
> {
  eventBus: TEventBus
  streamChannel: CoreStreamChannelLike<TChunk>
  streamRuntime: CoreStreamEngineRuntime
  engine: TEngine
  sender: TSender
  conversationRuntime: CoreConversationRuntime<TChunk>
  shutdown(): void
}

export interface OnethingRuntimeFromStreamRuntimeOptions<
  TEventBus extends CoreEventBusEmitterLike = CoreEventBusEmitterLike,
  TSender extends OnethingStreamSender = OnethingStreamSender,
  TChunk extends StreamChunkBase = StreamChunkBase,
  TEngine extends CoreStreamEngine<TEventBus, TSender> = CoreStreamEngine<TEventBus, TSender>,
> {
  streamRuntime: CoreStreamEngineRuntime
  eventBus: TEventBus
  streamChannel: CoreStreamChannelLike<TChunk>
  sender?: TSender
  createEngine?: (streamRuntime: CoreStreamEngineRuntime) => TEngine
  sessionRuntime?: CoreSessionRuntime
  bindEventBus?: boolean
}

export interface OnethingRuntimeOptions<
  TSettings = unknown,
  TMessage = unknown,
  TSession = unknown,
  TProviderConfig = unknown,
  TAuthContext = unknown,
  TSkill = unknown,
  TContentPart = unknown,
  TAttachment = unknown,
  THistoryMessage = unknown,
  TStreamResult = unknown,
  TCompactResult = unknown,
  TEventBus extends CoreEventBusEmitterLike = CoreEventBusEmitterLike,
  TSender extends OnethingStreamSender = OnethingStreamSender,
  TChunk extends StreamChunkBase = StreamChunkBase,
  TEngine extends CoreStreamEngine<TEventBus, TSender> = CoreStreamEngine<TEventBus, TSender>,
> extends OnethingStreamRuntimeOptions<
    TSettings,
    TMessage,
    TSession,
    TProviderConfig,
    TAuthContext,
    TSkill,
    TContentPart,
    TAttachment,
    THistoryMessage,
    TStreamResult,
    TCompactResult
  > {
  eventBus: TEventBus
  streamChannel: CoreStreamChannelLike<TChunk>
  sender?: TSender
  createEngine?: (streamRuntime: CoreStreamEngineRuntime) => TEngine
  sessionRuntime?: CoreSessionRuntime
  bindEventBus?: boolean
}

export function createOnethingRuntime<
  TSettings = unknown,
  TMessage = unknown,
  TSession = unknown,
  TProviderConfig = unknown,
  TAuthContext = unknown,
  TSkill = unknown,
  TContentPart = unknown,
  TAttachment = unknown,
  THistoryMessage = unknown,
  TStreamResult = unknown,
  TCompactResult = unknown,
  TEventBus extends CoreEventBusEmitterLike = CoreEventBusEmitterLike,
  TSender extends OnethingStreamSender = OnethingStreamSender,
  TChunk extends StreamChunkBase = StreamChunkBase,
  TEngine extends CoreStreamEngine<TEventBus, TSender> = CoreStreamEngine<TEventBus, TSender>,
>(
  options: OnethingRuntimeOptions<
    TSettings,
    TMessage,
    TSession,
    TProviderConfig,
    TAuthContext,
    TSkill,
    TContentPart,
    TAttachment,
    THistoryMessage,
    TStreamResult,
    TCompactResult,
    TEventBus,
    TSender,
    TChunk,
    TEngine
  >,
): OnethingRuntime<TEventBus, TSender, TChunk, TEngine> {
  const streamRuntime = createOnethingStreamEngineRuntime(options)
  return createOnethingRuntimeFromStreamRuntime({
    streamRuntime,
    eventBus: options.eventBus,
    streamChannel: options.streamChannel,
    sender: options.sender,
    createEngine: options.createEngine,
    sessionRuntime: options.sessionRuntime,
    bindEventBus: options.bindEventBus,
  })
}

export function createOnethingRuntimeFromStreamRuntime<
  TEventBus extends CoreEventBusEmitterLike = CoreEventBusEmitterLike,
  TSender extends OnethingStreamSender = OnethingStreamSender,
  TChunk extends StreamChunkBase = StreamChunkBase,
  TEngine extends CoreStreamEngine<TEventBus, TSender> = CoreStreamEngine<TEventBus, TSender>,
>(
  options: OnethingRuntimeFromStreamRuntimeOptions<TEventBus, TSender, TChunk, TEngine>,
): OnethingRuntime<TEventBus, TSender, TChunk, TEngine> {
  const streamRuntime = options.streamRuntime
  const engine = options.createEngine?.(streamRuntime)
    ?? new CoreStreamEngine<TEventBus, TSender>(streamRuntime) as TEngine
  const sender = options.sender ?? new NoopOnethingStreamSender() as unknown as TSender

  if (options.bindEventBus !== false) {
    engine.setEventBus(options.eventBus)
  }

  const conversationRuntime = createOnethingConversationRuntimeFromStreamEngine<TChunk>({
    engine,
    streamChannel: options.streamChannel,
    sender,
    sessionRuntime: options.sessionRuntime,
    eventBus: options.eventBus,
  })

  return {
    eventBus: options.eventBus,
    streamChannel: options.streamChannel,
    streamRuntime,
    engine,
    sender,
    conversationRuntime,
    shutdown() {
      engine.shutdown()
    },
  }
}

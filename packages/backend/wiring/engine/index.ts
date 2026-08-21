/**
 * StreamEngine — Singleton Access & Lifecycle
 *
 * Provides singleton getter for the StreamEngine, plus init/shutdown
 * functions called from main/index.ts.
 */

import type { StreamChunk } from '@shared/events/index.js'
import type { CoreStreamEngineRuntime as CoreRuntime } from '@onething/core/engine'
import {
  createOnethingRuntimeFromStreamRuntime,
  type OnethingRuntime,
} from '@onething/runtime/runtime'
import type { CoreConversationRuntime } from '@onething/core/gateway-runtime'
import { getEventBus, getStreamChannel } from '../../events/index.js'
import {
  createBoundStreamEngine,
  type StreamEngine,
  type StreamSender,
} from './stream-engine-bound.js'
import {
  createMainStreamEngineRuntime,
} from './stream-engine-runtime.js'
import {
  getSessionManager,
} from '../../session/index.js'
import * as store from '../../store.js'
import {
  getOutboundReplyDispatcher,
  registerChannelPromptContextProvider,
  unregisterChannelPromptContextProvider,
} from '../../channel/index.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('engine.stream')


export type {
  CoreStreamEngineOptions,
  CoreStreamEngineRuntime,
} from '@onething/core/engine'

let streamEngine: StreamEngine | null = null
let onethingRuntime: MainOnethingRuntime | null = null

export type MainOnethingRuntime = OnethingRuntime<
  ReturnType<typeof getEventBus>,
  StreamSender,
  StreamChunk,
  StreamEngine
>

/**
 * Get the singleton StreamEngine instance.
 * Throws if called before initializeStreamEngine().
 */
export function getStreamEngine(): StreamEngine {
  if (!streamEngine) {
    throw new Error('[StreamEngine] Not initialized. Call initializeStreamEngine() first.')
  }
  return streamEngine
}

/**
 * Get the StreamEngine if initialized, or null.
 * Safe to call during shutdown when engine may already be destroyed.
 */
export function getStreamEngineSafe(): StreamEngine | null {
  return streamEngine
}

export function getOnethingRuntime(): MainOnethingRuntime {
  if (!onethingRuntime) {
    throw new Error('[OnethingRuntime] Not initialized. Call initializeStreamEngine() after initializeEventSystem().')
  }
  return onethingRuntime
}

export function getConversationRuntime(): CoreConversationRuntime<StreamChunk> {
  return getOnethingRuntime().conversationRuntime
}

/**
 * Initialize the StreamEngine. Called after initializeSessionLayer().
 */
export function initializeStreamEngine(): void {
  if (streamEngine) {
    log.warn('stream engine already initialized')
    return
  }

  const streamRuntime = createMainStreamEngineRuntime()
  registerChannelPromptContextProvider()
  const engine = createBoundStreamEngine(streamRuntime)
  streamEngine = engine

  try {
    onethingRuntime = createOnethingRuntimeFromStreamRuntime<
      ReturnType<typeof getEventBus>,
      StreamSender,
      StreamChunk,
      StreamEngine
    >({
      streamRuntime: streamRuntime as unknown as CoreRuntime,
      eventBus: getEventBus(),
      streamChannel: getStreamChannel(),
      createEngine: () => engine,
      sessionRuntime: {
        ensureSession: sessionId => {
          ensurePersistentGatewaySession(sessionId)
          getSessionManager().getOrCreate(sessionId)
        },
        destroySession: sessionId => {
          getSessionManager().destroySession(sessionId)
        },
        setSessionPermissionMode: (sessionId, mode) => {
          store.updateSessionPermissionMode(sessionId, mode)
        },
      },
    })
  } catch {
    // EventBus may not be initialized yet in test scenarios
  }
  try {
    getOutboundReplyDispatcher().start(getEventBus())
  } catch {
    // EventBus may not be initialized yet in test scenarios
  }
  log.info('stream engine initialized')
}

/**
 * Shut down the StreamEngine. Called from app.on('before-quit').
 */
export function shutdownStreamEngine(): void {
  if (streamEngine) {
    getOutboundReplyDispatcher().stop()
    unregisterChannelPromptContextProvider()
    streamEngine.shutdown()
    streamEngine = null
  }
  onethingRuntime = null
}

// Re-export for direct use
export type { StreamEngine } from './stream-engine-bound.js'

function ensurePersistentGatewaySession(sessionId: string): void {
  if (!sessionId.startsWith('gateway:') || store.getSession(sessionId)) return

  const currentSessionId = store.getCurrentSessionId()
  store.createSession(sessionId, createGatewaySessionName(sessionId))
  if (currentSessionId) {
    store.setCurrentSessionId(currentSessionId)
  }
}

function createGatewaySessionName(sessionId: string): string {
  const [, channelId, userId] = /^gateway:([^:]+):(.+)$/.exec(sessionId) ?? []
  if (!channelId || !userId) return sessionId

  const channelName = channelId === 'wechat' ? 'WeChat' : channelId
  return `${channelName} - ${userId}`
}

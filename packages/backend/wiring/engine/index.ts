/**
 * StreamEngine — 纯工厂 + 当前实例的访问器
 *
 * A2(`docs/design/backend-composition-root-2026-09.md` §2.2)之后这里没有模块级
 * `let`:`createStreamEngineLayer()` 造引擎与 runtime 并把它这一层留下的尾巴
 * (出站派发器的 start、频道提示词供给的注册)收进返回的 `dispose`;
 * `getStreamEngine()` 等四个访问器读进程当前实例。
 */

import type { StreamChunk } from '@shared/events/index.js'
import type { CoreStreamEngineRuntime as CoreRuntime } from '@onething/core/engine'
import {
  createOnethingRuntimeFromStreamRuntime,
  type OnethingRuntime,
} from '@onething/runtime/runtime'
import type { CoreConversationRuntime } from '@onething/core/gateway-runtime'
import type { EventBus } from '../../events/event-bus.js'
import type { StreamChannel } from '../../events/stream-channel.js'
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
  ensureSessionWritable,
} from '../../session/index.js'
import * as store from '../../store.js'
import {
  OutboundReplyDispatcher,
  registerChannelPromptContextProvider,
  unregisterChannelPromptContextProvider,
} from '../../channel/index.js'
import { getCurrentBackend, getCurrentBackendSafe } from '../../current.js'
import { getLogger } from '../logging/index.js'
import { DEFAULT_SESSION_OWNER, sessionAccess } from '../../session/access.js'
import { fixedExecutionContext } from './execution-context.js'

const log = getLogger('engine.stream')


export type MainOnethingRuntime = OnethingRuntime<
  EventBus,
  StreamSender,
  StreamChunk,
  StreamEngine
>

/**
 * Get the singleton StreamEngine instance.
 * Throws if no backend is assembled (or assembly has not reached the engine yet).
 */
export function getStreamEngine(): StreamEngine {
  return getCurrentBackend('engine').engine
}

/**
 * Get the StreamEngine if available, or null.
 * Safe to call during shutdown when the engine may already be destroyed.
 */
export function getStreamEngineSafe(): StreamEngine | null {
  const handle = getCurrentBackendSafe()
  if (!handle) return null
  try {
    return handle.engine
  } catch {
    return null
  }
}

export function getOnethingRuntime(): MainOnethingRuntime {
  return getCurrentBackend('runtime').runtime
}

export function getConversationRuntime(): CoreConversationRuntime<StreamChunk> {
  return getOnethingRuntime().conversationRuntime
}

/**
 * 造引擎层。纯工厂:造完把引擎、runtime 与**它自己留下的收尾**一起交出去。
 *
 * 两件尾巴写在这里而不是散在关机链上:频道提示词供给是这一层注册的,出站回复
 * 派发器是这一层 start 的 —— 起它的那一行与关它的那一行因此看得见彼此。
 *
 * `runtime` 与派发器两处 try/catch 保持 A2 之前的形状:上游单测把事件系统整个
 * mock 成空对象,那种场景下这两步失败是预期的,而引擎本身照样要交得出来。
 */
export function createStreamEngineLayer(deps: {
  eventBus: EventBus
  streamChannel: StreamChannel
  assertAccepting?: (sessionId?: string) => void
}): {
  engine: StreamEngine
  runtime: MainOnethingRuntime | undefined
  quiesceOutboundReplies: () => void
  drainOutboundReplies: () => Promise<void>
  dispose: () => Promise<void>
} {
  const streamRuntime = createMainStreamEngineRuntime()
  registerChannelPromptContextProvider()
  const engine = createBoundStreamEngine(streamRuntime, deps.assertAccepting, ensureSessionWritable,
    (sessionId, executionContext) => sessionAccess.resolve(fixedExecutionContext(executionContext), sessionId, 'write'))

  let runtime: MainOnethingRuntime | undefined
  try {
    runtime = createOnethingRuntimeFromStreamRuntime<
      EventBus,
      StreamSender,
      StreamChunk,
      StreamEngine
    >({
      streamRuntime: streamRuntime as unknown as CoreRuntime,
      eventBus: deps.eventBus,
      streamChannel: deps.streamChannel,
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
          sessionAccess.resolve(DEFAULT_SESSION_OWNER, sessionId, 'permission')
          store.updateSessionPermissionMode(sessionId, mode)
        },
      },
    })
  } catch {
    // EventBus may not be initialized yet in test scenarios
  }
  const outboundReplies = new OutboundReplyDispatcher()
  try {
    outboundReplies.start(deps.eventBus)
  } catch {
    // EventBus may not be initialized yet in test scenarios
  }
  log.info('stream engine initialized')

  let disposed = false
  return {
    engine,
    runtime,
    quiesceOutboundReplies: () => outboundReplies.quiesce(),
    drainOutboundReplies: () => outboundReplies.drain(),
    dispose: async () => {
      if (disposed) return
      disposed = true
      await outboundReplies.stop()
      unregisterChannelPromptContextProvider()
      engine.shutdown()
    },
  }
}

function ensurePersistentGatewaySession(sessionId: string): void {
  if (!sessionId.startsWith('gateway:')) return
  // Gateway currently serves one local operator. IM identities are message
  // origins, not product-account principals.
  if (store.getSession(sessionId)) {
    sessionAccess.resolve(DEFAULT_SESSION_OWNER, sessionId, 'write')
    return
  }

  const currentSessionId = store.getCurrentSessionId()
  store.createSession(sessionId, createGatewaySessionName(sessionId), { initialOwner: DEFAULT_SESSION_OWNER })
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

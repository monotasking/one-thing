/**
 * Event System — Singleton Access & Lifecycle
 *
 * Provides singleton getters for EventBus and StreamChannel,
 * plus init/shutdown functions called from main/index.ts.
 *
 * Usage:
 *   import { getEventBus, getStreamChannel } from './index.js'
 *   const bus = getEventBus()
 *   bus.emit(sessionId, { type: 'stream:start', assistantMessageId })
 */

import { getLogger } from '../wiring/logging/index.js'
import { EventBus } from './event-bus.js'
import { StreamChannel } from './stream-channel.js'

const log = getLogger('app.events')

let eventBus: EventBus | null = null
let streamChannel: StreamChannel | null = null

/**
 * Get the singleton EventBus instance.
 * Throws if called before initializeEventSystem().
 */
export function getEventBus(): EventBus {
  if (!eventBus) {
    throw new Error('[EventSystem] EventBus not initialized. Call initializeEventSystem() first.')
  }
  return eventBus
}

/**
 * 事件系统立起来了没有 —— 给那些**"有就发,没有就算了"**的产地用。
 *
 * 第一个用户是删会话的推送(`stores/sessions.ts`):删会话在没装配事件系统的
 * 进程里(轻量单测、脚本)照样得能删,而 `getEventBus()` 那一声 throw 会被
 * try/catch 吞掉、留下一行没人需要的 warn。问一句比事后吞一个异常干净。
 */
export function isEventSystemInitialized(): boolean {
  return eventBus !== null
}

/**
 * Get the singleton StreamChannel instance.
 * Throws if called before initializeEventSystem().
 */
export function getStreamChannel(): StreamChannel {
  if (!streamChannel) {
    throw new Error('[EventSystem] StreamChannel not initialized. Call initializeEventSystem() first.')
  }
  return streamChannel
}

/**
 * Initialize the event system. Called once from app.on('ready').
 */
export function initializeEventSystem(): void {
  if (eventBus) {
    log.warn('event system already initialized')
    return
  }

  eventBus = new EventBus()
  streamChannel = new StreamChannel()

  log.info('event system initialized')
}

/**
 * Shut down the event system. Called from app.on('before-quit').
 */
export function shutdownEventSystem(): void {
  if (eventBus) {
    eventBus.shutdown()
    eventBus = null
  }
  if (streamChannel) {
    streamChannel.shutdown()
    streamChannel = null
  }

  log.info('event system shut down')
}

// Re-export classes for direct use in tests
export { EventBus } from './event-bus.js'
export { StreamChannel } from './stream-channel.js'
export { RingBuffer } from './ring-buffer.js'

import { afterEach, describe, expect, it } from 'vitest'
// D191:会话层收的是装配造的会话总线与通道(泛型基类钉死消息类型的子类),这里造的就是它们。
import { EventBus, StreamChannel } from '@onething/backend/event'
import {
  getCoreSessionManager,
  initializeCoreSessionLayer,
  isCoreSessionLayerInitialized,
  shutdownCoreSessionLayer,
} from '@onething/backend/session'

describe('core session lifecycle', () => {
  afterEach(() => {
    shutdownCoreSessionLayer()
  })

  it('initializes and reuses the singleton SessionManager', () => {
    const eventBus = new EventBus()
    const streamChannel = new StreamChannel()

    expect(isCoreSessionLayerInitialized()).toBe(false)

    const manager = initializeCoreSessionLayer(eventBus, streamChannel)

    expect(isCoreSessionLayerInitialized()).toBe(true)
    expect(getCoreSessionManager()).toBe(manager)
    expect(initializeCoreSessionLayer(eventBus, streamChannel)).toBe(manager)
  })

  it('throws before initialization and clears on shutdown', () => {
    expect(() => getCoreSessionManager()).toThrow(
      '[CoreSession] SessionManager not initialized. Call initializeCoreSessionLayer() first.'
    )

    initializeCoreSessionLayer(new EventBus(), new StreamChannel())
    shutdownCoreSessionLayer()

    expect(isCoreSessionLayerInitialized()).toBe(false)
    expect(() => getCoreSessionManager()).toThrow(
      '[CoreSession] SessionManager not initialized. Call initializeCoreSessionLayer() first.'
    )
  })
})

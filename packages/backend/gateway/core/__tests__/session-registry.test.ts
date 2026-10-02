import { describe, expect, it, vi } from 'vitest'
import { GatewaySessionRegistry } from '../session-registry.js'

describe('GatewaySessionRegistry', () => {
  it('maps channel users to onething runtime sessions', () => {
    const runtime = {
      ensureSession: vi.fn(),
      destroySession: vi.fn(),
    }
    const registry = new GatewaySessionRegistry(runtime, { inactiveTtlMs: 100 })

    const first = registry.getOrCreate('wechat', 'user-1')
    const second = registry.getOrCreate('wechat', 'user-1')

    expect(first.coreSessionId).toBe('gateway:wechat:user-1')
    expect(second.coreSessionId).toBe(first.coreSessionId)
    expect(runtime.ensureSession).toHaveBeenCalledTimes(2)
    expect(runtime.ensureSession).toHaveBeenCalledWith('gateway:wechat:user-1')

    expect(registry.cleanup(first.lastActiveAt + 101)).toBe(1)
    expect(runtime.destroySession).toHaveBeenCalledWith('gateway:wechat:user-1')
  })

  it('can switch a channel user to a new active onething session', () => {
    const runtime = {
      ensureSession: vi.fn(),
      destroySession: vi.fn(),
    }
    const registry = new GatewaySessionRegistry(runtime)

    const first = registry.getOrCreate('wechat', 'user-1')
    const next = registry.startNewSession('wechat', 'user-1')
    const active = registry.getOrCreate('wechat', 'user-1')

    expect(first.coreSessionId).toBe('gateway:wechat:user-1')
    expect(next.coreSessionId).toBe('gateway:wechat:user-1:session-2')
    expect(active.coreSessionId).toBe(next.coreSessionId)
    expect(runtime.ensureSession).toHaveBeenCalledWith('gateway:wechat:user-1:session-2')
  })

  it('starts a distinct new session even when no active in-memory binding exists', () => {
    const runtime = {
      ensureSession: vi.fn(),
      destroySession: vi.fn(),
    }
    const registry = new GatewaySessionRegistry(runtime)

    const session = registry.startNewSession('wechat', 'user-1')

    expect(session.coreSessionId).toBe('gateway:wechat:user-1:session-2')
    expect(registry.getOrCreate('wechat', 'user-1').coreSessionId).toBe(session.coreSessionId)
  })
})

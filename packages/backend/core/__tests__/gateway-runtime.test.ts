import { describe, expect, it, vi } from 'vitest'
import {
  isCoreConversationRuntime,
  isCoreTextStreamChunk,
} from '../gateway-runtime.js'

describe('gateway runtime protocol', () => {
  it('recognizes text stream chunks in core', () => {
    expect(isCoreTextStreamChunk({ type: 'text-delta', text: 'hello' })).toBe(true)
    expect(isCoreTextStreamChunk({ type: 'text-delta', text: 42 })).toBe(false)
    expect(isCoreTextStreamChunk({ type: 'reasoning-delta', text: 'hello' })).toBe(false)
  })

  it('validates conversation runtime adapter shape in core', () => {
    const runtime = {
      ensureSession: vi.fn(),
      destroySession: vi.fn(),
      sendMessage: vi.fn(),
      streamChannel: {
        subscribe: vi.fn(),
      },
    }

    expect(isCoreConversationRuntime(runtime)).toBe(true)
    expect(isCoreConversationRuntime({
      ...runtime,
      permissions: {
        onPermissionRequest: vi.fn(),
        respondPermission: vi.fn(),
        setSessionPermissionMode: vi.fn(),
      },
    })).toBe(true)
    expect(isCoreConversationRuntime({ ...runtime, streamChannel: {} })).toBe(false)
    expect(isCoreConversationRuntime({ ...runtime, sendMessage: undefined })).toBe(false)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/ipc'
import { IPCBridge } from '../ipc-bridge'
import {
  appendStreamBufferChunk,
  createStreamBuffer,
  drainStreamBuffer,
} from '@onething/backend/events/stream-coalescer.js'

describe('IPCBridge stream buffer', () => {
  it('preserves reasoning before text while merging adjacent reasoning chunks', () => {
    const buffer = createStreamBuffer()

    appendStreamBufferChunk(buffer, { type: 'reasoning-delta', reasoning: 'think ' })
    appendStreamBufferChunk(buffer, { type: 'reasoning-delta', reasoning: 'more' })
    appendStreamBufferChunk(buffer, { type: 'text-delta', text: 'answer' })

    expect(drainStreamBuffer(buffer)).toEqual([
      { type: 'reasoning-delta', reasoning: 'think more' },
      { type: 'text-delta', text: 'answer' },
    ])
  })

  it('preserves text reasoning text order without cross-type merging', () => {
    const buffer = createStreamBuffer()

    appendStreamBufferChunk(buffer, { type: 'text-delta', text: 'a' })
    appendStreamBufferChunk(buffer, { type: 'reasoning-delta', reasoning: 'b' })
    appendStreamBufferChunk(buffer, { type: 'text-delta', text: 'c' })

    expect(drainStreamBuffer(buffer)).toEqual([
      { type: 'text-delta', text: 'a' },
      { type: 'reasoning-delta', reasoning: 'b' },
      { type: 'text-delta', text: 'c' },
    ])
  })

  it('does not merge non-adjacent chunks of the same type', () => {
    const buffer = createStreamBuffer()

    appendStreamBufferChunk(buffer, { type: 'text-delta', text: 'a' })
    appendStreamBufferChunk(buffer, { type: 'reasoning-delta', reasoning: 'b' })
    appendStreamBufferChunk(buffer, { type: 'text-delta', text: 'c' })

    const chunks = drainStreamBuffer(buffer)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toEqual({ type: 'text-delta', text: 'a' })
    expect(chunks[2]).toEqual({ type: 'text-delta', text: 'c' })
  })

  it('does not merge adjacent text chunks from different turns', () => {
    const buffer = createStreamBuffer()

    appendStreamBufferChunk(buffer, { type: 'text-delta', text: 'before', turnIndex: 1 })
    appendStreamBufferChunk(buffer, { type: 'text-delta', text: 'after', turnIndex: 2 })

    expect(drainStreamBuffer(buffer)).toEqual([
      { type: 'text-delta', text: 'before', turnIndex: 1 },
      { type: 'text-delta', text: 'after', turnIndex: 2 },
    ])
  })

  it('does not merge adjacent reasoning chunks with different placements', () => {
    const buffer = createStreamBuffer()

    appendStreamBufferChunk(buffer, { type: 'reasoning-delta', reasoning: 'top', placement: 'top' })
    appendStreamBufferChunk(buffer, { type: 'reasoning-delta', reasoning: 'inline', placement: 'inline' })

    expect(drainStreamBuffer(buffer)).toEqual([
      { type: 'reasoning-delta', reasoning: 'top', placement: 'top' },
      { type: 'reasoning-delta', reasoning: 'inline', placement: 'inline' },
    ])
  })

  it('merges only adjacent tool input chunks for the same tool call id', () => {
    const buffer = createStreamBuffer()

    appendStreamBufferChunk(buffer, { type: 'tool-input-delta', toolCallId: 'a', argsTextDelta: '{"x"' })
    appendStreamBufferChunk(buffer, { type: 'tool-input-delta', toolCallId: 'a', argsTextDelta: ':1}' })
    appendStreamBufferChunk(buffer, { type: 'tool-input-delta', toolCallId: 'b', argsTextDelta: '{"y":2}' })
    appendStreamBufferChunk(buffer, { type: 'tool-input-delta', toolCallId: 'a', argsTextDelta: '{"z":3}' })

    expect(drainStreamBuffer(buffer)).toEqual([
      { type: 'tool-input-delta', toolCallId: 'a', argsTextDelta: '{"x":1}' },
      { type: 'tool-input-delta', toolCallId: 'b', argsTextDelta: '{"y":2}' },
      { type: 'tool-input-delta', toolCallId: 'a', argsTextDelta: '{"z":3}' },
    ])
  })

  it('clears chunks after draining', () => {
    const buffer = createStreamBuffer()
    appendStreamBufferChunk(buffer, { type: 'text-delta', text: 'a' })

    expect(drainStreamBuffer(buffer)).toEqual([{ type: 'text-delta', text: 'a' }])
    expect(drainStreamBuffer(buffer)).toEqual([])
  })

  it('flushes buffered tool input before permission request events', () => {
    const bridge = new IPCBridge() as any
    const sent: Array<{ channel: string; payload: any }> = []
    bridge.sender = {
      isDestroyed: () => false,
      send: vi.fn((channel: string, payload: any) => {
        sent.push({ channel, payload })
      }),
    }
    bridge.coalescer.start('s1', 'm1')
    bridge.coalescer.handleChunk('s1', {
      type: 'tool-input-delta',
      toolCallId: 'tc1',
      argsTextDelta: '{"path":"a',
    })

    bridge.handleSessionEvent({
      sessionId: 's1',
      sequence: 1,
      timestamp: 0,
      event: {
        type: 'permission:request',
        requestId: 'p1',
        targetChannel: 'ipc',
        toolCallId: 'tc1',
        messageId: 'm1',
        permissionType: 'file_edit',
        title: 'Edit a',
        metadata: {},
      },
    })

    expect(sent.map(item => item.channel)).toEqual([
      IPC_CHANNELS.SESSION_STREAM,
      IPC_CHANNELS.SESSION_EVENT,
    ])
    expect(sent[0].payload.chunk).toEqual({
      type: 'tool-input-delta',
      toolCallId: 'tc1',
      argsTextDelta: '{"path":"a',
      messageId: 'm1',
    })
    expect(sent[1].payload.event.type).toBe('permission:request')
  })
})

/**
 * 通知类事件的投递面(R5 评审 A3)。
 *
 * 设置窗是独立的 BrowserWindow。插件通知只发给"绑定的那个 sender"的话,用户在
 * 设置窗启停一个插件,主窗的面板导航收不到任何信号,于是停在陈旧状态,点开报
 * "not active"。会话事件与流块不同 —— 它们只与主窗有关,继续走单窗口。
 */
describe('IPCBridge notification fan-out', () => {
  function globalBusStub() {
    const globalHandlers = new Map<string, (envelope: unknown) => void>()
    return {
      bus: {
        onAnySessionAny: () => () => {},
        onGlobal: (type: string, handler: (envelope: unknown) => void) => {
          globalHandlers.set(type, handler)
          return () => globalHandlers.delete(type)
        },
      },
      emitGlobal(type: string, event: unknown) {
        globalHandlers.get(type)?.({ event })
      },
    }
  }

  function sender() {
    return { isDestroyed: () => false, send: vi.fn(), on: vi.fn() }
  }

  it('broadcasts plugin notifications to every window, not just the bound one', async () => {
    const events = await import('@onething/backend/events/index.js')
    const stub = globalBusStub()
    vi.spyOn(events, 'getEventBus').mockReturnValue(stub.bus as never)

    const broadcast = vi.fn()
    const bridge = new IPCBridge({ broadcast })
    bridge.bind(sender() as never)

    const notification = { type: 'plugin:notification', pluginId: 'log-monitor', message: 'x', level: 'info' }
    stub.emitGlobal('plugin:notification', notification)

    expect(broadcast).toHaveBeenCalledWith(IPC_CHANNELS.PLUGINS_NOTIFICATION, notification)
    bridge.unbind()
    vi.restoreAllMocks()
  })

  it('falls back to the bound sender when no broadcaster is wired (headless/tests)', async () => {
    const events = await import('@onething/backend/events/index.js')
    const stub = globalBusStub()
    vi.spyOn(events, 'getEventBus').mockReturnValue(stub.bus as never)

    const bound = sender()
    const bridge = new IPCBridge()
    bridge.bind(bound as never)

    stub.emitGlobal('plugin:notification', { type: 'plugin:notification', pluginId: 'p', message: 'm', level: 'info' })

    expect(bound.send).toHaveBeenCalledWith(IPC_CHANNELS.PLUGINS_NOTIFICATION, expect.objectContaining({ pluginId: 'p' }))
    bridge.unbind()
    vi.restoreAllMocks()
  })
})

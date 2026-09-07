import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../events/event-bus.js'
import { inspectStoreLock, StoreLock } from '@onething/runtime/storage'
import type { ChatMessage } from '@shared/ipc.js'
import { BackendResources } from '../../lifecycle.js'
import { configureIMConnectorHooks, registerIMConnector } from '../connector-registry.js'
import { createChannelReplyDeliveryStore } from '../identity-store.js'
import { OutboundReplyDispatcher } from '../outbound-reply-dispatcher.js'

vi.mock('../../wiring/logging/index.js', () => ({ writeAppLog: vi.fn(), getLogger: () => ({ error: vi.fn() }) }))

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function message(id = 'reply'): ChatMessage {
  return {
    id, role: 'assistant', content: 'completed answer', timestamp: 1,
    origin: { transport: 'im', source: 'test', receivedAt: 1, replyTarget: { connector: 'deferred-test', externalConversationId: 'room' } },
  }
}

let root: string
let previous: string | undefined
let unregister: () => void
let bus: EventBus
let gate: ReturnType<typeof deferred>
let dispatcher: OutboundReplyDispatcher
let sent: ReturnType<typeof vi.fn<() => Promise<void>>>

beforeEach(() => {
  previous = process.env.ONETHING_STORE_PATH
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-owner-'))
  process.env.ONETHING_STORE_PATH = path.join(root, 'a')
  gate = deferred()
  sent = vi.fn(() => gate.promise)
  unregister = registerIMConnector({ id: 'deferred-test', sendReply: sent, normalizeIncoming: async () => { throw new Error('unused') } }, { ownerPluginId: 'plugin-a' })
  bus = new EventBus()
  dispatcher = new OutboundReplyDispatcher()
  dispatcher.start(bus)
})

afterEach(async () => {
  gate.resolve()
  await dispatcher.stop().catch(() => {})
  unregister()
  configureIMConnectorHooks({})
  bus.shutdown()
  if (previous === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previous
  fs.rmSync(root, { recursive: true, force: true })
})

describe('outbound reply ownership', () => {
  it.each(['success', 'failure'] as const)('waits for the real %s and writes only the captured store and hooks', async outcome => {
    const oldHook = vi.fn()
    const newHook = vi.fn()
    configureIMConnectorHooks({ onSendSuccess: oldHook, onSendFailure: oldHook })
    const sending = dispatcher.dispatchMessage('session', message())
    await dispatcher.dispatchMessage('session', message())
    expect(sent).toHaveBeenCalledOnce()
    const closing = dispatcher.stop()
    expect(dispatcher.stop()).toBe(closing)
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    await expect(dispatcher.dispatchMessage('session', message('new'))).rejects.toThrow('not accepting')
    expect(() => dispatcher.start(bus)).toThrow('still draining')

    process.env.ONETHING_STORE_PATH = path.join(root, 'b')
    configureIMConnectorHooks({ onSendSuccess: newHook, onSendFailure: newHook })
    const next = new OutboundReplyDispatcher()
    next.start(bus)
    if (outcome === 'success') gate.resolve()
    else gate.reject(new Error('connector failed'))
    await sending
    await closing
    expect(createChannelReplyDeliveryStore(path.join(root, 'a')).getDelivery('reply')).toMatchObject({ status: outcome === 'success' ? 'sent' : 'failed', ...(outcome === 'failure' ? { error: 'connector failed' } : {}) })
    expect(createChannelReplyDeliveryStore(path.join(root, 'b')).getDelivery('reply')).toBeUndefined()
    expect(oldHook).toHaveBeenCalledOnce()
    expect(newHook).not.toHaveBeenCalled()
    await next.stop()
  })

  it('releases the real store lease even when a non-cooperating send exceeds the total shutdown deadline', async () => {
    const storePath = path.join(root, 'a')
    const lease = new StoreLock({ storePath })
    await lease.acquire('server')
    const resources = new BackendResources(30)
    resources.own(() => lease.release(), 'lease', 'release')
    resources.own(() => dispatcher.quiesce(), 'outboundRepliesAdmission', 'quiesce')
    resources.own(() => dispatcher.drain(), 'outboundRepliesDrain', 'drain')
    const sending = dispatcher.dispatchMessage('session', message())
    try {
      // The send is honestly reported as still pending; the store is not held
      // hostage by it — the process exits right behind this, and a retained
      // lock would only lock the next launch out.
      await expect(resources.dispose()).rejects.toMatchObject({ timedOut: true, pending: expect.arrayContaining(['outboundRepliesDrain']) })
      expect(inspectStoreLock({ storePath }).status).toBe('absent')
      const next = new StoreLock({ storePath })
      await next.acquire('server')
      next.release()
      gate.resolve()
      await sending
      await dispatcher.stop()
      expect(createChannelReplyDeliveryStore(storePath).getDelivery('reply')?.status).toBe('sent')
    } finally { gate.resolve(); await sending; lease.release() }
  })

  it('reports a receipt write failure to shutdown', async () => {
    fs.mkdirSync(path.join(root, 'a', 'channel-identity.json'), { recursive: true })
    const sending = dispatcher.dispatchMessage('session', message())
    gate.resolve()
    await expect(sending).rejects.toThrow()
    await expect(dispatcher.stop()).rejects.toThrow('receipts could not be persisted')
  })
})

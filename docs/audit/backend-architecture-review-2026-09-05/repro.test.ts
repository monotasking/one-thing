/**
 * Architecture review evidence: these tests assert the observed defects.
 * Passing here confirms a defect, not correctness. Run from the repository root:
 * node node_modules/vitest/vitest.mjs run --config docs/audit/backend-architecture-review-2026-09-05/vitest.config.ts
 * All storage is isolated under a temporary ONETHING_STORE_PATH.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventBus } from '@onething/core'
import { emitCoreSessionCommandForIpc } from '../../../packages/core/events/ipc-operations'
import {
  appendSessionLogEvent,
  flushSessionEventLog,
  getSessionEventsLogPath,
  resetSessionEventLogCache,
  SessionEventWriteError,
} from '../../../packages/backend/session/event-log'
import { StoreLock } from '../../../packages/onething-runtime/src/storage/store-lock'
import { createEchoServerBackend, createTestServerRuntime } from '../../../packages/backend/server/__tests__/test-helpers'
import { getCurrentBackendSafe, setCurrentBackend } from '../../../packages/backend/current'
import { registerRouterHandlers, dispatchRpc } from '../../../packages/backend/rpc/registry'
import { sessionCommandRpcHandlers } from '../../../packages/backend/rpc/domains/session-command'
import { sessionCommandRouter } from '../../../packages/shared/ipc/session-command'

let store: string
const cleanup: Array<() => void | Promise<void>> = []

beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-architecture-review-'))
  vi.stubEnv('ONETHING_STORE_PATH', store)
  resetSessionEventLogCache()
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  await flushSessionEventLog()
  resetSessionEventLogCache()
  vi.unstubAllEnvs()
  fs.rmSync(store, { recursive: true, force: true })
})

async function seedLedger(sessionId: string): Promise<string> {
  const file = getSessionEventsLogPath(sessionId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(path.join(path.dirname(file), 'meta.json'), '{}')
  expect(appendSessionLogEvent(sessionId, 'request/end', { requestIndex: 1 })).toBe(1)
  await flushSessionEventLog(sessionId)
  return file
}

it('R2: flush resolves although the latest append failed and the event is absent from disk', async () => {
  const file = await seedLedger('failed-append')
  vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(
    Object.assign(new Error('injected append failure'), { code: 'EIO' }),
  )
  expect(appendSessionLogEvent('failed-append', 'request/end', { requestIndex: 2 })).toBe(2)
  await expect(flushSessionEventLog('failed-append')).resolves.toBeUndefined()
  expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)
  expect(() => appendSessionLogEvent('failed-append', 'request/end', { requestIndex: 3 }))
    .toThrow(SessionEventWriteError)
})

it('R2: flush resolves even when fsync itself rejects', async () => {
  await seedLedger('failed-fsync')
  const sync = vi.fn().mockRejectedValue(Object.assign(new Error('injected fsync failure'), { code: 'EIO' }))
  const close = vi.fn().mockResolvedValue(undefined)
  vi.spyOn(fs.promises, 'open').mockResolvedValueOnce({ sync, close } as never)
  await expect(flushSessionEventLog('failed-fsync')).resolves.toBeUndefined()
  expect(sync).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})

it('R3: a session subscription replays the gap while the default wildcard subscription silently skips it', async () => {
  const backend = await createEchoServerBackend()
  const server = await createTestServerRuntime({ createBackend: async () => backend })
  cleanup.push(() => server.shutdown())
  const created = await server.runtime.sessions.create('replay evidence') as { session: { id: string } }
  const sessionId = created.session.id
  await backend.eventBus.emit(sessionId, { type: 'audit:missed' } as never)
  const specific: string[] = []
  const wildcard: string[] = []
  cleanup.push(server.runtime.events.subscribe(sessionId, envelope => specific.push(envelope.event.type), { afterSeq: 0 }))
  cleanup.push(server.runtime.events.subscribe('*', envelope => wildcard.push(envelope.event.type), { afterSeq: 0 }))
  expect(specific).toContain('audit:missed')
  expect(wildcard).not.toContain('audit:missed')
  await backend.eventBus.emit(sessionId, { type: 'audit:live' } as never)
  expect(wildcard).toContain('audit:live')
})

it('R4: the generic RPC route forwards an unrelated owner abort to the engine', async () => {
  const backend = await createEchoServerBackend()
  const server = await createTestServerRuntime({ createBackend: async () => backend })
  cleanup.push(() => server.shutdown())
  const created = await server.runtime.sessions.create('alice session', { userId: 'alice', workspaceId: 'default' }) as { session: { id: string } }
  const bobList = await server.runtime.sessions.list({ userId: 'bob', workspaceId: 'default' }) as { sessions: Array<{ id: string }> }
  expect(bobList.sessions.some(session => session.id === created.session.id)).toBe(false)
  const previous = getCurrentBackendSafe()
  const abort = vi.fn()
  setCurrentBackend({ eventBus: backend.eventBus, engine: { abort } } as never)
  cleanup.push(() => setCurrentBackend(previous))
  cleanup.push(registerRouterHandlers(sessionCommandRouter, sessionCommandRpcHandlers))
  const result = await dispatchRpc({
    domain: 'session-command', method: 'emit',
    payload: { sessionId: created.session.id, command: { type: 'command:abort' } },
  }, { transport: 'http', ownerUid: 'bob', workspaceId: 'default' })
  expect(result).toEqual({ ok: true, data: { success: true } })
  expect(abort).toHaveBeenCalledWith(created.session.id, 'HTTP abort')
})

it('R1 supplementary: a contender can acquire the lock while the first holder has not written metadata yet', async () => {
  const first = new StoreLock({ storePath: store })
  const second = new StoreLock({ storePath: store })
  cleanup.push(() => first.release(), () => second.release())
  const originalWrite = fs.writeFileSync.bind(fs)
  let contender: Promise<void> | undefined
  // Deterministically model preemption between exclusive create and metadata write.
  vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((...args: Parameters<typeof fs.writeFileSync>) => {
    contender = second.acquire('server')
    return originalWrite(...args)
  })
  await expect(first.acquire('server')).resolves.toBeUndefined()
  expect(contender).toBeDefined()
  await expect(contender).resolves.toBeUndefined()
})

it('R2 supplementary: command success is returned before the async subscriber completes', async () => {
  const bus = new EventBus()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let completed = false
  bus.onAnySessionAny(async () => { await gate; completed = true })
  const result = await emitCoreSessionCommandForIpc({
    eventBus: bus, sessionId: 'receipt', command: { type: 'command:send-message' },
  })
  expect(result.success).toBe(true)
  expect(completed).toBe(false)
  release()
  await gate
  expect(completed).toBe(true)
  bus.shutdown()
})

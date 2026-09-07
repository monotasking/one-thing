import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OnethingRuntimeFacade, RuntimeRequestContext } from '@onething/core'
import { filesRouter } from '@shared/ipc/files.js'
import type { RpcDispatchContext, RpcResponse } from '@shared/ipc/rpc.js'
import { filesRpcHandlers } from '../../rpc/domains/files.js'
import { dispatchRpc, registerRouterHandlers } from '../../rpc/registry.js'
import { configureHostLocalTrust } from '../host-trust.js'
import { createOnethingHttpServer } from '../http.js'
import type { ManagedHttpServer } from '../http-lifecycle.js'
import { createServerRpcDispatchContext, createServerRpcDispatchPorts, type OnethingServerRuntime } from '../runtime.js'
import { createTestServerRuntime } from './test-helpers.js'

const identity: RuntimeRequestContext = { userId: 'alice', workspaceId: 'watch-workspace' }
const authorization = { authorization: 'Bearer synthetic-workspace-watch-token' }
const pathError = 'Workspace watch root must stay inside the workspace sandbox root.'
type Change = { root: string; path: string; eventType: string }

/** Read the real SSE continuously; deadlines only fail missing evidence. */
function collectChanges(response: Response, controller: AbortController) {
  if (!response.body) throw new Error('Workspace event response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: Change[] = []
  const waiting = new Set<{
    path: string
    resolve: (event: Change) => void
    reject: (error: unknown) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  let stopping = false
  let failure: unknown
  let closePromise: Promise<void> | undefined
  const pump = (async () => {
    let buffered = ''
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) {
          if (!stopping) throw new Error('Workspace event stream ended before its owner closed')
          return
        }
        buffered += decoder.decode(next.value, { stream: true })
        for (;;) {
          const boundary = buffered.indexOf('\n\n')
          if (boundary < 0) break
          const frame = buffered.slice(0, boundary)
          buffered = buffered.slice(boundary + 2)
          if (!frame.split('\n').includes('event: workspace:file-changed')) continue
          const data = frame.split('\n').filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart()).join('\n')
          const event = JSON.parse(data) as Change
          events.push(event)
          for (const waiter of waiting) {
            if (waiter.path !== event.path) continue
            waiting.delete(waiter)
            clearTimeout(waiter.timer)
            waiter.resolve(event)
          }
        }
      }
    } catch (error) {
      const cancelled = stopping && controller.signal.aborted && error instanceof Error && error.name === 'AbortError'
      if (!cancelled) { failure = error; throw error }
    } finally {
      reader.releaseLock()
      for (const waiter of waiting) {
        clearTimeout(waiter.timer)
        waiter.reject(failure ?? new Error('Workspace event observer closed'))
      }
      waiting.clear()
    }
  })()
  void pump.catch(() => {})
  return {
    events,
    waitForPath(path: string): Promise<Change> {
      const seen = events.find(event => event.path === path)
      if (seen) return Promise.resolve(seen)
      if (failure) return Promise.reject(failure)
      if (stopping) return Promise.reject(new Error('Workspace event observer is closed'))
      return new Promise((resolve, reject) => {
        const waiter = {
          path, resolve, reject,
          timer: setTimeout(() => {
            waiting.delete(waiter)
            reject(new Error(`No workspace SSE event received for ${path}`))
          }, 10_000),
        }
        waiting.add(waiter)
      })
    },
    close(): Promise<void> {
      if (!closePromise) {
        stopping = true
        controller.abort()
        closePromise = pump
      }
      return closePromise
    },
  }
}

function origin(server: ManagedHttpServer): string {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a listening TCP server')
  return `http://127.0.0.1:${address.port}`
}

async function rpc(server: ManagedHttpServer, method: string, payload: unknown, extra = {}): Promise<RpcResponse> {
  const response = await fetch(`${origin(server)}/api/rpc`, {
    method: 'POST',
    headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ domain: 'files', method, payload, ...extra }),
    signal: AbortSignal.timeout(15_000),
  })
  expect(response.status).toBe(200)
  return response.json() as Promise<RpcResponse>
}

describe('workspace watch ownership across HTTP runtimes', () => {
  let temporaryRoot: string
  let workspaceRoot: string
  let scope: string
  let restoreTrust: () => void
  let unregister: () => void
  const runtimes: OnethingServerRuntime[] = []
  const servers: ManagedHttpServer[] = []
  const controllers: AbortController[] = []
  const observers: ReturnType<typeof collectChanges>[] = []

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'onething-watch-ownership-'))
    workspaceRoot = join(temporaryRoot, 'workspaces')
    scope = createServerRpcDispatchContext(workspaceRoot, identity).sandboxRoot!
    await mkdir(scope, { recursive: true })
    restoreTrust = configureHostLocalTrust(null)
    unregister = registerRouterHandlers(filesRouter, filesRpcHandlers)
  })

  afterEach(async () => {
    // Close admission first, then start all independent cleanup before waiting.
    for (const server of servers) server.stopAccepting()
    const observing = observers.map(observer => observer.close())
    for (const controller of controllers) controller.abort()
    const stopping = runtimes.map(runtime => runtime.shutdown())
    const closing = servers.map(server => server.whenClosed())
    const results = await Promise.allSettled([...observing, ...stopping, ...closing])
    observers.length = 0
    controllers.length = 0
    runtimes.length = 0
    servers.length = 0
    unregister?.()
    restoreTrust?.()
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    // Never delete a directory while an unsuccessful close may still own it.
    if (failures.length) throw new AggregateError(failures, 'Workspace watch test cleanup failed')
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  async function createRuntime(label: string) {
    const storePath = join(temporaryRoot, label)
    const runtime = await createTestServerRuntime({
      workspaceRoot, storePath, dataRoot: storePath, processPorts: 'host',
    })
    runtimes.push(runtime)
    return runtime
  }

  async function listen(runtime: OnethingRuntimeFacade) {
    const server = createOnethingHttpServer({
      runtime, workspaceRoot,
      authToken: 'synthetic-workspace-watch-token',
      defaultUserId: identity.userId,
      defaultWorkspaceId: identity.workspaceId,
    })
    servers.push(server)
    const listening = once(server, 'listening')
    server.listen(0, '127.0.0.1')
    await listening
    return server
  }

  async function subscribe(server: ManagedHttpServer) {
    const controller = new AbortController()
    controllers.push(controller)
    const response = await fetch(`${origin(server)}/api/files/watch/events`, {
      headers: authorization, signal: controller.signal,
    })
    expect(response.status).toBe(200)
    const observer = collectChanges(response, controller)
    observers.push(observer)
    return observer
  }

  it.each(['stop', 'shutdown'] as const)('keeps B live after A %s with the same authenticated scope and root', async operation => {
    const a = await createRuntime('runtime-a')
    const b = await createRuntime('runtime-b')
    const serverA = await listen(a.runtime)
    const serverB = await listen(b.runtime)
    const eventsA = await subscribe(serverA)
    const eventsB = await subscribe(serverB)
    const oldAContext = createServerRpcDispatchContext(workspaceRoot, identity)
    // 端口显式随派发递(工单 4 C3)——`a` 关停之后这份端口仍指着它那台已关闭的监听器,
    // 正是下面那条「关了之后再 watchStart 要答 closed」要的素材。
    const oldAPorts = createServerRpcDispatchPorts(a.runtime.files)
    await expect(rpc(serverA, 'watchStart', { root: scope })).resolves.toEqual({ ok: true, data: { success: true } })
    await expect(rpc(serverB, 'watchStart', { root: scope })).resolves.toEqual({ ok: true, data: { success: true } })

    // Each write happens once, after the production driver's real ready result.
    const initialPath = join(scope, 'both-runtimes.txt')
    await writeFile(initialPath, 'both runtimes own this root\n')
    const initial = await Promise.all([eventsA.waitForPath(initialPath), eventsB.waitForPath(initialPath)])
    expect(initial.map(event => event.root)).toEqual([scope, scope])

    if (operation === 'stop') {
      await expect(rpc(serverA, 'watchStop', { root: scope })).resolves.toEqual({ ok: true, data: { success: true } })
    } else {
      await a.shutdown()
      const restarted = await dispatchRpc({ domain: 'files', method: 'watchStart', payload: { root: scope } }, oldAContext, oldAPorts)
      expect(restarted).toEqual({ ok: true, data: { success: false, error: 'Workspace watches are closed.' } })
      await expect(rpc(serverA, 'watchStart', { root: scope })).resolves.toEqual(restarted)
      const reopenedEvents = await fetch(`${origin(serverA)}/api/files/watch/events`, {
        headers: authorization, signal: AbortSignal.timeout(15_000),
      })
      try {
        // A failed subscription must not first commit SSE's 200/connected frame.
        expect(reopenedEvents.status).toBe(500)
        expect(reopenedEvents.headers.get('content-type')).toContain('application/json')
        await expect(reopenedEvents.json()).resolves.toEqual({ success: false, error: 'Workspace watches are closed.' })
      } finally {
        if (!reopenedEvents.bodyUsed) await reopenedEvents.body?.cancel()
      }
    }

    const remainingPath = join(scope, `only-b-after-${operation}.txt`)
    await writeFile(remainingPath, 'B must retain its own native watcher\n')
    expect(await eventsB.waitForPath(remainingPath)).toMatchObject({ root: scope, path: remainingPath })
    expect(eventsA.events.some(event => event.path === remainingPath)).toBe(false)
    await expect(rpc(serverB, 'watchStop', { root: scope })).resolves.toEqual({ ok: true, data: { success: true } })
  }, 40_000)

  it('rejects an unbound confined HTTP request despite forged context/runtime, after sandbox authorization', async () => {
    const runtime = await createRuntime('no-watch-capability')
    const server = await listen({ ...runtime.runtime, files: undefined })
    const forged = {
      context: { transport: 'ipc', sandboxRoot: '/', files: { startWorkspaceWatch: 'forged' } },
      runtime: { files: { startWorkspaceWatch: 'forged', stopWorkspaceWatch: 'forged' } },
    }
    for (const method of ['watchStart', 'watchStop']) {
      const denied = await rpc(server, method, { root: scope, ...forged }, forged)
      expect(denied).toEqual({
        ok: true, data: { success: false, error: 'Workspace file watching is not available in this runtime.' },
      })
      await expect(rpc(server, method, { root: temporaryRoot, ...forged }, forged)).resolves.toEqual({
        ok: true, data: { success: false, error: pathError },
      })
    }
  })

  it('sends connected before a synchronous initial subscription event without losing the event', async () => {
    const runtime = await createRuntime('synchronous-initial-event')
    const initial: Change = { root: scope, path: join(scope, 'initial.txt'), eventType: 'change' }
    let unsubscribes = 0
    const server = await listen({
      ...runtime.runtime,
      files: {
        subscribeWorkspaceFileChanged(handler, context) {
          expect(context).toMatchObject(identity)
          handler(initial)
          return () => { unsubscribes++ }
        },
      },
    })
    const controller = new AbortController()
    controllers.push(controller)
    const response = await fetch(`${origin(server)}/api/files/watch/events`, {
      headers: authorization, signal: controller.signal,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    if (!response.body) throw new Error('Expected the live workspace SSE response')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const expectedFrame = `event: workspace:file-changed\ndata: ${JSON.stringify(initial)}\n\n`
    let received = ''
    try {
      while (!received.includes(expectedFrame)) {
        const next = await reader.read()
        if (next.done) throw new Error('Synchronous initial event was lost before SSE ended')
        received += decoder.decode(next.value, { stream: true })
      }
      expect(received.startsWith(': connected\n\n')).toBe(true)
      expect(received.indexOf(': connected\n\n')).toBeLessThan(received.indexOf(expectedFrame))
      await reader.cancel()
    } finally {
      reader.releaseLock()
      controller.abort()
    }
    await server.whenClosed()
    expect(unsubscribes).toBe(1)
  }, 15_000)

  it('terminates the real HTTP response and unsubscribes once when a synchronous initial event cannot be encoded', async () => {
    const runtime = await createRuntime('synchronous-invalid-event')
    const circular: Record<string, unknown> = { root: scope, path: join(scope, 'invalid.txt'), eventType: 'change' }
    circular.self = circular
    let subscriptionReturned = false
    let unsubscribes = 0
    const server = await listen({
      ...runtime.runtime,
      files: {
        subscribeWorkspaceFileChanged(handler) {
          handler(circular)
          subscriptionReturned = true
          return () => { unsubscribes++ }
        },
      },
    })
    const controller = new AbortController()
    controllers.push(controller)
    // Either receiving headers or consuming the body may observe socket termination.
    // No client deadline/abort produces the expected failure on this success path.
    await expect(fetch(`${origin(server)}/api/files/watch/events`, {
      headers: authorization, signal: controller.signal,
    }).then(response => response.text())).rejects.toBeInstanceOf(Error)
    expect(controller.signal.aborted).toBe(false)
    expect(subscriptionReturned).toBe(true)
    // Include the response's close callback before counting cleanup invocations.
    await server.whenClosed()
    expect(unsubscribes).toBe(1)
  }, 15_000)

  it('keeps the watch capability out of the dispatch context entirely', async () => {
    // 工单 4 C3:能力走**显式第三参数**,身份走 context。判据因此从「Symbol 挂上去
    // 之后序列化不出来」变成更强的一条:context 里根本没有这一格 —— 它连丢都无从丢起。
    const runtime = await createRuntime('private-binding')
    const context = createServerRpcDispatchContext(workspaceRoot, identity)
    expect(JSON.stringify(context)).not.toContain('startWorkspaceWatch')
    expect(Reflect.ownKeys(context)).toEqual(['transport', 'ownerUid', 'workspaceId', 'sandboxRoot'])
    // 端口自己是一份普通对象:可枚举、说得出类型、spread 得过去。
    const ports = createServerRpcDispatchPorts(runtime.runtime.files)!
    expect(typeof ports.workspaceWatch?.startWorkspaceWatch).toBe('function')
    expect(({ ...ports }).workspaceWatch?.startWorkspaceWatch).toBe(ports.workspaceWatch?.startWorkspaceWatch)
    // 没有 files 的宿主(桌面 / CLI)一格都不注入。
    expect(createServerRpcDispatchPorts(undefined)).toBeUndefined()
  })
})

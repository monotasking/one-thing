/**
 * `createOnethingServerRuntimeOverBackend`(A 期核心接缝,
 * docs/design/one-core-2026-08.md §3)。
 *
 * 守三件事:
 *  1. 适配壳把产品后端映成 server runtime 的底座,`ownsBackend` 决定关不关宿主的引擎。
 *  2. 在一只借来的后端上建出来的门面,与今天 `createDevelopmentOnethingServerRuntime`
 *     建出来的**是同一张面**(方法集合逐字相同)—— 桌面内嵌之后 web 端看到的 API
 *     不能少一块。
 *  3. `processPorts: 'host'` 不改写宿主的单槽端口(todo/scratchpad 是串联而不是覆盖)。
 */
import { EventBus, StreamChannel } from '@onething/core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OnethingBackend } from '../../backend.js'
import {
  configureTodoPlanHost,
  getTodoPlanHostPorts,
} from '../../wiring/todo-plan/store.js'
import {
  createDevelopmentOnethingServerRuntime,
  createOnethingServerRuntimeOverBackend,
  toOnethingServerBackend,
} from '../runtime.js'
import { createTestServerRuntime } from './test-helpers.js'

/**
 * A2:装配产物是一只类实例了(`OnethingBackend`),替身只需要 `toOnethingServerBackend`
 * 真正读的那四格 —— 所以先过 `unknown` 再断言,`as OnethingBackend` 直接断不动
 * (类还带私有字段)。关机口跟着改名成 `dispose`。
 */
function createFakeBackend(): {
  backend: OnethingBackend
  abort: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
} {
  const abort = vi.fn()
  const dispose = vi.fn(async () => {})
  const backend = {
    engine: { abort } as unknown as OnethingBackend['engine'],
    eventBus: new EventBus() as unknown as OnethingBackend['eventBus'],
    streamChannel: new StreamChannel() as unknown as OnethingBackend['streamChannel'],
    dispose,
  } as unknown as OnethingBackend
  return { backend, abort, dispose }
}

describe('toOnethingServerBackend', () => {
  it('reports the real engine as message-persisting and forwards aborts', async () => {
    const { backend, abort } = createFakeBackend()
    const adapted = toOnethingServerBackend(backend)
    expect(adapted.persistsMessages).toBe(true)
    adapted.abortSession('s1')
    expect(abort).toHaveBeenCalledWith('s1', 'server abort')
    adapted.abortSession('s1', 'user pressed stop')
    expect(abort).toHaveBeenCalledWith('s1', 'user pressed stop')
  })

  it('owns the backend by default and lets it go when borrowed', async () => {
    const owned = createFakeBackend()
    await toOnethingServerBackend(owned.backend).shutdown()
    expect(owned.dispose).toHaveBeenCalledTimes(1)

    const borrowed = createFakeBackend()
    await toOnethingServerBackend(borrowed.backend, { ownsBackend: false }).shutdown()
    // 桌面借出来的那只:关 HTTP 面绝不能把宿主的引擎一起关了。
    expect(borrowed.dispose).not.toHaveBeenCalled()
  })
})

describe('createOnethingServerRuntimeOverBackend', () => {
  let storePath: string
  let previousStorePath: string | undefined

  beforeEach(() => {
    previousStorePath = process.env.ONETHING_STORE_PATH
    storePath = mkdtempSync(path.join(tmpdir(), 'onething-over-backend-'))
  })

  afterEach(() => {
    if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = previousStorePath
    rmSync(storePath, { recursive: true, force: true })
  })

  it('builds the same facade surface the development runtime builds', async () => {
    const { backend, dispose } = createFakeBackend()
    const overBackend = await createOnethingServerRuntimeOverBackend(backend, {
      storePath,
      workspaceRoot: path.join(storePath, 'workspaces'),
      dataRoot: storePath,
      processPorts: 'host',
      ownsBackend: false,
    })
    const echoStorePath = mkdtempSync(path.join(tmpdir(), 'onething-echo-'))
    const development = await createTestServerRuntime({
      storePath: echoStorePath,
      workspaceRoot: path.join(echoStorePath, 'workspaces'),
      dataRoot: echoStorePath,
    })
    try {
      const surfaceOf = (runtime: object): string[] =>
        Object.keys(runtime as Record<string, unknown>).sort()
      expect(surfaceOf(overBackend.runtime)).toEqual(surfaceOf(development.runtime))
      expect(overBackend.workspaceRoot).toBe(path.resolve(storePath, 'workspaces'))
    } finally {
      await overBackend.shutdown()
      await development.shutdown()
      rmSync(echoStorePath, { recursive: true, force: true })
    }
    // 借来的后端不被关掉。
    expect(dispose).not.toHaveBeenCalled()
  })

  it('chains the host todo-plan port instead of clobbering it', async () => {
    const hostBroadcast = vi.fn()
    const hostReveal = vi.fn()
    const previous = getTodoPlanHostPorts()
    configureTodoPlanHost({ broadcastChanged: hostBroadcast, revealDirectory: hostReveal })
    const { backend } = createFakeBackend()
    const runtime = await createOnethingServerRuntimeOverBackend(backend, {
      storePath,
      workspaceRoot: path.join(storePath, 'workspaces'),
      dataRoot: storePath,
      processPorts: 'host',
      ownsBackend: false,
    })
    try {
      const chained = getTodoPlanHostPorts()
      expect(chained).not.toBe(previous)
      // 宿主的另一项能力不能在串联里丢掉。
      expect(chained.revealDirectory).toBe(hostReveal)
      chained.broadcastChanged?.({ directory: '/tmp' } as never)
      expect(hostBroadcast).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.shutdown()
    }
    // 关掉之后端口还原成宿主原来那只。
    expect(getTodoPlanHostPorts().broadcastChanged).toBe(hostBroadcast)
    configureTodoPlanHost(previous)
  })
})

describe('createDevelopmentOnethingServerRuntime', () => {
  it('still routes echo/local test backends through the untouched path', async () => {
    const storePath = mkdtempSync(path.join(tmpdir(), 'onething-echo-path-'))
    const runtime = await createDevelopmentOnethingServerRuntime({
      createBackend: async () => {
        const { createEchoServerBackend } = await import('./test-helpers.js')
        return createEchoServerBackend()
      },
      storePath,
      workspaceRoot: path.join(storePath, 'workspaces'),
      dataRoot: storePath,
    })
    try {
      expect(Object.keys(runtime.runtime).length).toBeGreaterThan(0)
      expect(typeof runtime.shutdown).toBe('function')
      expect(runtime.workspaceRoot).toBe(path.resolve(storePath, 'workspaces'))
    } finally {
      await runtime.shutdown()
      rmSync(storePath, { recursive: true, force: true })
    }
  })
})

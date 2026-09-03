/**
 * `createElectronTransport`(C2 结尾补的一格)。
 *
 * 这只文件是全仓**唯一**吃 IPC 桥三条推送订阅、把它们合成一条 `Transport.events()`
 * 的地方 —— 而它此刻在 Vue 生产路径上没有调用点(`services/ipc-hub.ts` 仍然直接骑
 * `platformApi.onSessionEvent` / `onSessionStream`,`platform/electron.ts` 把它们原样
 * 转发给 `electronAPI`,不经过 `client.events`)。C2 迁移批把这份实现落了地,但没有
 * 单元测试钉住它的合流 / 退订语义 —— 真机门(`gate-vue-host.mjs`)证的是「聊天这条链
 * 路整体没坏」,证不到这里,所以这只文件补上「三条推送合流成一条、退订三退三」
 * 这件事本身。
 */
import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/ipc/channels.js'
import type { RpcRequest, RpcResponse } from '@shared/ipc/rpc.js'
import type { HostCapabilities } from '@onething/client'
import { createElectronTransport } from '../electron-transport'

type Listener<T> = (payload: T) => void

function fakeElectronAPI() {
  const sessionEventListeners = new Set<Listener<unknown>>()
  const sessionStreamListeners = new Set<Listener<unknown>>()
  const settingsChangedListeners = new Set<Listener<unknown>>()
  const unsubscribeCalls = { sessionEvent: 0, sessionStream: 0, settingsChanged: 0 }

  const electronAPI = {
    rpcInvoke: vi.fn(async (_request: RpcRequest): Promise<RpcResponse> => ({ ok: true, data: 'ok' })),
    onSessionEvent: (callback: Listener<unknown>) => {
      sessionEventListeners.add(callback)
      return () => {
        sessionEventListeners.delete(callback)
        unsubscribeCalls.sessionEvent += 1
      }
    },
    onSessionStream: (callback: Listener<unknown>) => {
      sessionStreamListeners.add(callback)
      return () => {
        sessionStreamListeners.delete(callback)
        unsubscribeCalls.sessionStream += 1
      }
    },
    onSettingsChanged: (callback: Listener<unknown>) => {
      settingsChangedListeners.add(callback)
      return () => {
        settingsChangedListeners.delete(callback)
        unsubscribeCalls.settingsChanged += 1
      }
    },
  }

  return {
    // 未实现的其余 `ElectronAPI` 面不在这只文件的关心范围内。
    electronAPI: electronAPI as unknown as Parameters<typeof createElectronTransport>[0],
    emitSessionEvent: (payload: unknown) => sessionEventListeners.forEach(cb => cb(payload)),
    emitSessionStream: (payload: unknown) => sessionStreamListeners.forEach(cb => cb(payload)),
    emitSettingsChanged: (payload: unknown) => settingsChangedListeners.forEach(cb => cb(payload)),
    listenerCounts: () => ({
      sessionEvent: sessionEventListeners.size,
      sessionStream: sessionStreamListeners.size,
      settingsChanged: settingsChangedListeners.size,
    }),
    unsubscribeCalls,
    rpcInvokeMock: electronAPI.rpcInvoke,
  }
}

const CAPABILITIES = { localFileSystem: true } as unknown as HostCapabilities

describe('createElectronTransport — invoke / capabilities', () => {
  it('invoke 原样转给 electronAPI.rpcInvoke', async () => {
    const fake = fakeElectronAPI()
    const transport = createElectronTransport(fake.electronAPI, { capabilities: CAPABILITIES })
    const request: RpcRequest = { domain: 'sessions', method: 'create', payload: {} }

    const response = await transport.invoke(request)

    expect(fake.rpcInvokeMock).toHaveBeenCalledWith(request)
    expect(response).toEqual({ ok: true, data: 'ok' })
  })

  it('capabilities 原样交出构造时递进来的静态表 —— 不问服务器', async () => {
    const fake = fakeElectronAPI()
    const transport = createElectronTransport(fake.electronAPI, { capabilities: CAPABILITIES })
    await expect(transport.capabilities()).resolves.toBe(CAPABILITIES)
  })

  it('没有 onConnectionChange —— IPC 桥在渲染进程活着的整个生命期里不会断线重连', () => {
    const fake = fakeElectronAPI()
    const transport = createElectronTransport(fake.electronAPI, { capabilities: CAPABILITIES })
    expect(transport.onConnectionChange).toBeUndefined()
  })
})

describe('createElectronTransport — events() 三条推送合流', () => {
  it('三条各自独立的订阅折成一条 AsyncIterable,贴上 IPC_CHANNELS 里的名字', async () => {
    const fake = fakeElectronAPI()
    const transport = createElectronTransport(fake.electronAPI, { capabilities: CAPABILITIES })
    const seen: Array<{ name: string; data: unknown }> = []

    const iterator = transport.events()[Symbol.asyncIterator]()
    const drain = (async () => {
      for (;;) {
        const { value, done } = await iterator.next()
        if (done) return
        seen.push(value)
        if (seen.length === 3) return
      }
    })()

    // 订阅是同步建的(pump 生成器一启动就订阅三条),给一个微任务 tick 落地。
    await Promise.resolve()
    fake.emitSessionEvent({ sessionId: 's1', sequence: 1 })
    fake.emitSettingsChanged({ theme: 'dark' })
    fake.emitSessionStream({ sessionId: 's1', chunk: { type: 'text-delta' } })

    await drain

    expect(seen).toEqual([
      { name: IPC_CHANNELS.SESSION_EVENT, data: { sessionId: 's1', sequence: 1 } },
      { name: IPC_CHANNELS.SETTINGS_CHANGED, data: { theme: 'dark' } },
      { name: IPC_CHANNELS.SESSION_STREAM, data: { sessionId: 's1', chunk: { type: 'text-delta' } } },
    ])
    // `id` 恒 undefined —— IPC 上没有断线续播这件事(见文件头)。
    for (const event of seen) expect((event as { id?: number }).id).toBeUndefined()
  })

  it('signal abort 之后停止产出新事件,并且三条订阅全部退订', async () => {
    const fake = fakeElectronAPI()
    const transport = createElectronTransport(fake.electronAPI, { capabilities: CAPABILITIES })
    const controller = new AbortController()
    const seen: unknown[] = []

    const iterator = transport.events({ signal: controller.signal })[Symbol.asyncIterator]()
    const pending = iterator.next()
    await Promise.resolve()
    expect(fake.listenerCounts()).toEqual({ sessionEvent: 1, sessionStream: 1, settingsChanged: 1 })

    controller.abort()
    const result = await pending
    expect(result.done).toBe(true)

    // 漏退一条就是「热更 / 换会话之后两份监听同时活着」—— 三条都必须归零。
    expect(fake.listenerCounts()).toEqual({ sessionEvent: 0, sessionStream: 0, settingsChanged: 0 })
    expect(fake.unsubscribeCalls).toEqual({ sessionEvent: 1, sessionStream: 1, settingsChanged: 1 })

    // abort 之后再触发推送,不应该有任何东西被收下(队列已经死了)。
    fake.emitSessionEvent({ sessionId: 'late' })
    expect(seen).toEqual([])
  })

  it('transport.close() 让所有在途的 events() 循环收尾,即使各自的 signal 没断', async () => {
    const fake = fakeElectronAPI()
    const transport = createElectronTransport(fake.electronAPI, { capabilities: CAPABILITIES })

    const iteratorA = transport.events()[Symbol.asyncIterator]()
    const iteratorB = transport.events()[Symbol.asyncIterator]()
    const pendingA = iteratorA.next()
    const pendingB = iteratorB.next()
    await Promise.resolve()

    transport.close()

    expect((await pendingA).done).toBe(true)
    expect((await pendingB).done).toBe(true)
    // 两条独立的 events() 循环各订阅了一次;close() 是传输级别的,两份都要退订。
    expect(fake.unsubscribeCalls).toEqual({ sessionEvent: 2, sessionStream: 2, settingsChanged: 2 })
  })

  it('两条 events() 循环互不影响:一条的 signal abort 不动另一条', async () => {
    const fake = fakeElectronAPI()
    const transport = createElectronTransport(fake.electronAPI, { capabilities: CAPABILITIES })
    const controllerA = new AbortController()

    const iteratorA = transport.events({ signal: controllerA.signal })[Symbol.asyncIterator]()
    const iteratorB = transport.events()[Symbol.asyncIterator]()
    const pendingA = iteratorA.next()
    const nextBPromise = iteratorB.next()
    await Promise.resolve()

    controllerA.abort()
    expect((await pendingA).done).toBe(true)

    fake.emitSessionEvent({ sessionId: 'still-alive' })
    const resultB = await nextBPromise
    expect(resultB).toEqual({
      done: false,
      value: { name: IPC_CHANNELS.SESSION_EVENT, data: { sessionId: 'still-alive' } },
    })

    transport.close()
  })
})

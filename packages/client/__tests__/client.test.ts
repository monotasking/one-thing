// @vitest-environment node
/**
 * 客户端对象 + 内存传输 + 事件枢纽。
 *
 * 内存传输在这里做两件事:当测试替身,以及**证明上层不认识 HTTP** —— 同一批断言
 * 换个传输照样过,那就是"换传输不改上层"的活证据(§4.1)。
 */
import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/ipc/channels.js'
import { sessionsRouter } from '@shared/ipc/sessions.js'
import { settingsRouter } from '@shared/ipc/settings.js'
import { createOnethingClient } from '../client.js'
import { createEventHub } from '../events/subscriptions.js'
import { createMemoryTransport } from '../transport/memory.js'
import { RpcError } from '../rpc/router-client.js'
import type { Transport, TransportEvent } from '../transport/types.js'

/** 等到微任务队列排空 —— 枢纽的泵是异步起的。 */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('createOnethingClient.api', () => {
  it('同一个 router 两次拿到同一个对象(WeakMap 记忆)', () => {
    const client = createOnethingClient({ transport: createMemoryTransport() })
    expect(client.api(sessionsRouter)).toBe(client.api(sessionsRouter))
    client.close()
  })

  it('不同 router 是不同对象;不同 client 之间不共享', () => {
    const a = createOnethingClient({ transport: createMemoryTransport() })
    const b = createOnethingClient({ transport: createMemoryTransport() })
    expect(a.api(sessionsRouter)).not.toBe(a.api(settingsRouter))
    expect(a.api(sessionsRouter)).not.toBe(b.api(sessionsRouter))
    a.close()
    b.close()
  })

  it('域客户端把信封送进传输,失败折成 RpcError', async () => {
    const transport = createMemoryTransport({
      handlers: {
        'sessions.list': () => [{ id: 's1' }],
      },
    })
    const client = createOnethingClient({ transport })
    const sessions = client.api(sessionsRouter)

    await expect(sessions.list({} as never)).resolves.toEqual([{ id: 's1' }])
    expect(transport.calls.at(-1)).toEqual({ domain: 'sessions', method: 'list', payload: {} })

    // 没登记的方法 → `{ok:false}` → RpcError,带 code。
    await expect(sessions.delete({ sessionId: 'x' } as never)).rejects.toBeInstanceOf(RpcError)
    client.close()
  })

  it('没有按域的属性 —— 那是枚举点(§4.2 / 演练第三条)', () => {
    const client = createOnethingClient({ transport: createMemoryTransport() })
    expect(Object.keys(client).sort()).toEqual(['api', 'capabilities', 'close', 'events'])
    client.close()
  })
})

describe('createOnethingClient.capabilities', () => {
  it('记忆一次;refresh 才重新问;失败不粘', async () => {
    let calls = 0
    let fail = true
    const transport: Transport = {
      invoke: async () => ({ ok: true, data: null }),
      // 一条永不产出的流:这一组只测 capabilities,推送面不该掺进来。
      events: () => ({
        [Symbol.asyncIterator]: (): AsyncIterator<TransportEvent> => ({
          next: async () => ({ done: true, value: undefined }),
        }),
      }),
      capabilities: async () => {
        calls += 1
        if (fail) throw new Error('offline')
        return { localFileSystem: true } as never
      },
      close: () => {},
    }
    const client = createOnethingClient({ transport })

    await expect(client.capabilities()).rejects.toThrow('offline')
    // 失败不粘:下一次是真的又问了一遍,而不是永远吐同一个坏答案。
    fail = false
    await expect(client.capabilities()).resolves.toMatchObject({ localFileSystem: true })
    await client.capabilities()
    expect(calls).toBe(2)

    await client.capabilities(true)
    expect(calls).toBe(3)
    client.close()
  })
})

describe('createEventHub', () => {
  it('有订阅者才拉流,最后一个退订就 abort', async () => {
    const opened: AbortSignal[] = []
    const transport: Transport = {
      invoke: async () => ({ ok: true, data: null }),
      // 一条「连上就挂着,直到被 abort 才结束」的流 —— 被测的是枢纽什么时候拉它、
      // 什么时候掐它,所以它自己一条都不发。
      events: options => ({
        [Symbol.asyncIterator]: (): AsyncIterator<TransportEvent> => ({
          next: async () => {
            opened.push(options?.signal as AbortSignal)
            await new Promise<void>(resolve => {
              options?.signal?.addEventListener('abort', () => resolve(), { once: true })
            })
            return { done: true, value: undefined }
          },
        }),
      }),
      capabilities: async () => ({}) as never,
      close: () => {},
    }
    const hub = createEventHub(transport)

    expect(hub.status()).toBe('idle')
    expect(opened).toHaveLength(0)

    const offA = hub.on(IPC_CHANNELS.SESSION_EVENT, () => {})
    const offB = hub.onAny(() => {})
    await settle()
    // 两个订阅者,**一条**流。
    expect(opened).toHaveLength(1)
    expect(hub.status()).toBe('connecting')

    offA()
    await settle()
    expect(opened[0].aborted).toBe(false)

    offB()
    await settle()
    expect(opened[0].aborted).toBe(true)
    expect(hub.status()).toBe('idle')
    hub.close()
  })

  it('按名分发,onAny 收全部;状态走到 live', async () => {
    const transport = createMemoryTransport()
    const hub = createEventHub(transport)
    const named: unknown[] = []
    const all: TransportEvent[] = []
    hub.on(IPC_CHANNELS.SESSION_STREAM, payload => named.push(payload))
    hub.onAny(event => all.push(event))
    await settle()

    transport.emit({ name: IPC_CHANNELS.SESSION_STREAM, data: { sessionId: 's1' } })
    transport.emit({ name: IPC_CHANNELS.SETTINGS_CHANGED, data: { ai: {} } })
    await settle()

    expect(named).toEqual([{ sessionId: 's1' }])
    expect(all.map(event => event.name)).toEqual([
      IPC_CHANNELS.SESSION_STREAM,
      IPC_CHANNELS.SETTINGS_CHANGED,
    ])
    expect(hub.status()).toBe('live')
    hub.close()
    expect(hub.status()).toBe('closed')
  })

  it('一个监听者抛错不带走别人', async () => {
    const transport = createMemoryTransport()
    const logger = { error: vi.fn() }
    const hub = createEventHub(transport, { logger })
    const survived: unknown[] = []
    hub.on(IPC_CHANNELS.SESSION_STREAM, () => { throw new Error('boom') })
    hub.on(IPC_CHANNELS.SESSION_STREAM, payload => survived.push(payload))
    await settle()

    transport.emit({ name: IPC_CHANNELS.SESSION_STREAM, data: 1 })
    await settle()

    expect(survived).toEqual([1])
    expect(logger.error).toHaveBeenCalled()
    hub.close()
  })

  it('退订两次不会把计数扣穿(否则另一个订阅者的流会被误关)', async () => {
    const transport = createMemoryTransport()
    const hub = createEventHub(transport)
    const off = hub.on(IPC_CHANNELS.SESSION_EVENT, () => {})
    const seen: unknown[] = []
    hub.onAny(event => seen.push(event))
    await settle()

    off()
    off()
    await settle()
    transport.emit({ name: IPC_CHANNELS.SESSION_EVENT, data: 'still here' })
    await settle()

    expect(seen).toHaveLength(1)
    hub.close()
  })

  /**
   * C1:自愈传输的断线怎么被看见。
   *
   * HTTP 传输断了自己退避重连,那个 `for await` 从头到尾不结束 —— 只看迭代器
   * 的话 `reconnecting` 永远到不了(真机门证伪过 C0 的注)。所以传输自己报,
   * 枢纽只做翻译。这里的替身就是「一条不会结束、但会说自己断没断」的流。
   */
  it('传输报 retrying → reconnecting;报 open 回来 → connecting(不是 live)', async () => {
    let announce: ((state: 'open' | 'retrying') => void) | undefined
    const emitters: ((event: TransportEvent) => void)[] = []
    const transport: Transport = {
      invoke: async () => ({ ok: true, data: null }),
      events: options => ({
        [Symbol.asyncIterator]: (): AsyncIterator<TransportEvent> => {
          const queue: TransportEvent[] = []
          let wake: (() => void) | undefined
          emitters.push(event => {
            queue.push(event)
            wake?.()
          })
          return {
            next: async () => {
              for (;;) {
                if (options?.signal?.aborted) return { done: true, value: undefined }
                const next = queue.shift()
                if (next) return { done: false, value: next }
                await new Promise<void>(resolve => {
                  wake = resolve
                  options?.signal?.addEventListener('abort', () => resolve(), { once: true })
                })
                wake = undefined
              }
            },
          }
        },
      }),
      capabilities: async () => ({}) as never,
      onConnectionChange: listener => {
        announce = listener
        return () => { announce = undefined }
      },
      close: () => {},
    }

    const hub = createEventHub(transport)
    const seen: string[] = []
    hub.onStatusChange(status => seen.push(status))
    hub.on(IPC_CHANNELS.SESSION_EVENT, () => {})
    await settle()

    announce?.('open')
    emitters.forEach(emit => emit({ name: IPC_CHANNELS.SESSION_EVENT, data: 1 }))
    await settle()
    expect(hub.status()).toBe('live')

    announce?.('retrying')
    expect(hub.status()).toBe('reconnecting')

    // 回来了但还没收到东西 —— 说 connecting,不许谎报 live。
    announce?.('open')
    expect(hub.status()).toBe('connecting')

    emitters.forEach(emit => emit({ name: IPC_CHANNELS.SESSION_EVENT, data: 2 }))
    await settle()
    expect(hub.status()).toBe('live')
    expect(seen).toEqual(['connecting', 'live', 'reconnecting', 'connecting', 'live'])
    hub.close()
  })

  it('传输没有那个可选口时,状态照旧只看迭代器(内存替身一行不用改)', async () => {
    const transport = createMemoryTransport()
    expect(transport.onConnectionChange).toBeUndefined()
    const hub = createEventHub(transport)
    hub.on(IPC_CHANNELS.SESSION_EVENT, () => {})
    await settle()
    expect(hub.status()).toBe('connecting')
    transport.emit({ name: IPC_CHANNELS.SESSION_EVENT, data: null })
    await settle()
    expect(hub.status()).toBe('live')
    transport.close()
    await settle()
    expect(hub.status()).toBe('reconnecting')
    hub.close()
  })

  it('onStatusChange 报状态', async () => {
    const transport = createMemoryTransport()
    const hub = createEventHub(transport)
    const seen: string[] = []
    hub.onStatusChange(status => seen.push(status))
    const off = hub.on(IPC_CHANNELS.SESSION_EVENT, () => {})
    await settle()
    transport.emit({ name: IPC_CHANNELS.SESSION_EVENT, data: null })
    await settle()
    off()
    await settle()

    expect(seen).toEqual(['connecting', 'live', 'idle'])
    hub.close()
  })
})

describe('createMemoryTransport', () => {
  it('同一 tick 里连发两条都收得到(有背压队列,不是"只看最后一条")', async () => {
    const transport = createMemoryTransport()
    const got: TransportEvent[] = []
    const controller = new AbortController()
    const drain = (async () => {
      for await (const event of transport.events({ signal: controller.signal })) {
        got.push(event)
        if (got.length === 3) controller.abort()
      }
    })()
    await settle()
    transport.emit({ name: 'a', data: 1 })
    transport.emit({ name: 'b', data: 2 })
    transport.emit({ name: 'c', data: 3 })
    await drain
    expect(got.map(event => event.name)).toEqual(['a', 'b', 'c'])
  })

  it('close() 让在途的 events() 收尾', async () => {
    const transport = createMemoryTransport()
    const drain = (async () => {
      for await (const _event of transport.events()) { /* 等着 */ }
    })()
    await settle()
    transport.close()
    await expect(drain).resolves.toBeUndefined()
  })
})

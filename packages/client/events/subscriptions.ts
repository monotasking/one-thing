/**
 * 事件枢纽 —— 把**一条**推送流分发给任意多个订阅者(§4.2)。
 *
 * 三条不变式:
 *
 * 1. **一条流,不是每个订阅者一条**。`Transport.events()` 在 HTTP 上是一个真的
 *    SSE 连接;每 `on()` 一次就开一条会把 core 那边的订阅数乘上去(而 core 侧
 *    每条订阅都要过一遍受众判定 —— 09-03 那次 36s 卡死的病根就在"每条分片 ×
 *    每个订阅者")。
 * 2. **有订阅者才拉流**。第一个 `on()` 才连;最后一个退订就 `abort` —— 一个还没
 *    渲染任何东西的壳不该在后台挂一条 SSE。
 * 3. **状态是一格,由这里维护**,不由壳各自猜:`idle`(没人订)→ `connecting`
 *    (拉起来了,还没收到第一条)→ `live` → `reconnecting`(流断了,传输在退避)
 *    → `closed`(`close()` 之后,终态)。React 壳第一批自己维护的那一格搬进来。
 */
import type {
  ClientLogger,
  Transport,
  TransportEvent,
  TransportEvents,
} from '../transport/types.js'

export type EventHubStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed'

export type Unsubscribe = () => void

export interface EventHub {
  on<K extends keyof TransportEvents>(
    name: K,
    callback: (payload: TransportEvents[K]) => void,
  ): Unsubscribe
  /** 每一条,含表里没登记的名字(将来 server 加一条而本包还没跟上时不失聪)。 */
  onAny(callback: (event: TransportEvent) => void): Unsubscribe
  status(): EventHubStatus
  /** 状态那一格变了就叫一声 —— 壳画「重连中」用,不必轮询。 */
  onStatusChange(callback: (status: EventHubStatus) => void): Unsubscribe
  close(): void
}

export interface CreateEventHubOptions {
  /** 第一次连接从这个序号之后续播(冷启动重放)。之后由传输自己按最后一个 id 续。 */
  after?: number
  logger?: ClientLogger
}

export function createEventHub(
  transport: Transport,
  options: CreateEventHubOptions = {},
): EventHub {
  const byName = new Map<string, Set<(payload: never) => void>>()
  const anyListeners = new Set<(event: TransportEvent) => void>()
  const statusListeners = new Set<(status: EventHubStatus) => void>()

  let status: EventHubStatus = 'idle'
  let pump: AbortController | undefined
  let closed = false
  let after = options.after

  const setStatus = (next: EventHubStatus): void => {
    if (status === next) return
    status = next
    for (const listener of [...statusListeners]) listener(next)
  }

  const subscriberCount = (): number => {
    let total = anyListeners.size
    for (const set of byName.values()) total += set.size
    return total
  }

  const deliver = (event: TransportEvent): void => {
    for (const listener of [...anyListeners]) {
      try {
        listener(event)
      } catch (error) {
        options.logger?.error?.('event listener threw', {
          name: event.name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const named = byName.get(event.name)
    if (!named) return
    for (const listener of [...named]) {
      try {
        ;(listener as (payload: unknown) => void)(event.data)
      } catch (error) {
        options.logger?.error?.('event listener threw', {
          name: event.name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const startPump = (): void => {
    if (closed || pump) return
    const controller = new AbortController()
    pump = controller
    setStatus('connecting')
    void (async () => {
      try {
        for await (const event of transport.events({
          ...(after === undefined ? {} : { after }),
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break
          if (typeof event.id === 'number') after = event.id
          setStatus('live')
          deliver(event)
        }
        // `events()` 只有在被 abort / 传输 close 之后才会真的结束 —— 它自己会重连。
        // 走到这里说明流不再产出了,而我们还没被退订:如实说「在重连」。
        if (!controller.signal.aborted && !closed) setStatus('reconnecting')
      } catch (error) {
        if (!controller.signal.aborted && !closed) {
          options.logger?.warn?.('event pump stopped', {
            error: error instanceof Error ? error.message : String(error),
          })
          setStatus('reconnecting')
        }
      } finally {
        if (pump === controller) pump = undefined
      }
    })()
  }

  const stopPumpIfIdle = (): void => {
    if (closed || subscriberCount() > 0) return
    pump?.abort()
    pump = undefined
    setStatus('idle')
  }

  const addNamed = (name: string, callback: (payload: never) => void): Unsubscribe => {
    let set = byName.get(name)
    if (!set) {
      set = new Set()
      byName.set(name, set)
    }
    set.add(callback)
    startPump()
    let done = false
    return () => {
      if (done) return
      done = true
      set.delete(callback)
      if (set.size === 0) byName.delete(name)
      stopPumpIfIdle()
    }
  }

  return {
    on(name, callback) {
      return addNamed(name as string, callback as (payload: never) => void)
    },
    onAny(callback) {
      anyListeners.add(callback)
      startPump()
      let done = false
      return () => {
        if (done) return
        done = true
        anyListeners.delete(callback)
        stopPumpIfIdle()
      }
    },
    status: () => status,
    onStatusChange(callback) {
      statusListeners.add(callback)
      return () => statusListeners.delete(callback)
    },
    close() {
      if (closed) return
      closed = true
      pump?.abort()
      pump = undefined
      byName.clear()
      anyListeners.clear()
      setStatus('closed')
      statusListeners.clear()
    },
  }
}

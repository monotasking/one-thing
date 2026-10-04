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
 *
 *    **`reconnecting` 那一格的产地有两个**(C1 补的第二个):
 *
 *    - 迭代器结束而没人退订 —— 内存替身 `close()` 之后就是这样;
 *    - 传输自己报 `retrying`(`Transport.onConnectionChange`,可选口)。HTTP 传输
 *      是**自愈**的:断了它自己退避重连,那个 `for await` 从头到尾不结束 ——
 *      只看迭代器的话 `reconnecting` 在真机上**永远到不了**(C1 的真机门当场
 *      证伪了 C0 的那句注)。所以断没断由传输说,枢纽只做翻译。
 *      传输没有这个口(内存替身)时退回只看迭代器,一行都不用改。
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
  let offConnection: (() => void) | undefined
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

  /**
   * 传输的两格 → 枢纽的五格。
   *
   * `retrying` → `reconnecting` 一对一。`open` 只在**从 `reconnecting` 回来**时
   * 说话,而且说的是 `connecting` 不是 `live`:新连上的那条流还没交出过一条,
   * 谎报 `live` 会让壳以为一切照旧。第一条到手时 `deliver` 那边自然转 `live`。
   */
  const onTransportConnection = (state: 'open' | 'retrying'): void => {
    if (closed || !pump) return
    if (state === 'retrying') setStatus('reconnecting')
    else if (status === 'reconnecting') setStatus('connecting')
  }

  const startPump = (): void => {
    if (closed || pump) return
    const controller = new AbortController()
    pump = controller
    setStatus('connecting')
    offConnection = transport.onConnectionChange?.(onTransportConnection)
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
        if (pump === controller) {
          pump = undefined
          offConnection?.()
          offConnection = undefined
        }
      }
    })()
  }

  const stopPumpIfIdle = (): void => {
    if (closed || subscriberCount() > 0) return
    pump?.abort()
    pump = undefined
    offConnection?.()
    offConnection = undefined
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
      offConnection?.()
      offConnection = undefined
      byName.clear()
      anyListeners.clear()
      setStatus('closed')
      statusListeners.clear()
    },
  }
}

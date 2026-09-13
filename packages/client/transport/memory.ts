/**
 * 内存传输 —— 测试替身,**同时是「换传输不改上层」的活证据**(§4.1)。
 *
 * 它没有网络、没有 SSE、没有 fetch:一张 `domain.method → handler` 的表 + 一个手动
 * `emit()`。如果哪天上层(域客户端 / 事件枢纽 / 客户端对象)偷偷依赖了 HTTP 的
 * 某个细节,这个实现会立刻编不过或跑不过 —— 那正是我们要的报警。
 */
import type {
  HostCapabilities,
  Transport,
  TransportEvent,
  TransportEventsOptions,
} from './types.js'
import type { RpcRequest, RpcResponse } from '@shared/ipc/rpc.js'

export type MemoryHandler = (payload: unknown, request: RpcRequest) => unknown

export interface MemoryTransportOptions {
  /** `{ 'sessions.list': payload => […] }`。抛出的错会折成 `{ok:false}`。 */
  handlers?: Record<string, MemoryHandler>
  capabilities?: Partial<HostCapabilities>
}

export interface MemoryTransport extends Transport {
  /** 往所有在途的 `events()` 里塞一条。没有消费者时**丢弃**(推送不是队列)。 */
  emit(event: TransportEvent): void
  /** 收到过的每一条 `invoke` 信封,按顺序。 */
  readonly calls: readonly RpcRequest[]
}

const DEFAULT_CAPABILITIES: HostCapabilities = {
  localFileSystem: false,
  workspaceFileSystem: true,
  nativeWindowControls: false,
  shellTools: false,
  clipboardWrite: false,
  desktopWindows: false,
  globalMenuEvents: false,
  // 内存替身没有一台机器可言,所以如实答「不知道」—— 与它把
  // `localFileSystem` 答成 false 是同一句话的两半。
  homeDir: null,
}

interface MemorySubscriber {
  queue: TransportEvent[]
  wake?: () => void
}

class MemoryTransportImpl implements MemoryTransport {
  readonly calls: RpcRequest[] = []
  private readonly options: MemoryTransportOptions
  private readonly subscribers = new Set<MemorySubscriber>()
  private closed = false

  constructor(options: MemoryTransportOptions) {
    this.options = options
  }

  async invoke(request: RpcRequest): Promise<RpcResponse> {
    this.calls.push(request)
    const handler = this.options.handlers?.[`${request.domain}.${request.method}`]
    if (!handler) {
      return {
        ok: false,
        error: {
          message: `No memory handler for ${request.domain}.${request.method}`,
          code: 'UNKNOWN_METHOD',
        },
      }
    }
    try {
      return { ok: true, data: await handler(request.payload, request) }
    } catch (error) {
      return {
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  async capabilities(): Promise<HostCapabilities> {
    return { ...DEFAULT_CAPABILITIES, ...this.options.capabilities }
  }

  events(options: TransportEventsOptions = {}): AsyncIterable<TransportEvent> {
    const subscribers = this.subscribers
    const isClosed = (): boolean => this.closed
    return {
      async *[Symbol.asyncIterator]() {
        // 一个极小的背压队列:`emit` 推进来,迭代器 `next()` 取走;没人取时排队,
        // 免得同一个 tick 里连发两条只有后一条被看见。
        const subscriber: MemorySubscriber = { queue: [] }
        subscribers.add(subscriber)
        const onAbort = (): void => subscriber.wake?.()
        options.signal?.addEventListener('abort', onAbort, { once: true })
        try {
          for (;;) {
            while (subscriber.queue.length > 0) {
              const next = subscriber.queue.shift() as TransportEvent
              if (options.signal?.aborted || isClosed()) return
              yield next
            }
            if (options.signal?.aborted || isClosed()) return
            await new Promise<void>(resolve => { subscriber.wake = resolve })
            subscriber.wake = undefined
          }
        } finally {
          subscribers.delete(subscriber)
          options.signal?.removeEventListener('abort', onAbort)
        }
      },
    }
  }

  emit(event: TransportEvent): void {
    for (const subscriber of [...this.subscribers]) {
      subscriber.queue.push(event)
      subscriber.wake?.()
    }
  }

  /** 在途的 `events()` 循环下一次醒来就会看见 `closed` 并收尾。 */
  close(): void {
    this.closed = true
    for (const subscriber of [...this.subscribers]) subscriber.wake?.()
  }
}

export function createMemoryTransport(
  options: MemoryTransportOptions = {},
): MemoryTransport {
  return new MemoryTransportImpl(options)
}

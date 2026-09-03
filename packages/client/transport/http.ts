/**
 * HTTP/SSE 传输 —— core 那张 `packages/backend/server/http.ts` 的**客户端一端**。
 *
 * 三条路,与 server 逐字对齐(核对日 2026-09-03,C0):
 *
 * | 方法 | 路由 | 认证 |
 * |---|---|---|
 * | `invoke` | `POST /api/rpc`(通用信封,所有域共用这一条) | `Authorization: Bearer` |
 * | `events` | `GET /api/events?after=<seq>` | `Authorization: Bearer` |
 * | `capabilities` | `GET /api/capabilities` | `Authorization: Bearer` |
 *
 * **token 只进 header,永不进 URL**(拍点丙)。server 侧确实还认 `GET /api/events` 的
 * `?token=`,但那条口子是给 Vue 渲染层的 `EventSource` 留的(它带不了 header),
 * 本包不用 `EventSource`,所以不走那条口 —— Vue 退役后 server 那条也删(§9 留账)。
 * query 会进浏览器历史、进代理日志、进 Referer,header 不会。
 *
 * **重连**:`events()` 是一个自愈的 `for await` —— 断了就退避重连,并把最后一个
 * SSE `id` 当 `?after=` 带上。今天只有 `session:event` 盖 id(= 账本 sequence),
 * 所以续播语义精确到"会话事件不丢";`session:stream` 的分片没有序号(它本来就是
 * 会话事件的合批投影,重连后由会话事件补齐),`settings:changed` 不占 seq。
 * 退避基数取服务器自己说的 `retry:`,没说就用 `initialReconnectDelayMs`。
 */
import { parseSseStream } from './sse.js'
import type {
  ClientLogger,
  HostCapabilities,
  Transport,
  TransportConnectionState,
  TransportEvent,
  TransportEventsOptions,
} from './types.js'
import type { RpcRequest, RpcResponse } from '@shared/ipc/rpc.js'

export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<Response>

export interface HttpTransportOptions {
  /** core 的地址,例如 `http://127.0.0.1:53211`。末尾有没有 `/` 都行。 */
  baseUrl: string
  /** Bearer token。loopback 起的 core 每次启动铸一个,由发现文件交下来。 */
  token?: string
  /**
   * 注入的 fetch。缺省用全局的 —— 浏览器、Node 18+、React Native 都有,
   * 这正是本包"双环境"的物质基础。测试注入假的。
   */
  fetch?: FetchLike
  /** 每条请求都带上的额外 header(诊断标记之类)。 */
  headers?: Record<string, string>
  /** 服务器没说 `retry:` 时的重连基数,缺省 1000ms。 */
  initialReconnectDelayMs?: number
  /** 退避上限,缺省 30000ms。 */
  maxReconnectDelayMs?: number
  /** 注入的等待(测试用 fake timers 时喂一个可控的)。缺省 `setTimeout`。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  logger?: ClientLogger
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** `http://host:port` + `/api/x` —— 不产生 `//`,也不吞掉 baseUrl 自带的路径前缀。 */
function joinUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${pathname}`
}

class HttpTransport implements Transport {
  private readonly options: HttpTransportOptions
  private readonly fetchImpl: FetchLike
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  /** 本传输自己的生命周期闸:`close()` 一拉,所有在途的 `events()` 循环收尾。 */
  private readonly lifetime = new AbortController()
  /** 「那条流通不通」的订阅者(§4.1 的可选口)。 */
  private readonly connectionListeners = new Set<(state: TransportConnectionState) => void>()
  private connection: TransportConnectionState | undefined

  constructor(options: HttpTransportOptions) {
    this.options = options
    const injected = options.fetch
    if (!injected && typeof globalThis.fetch !== 'function') {
      throw new Error(
        '@onething/client: no global fetch in this runtime; pass options.fetch',
      )
    }
    this.fetchImpl = injected ?? ((input, init) => globalThis.fetch(input, init))
    this.sleep = options.sleep ?? defaultSleep
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...this.options.headers,
      ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      ...extra,
    }
  }

  async invoke(request: RpcRequest): Promise<RpcResponse> {
    const response = await this.fetchImpl(joinUrl(this.options.baseUrl, '/api/rpc'), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(request),
      signal: this.lifetime.signal,
    })
    // server 的 `/api/rpc` **永远** 200 + `RpcResponse`(处理者失败也是 `{ok:false}`),
    // 所以非 2xx 一定是传输层的事(401 未授权 / 502 代理),照实抛 —— 把它塞成
    // `{ok:false}` 会让"没登录"看起来像"这个方法失败了"。
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }
    return (await response.json()) as RpcResponse
  }

  async capabilities(): Promise<HostCapabilities> {
    const response = await this.fetchImpl(
      joinUrl(this.options.baseUrl, '/api/capabilities'),
      { headers: this.headers(), signal: this.lifetime.signal },
    )
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }
    return (await response.json()) as HostCapabilities
  }

  onConnectionChange(
    listener: (state: TransportConnectionState) => void,
  ): () => void {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  /** 只在**变了**的时候叫一声 —— 每次退避都重报一遍 `retrying` 是噪音。 */
  private setConnection(next: TransportConnectionState): void {
    if (this.connection === next) return
    this.connection = next
    for (const listener of [...this.connectionListeners]) {
      try {
        listener(next)
      } catch (error) {
        this.options.logger?.warn?.('connection listener threw', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  events(options: TransportEventsOptions = {}): AsyncIterable<TransportEvent> {
    return this.eventLoop(options)
  }

  private async *eventLoop(
    options: TransportEventsOptions,
  ): AsyncIterable<TransportEvent> {
    const signal = options.signal
    let after = options.after
    let attempt = 0
    let serverRetryMs: number | undefined

    const stopped = (): boolean => this.lifetime.signal.aborted || Boolean(signal?.aborted)

    while (!stopped()) {
      let sawMessage = false
      try {
        const url = new URL(joinUrl(this.options.baseUrl, '/api/events'))
        if (typeof after === 'number' && Number.isFinite(after)) {
          url.searchParams.set('after', String(after))
        }
        const response = await this.fetchImpl(url.toString(), {
          headers: this.headers({ accept: 'text/event-stream' }),
          signal: signal ?? this.lifetime.signal,
        })
        if (!response.ok || !response.body) {
          throw new Error(
            `Event stream failed: ${response.status} ${response.statusText}`,
          )
        }
        // 接上了 —— 报在**读第一条之前**:一条什么都不发的活流也是接上了。
        this.setConnection('open')
        for await (const message of parseSseStream(response.body, {
          onRetry: ms => { serverRetryMs = ms },
        })) {
          sawMessage = true
          attempt = 0
          const id = message.id === undefined ? undefined : Number.parseInt(message.id, 10)
          if (id !== undefined && Number.isFinite(id)) after = id
          yield {
            name: message.event,
            data: safeParseJson(message.data),
            ...(id !== undefined && Number.isFinite(id) ? { id } : {}),
          }
          if (stopped()) return
        }
      } catch (error) {
        if (stopped()) return
        this.options.logger?.warn?.('event stream dropped', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      if (stopped()) return
      // 走到这里就是断了(抛错 / 流干净地结束都算)——退避之前先说一声。
      this.setConnection('retrying')
      // 流干净地结束(server 重启 / 代理收线)也走这条:一条推送流没有"正常结束"。
      const base = serverRetryMs ?? this.options.initialReconnectDelayMs ?? 1000
      const max = this.options.maxReconnectDelayMs ?? 30_000
      // 收到过消息就重头开始退避 —— 上一次是真的连上了,不该继承旧的指数。
      if (sawMessage) attempt = 0
      const delay = Math.min(base * 2 ** attempt, max)
      attempt += 1
      await this.sleep(delay, signal ?? this.lifetime.signal)
    }
  }

  close(): void {
    if (!this.lifetime.signal.aborted) this.lifetime.abort()
    this.connectionListeners.clear()
  }
}

/** SSE 的 `data:` 按契约总是 JSON;真收到非 JSON 时不炸整条流,原样交出字符串。 */
function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function createHttpTransport(options: HttpTransportOptions): Transport {
  return new HttpTransport(options)
}

/**
 * web 壳的**另外那七条** SSE 路由(C2,`docs/design/client-sdk-2026-09.md` §5.2)。
 *
 * ## 为什么它不在 `@onething/client` 里
 *
 * 包的 `Transport` 认的是 core 那条**主推送流** `GET /api/events`,`TransportEvents`
 * 表里就三条名字(`session:event` / `session:stream` / `settings:changed`),
 * 而且 `transport/types.ts` 明写了「别把 `/api/voice/events`、`/api/oauth/events`
 * 那些**另外的** SSE 路由的词混进来,它们不在这条流上」。今天 Vue 的 web 壳还骑着
 * 七条这样的旁路:
 *
 * | 路由 | 事件名 |
 * |---|---|
 * | `/api/oauth/events` | `oauth:token-refreshed` / `oauth:token-expired` |
 * | `/api/voice/events` | `voice:event` |
 * | `/api/voice/runtime-commands` | `voice:runtime-command` |
 * | `/api/files/watch/events` | `workspace:file-changed` |
 * | `/api/media/events` | `media:image-generated` |
 * | `/api/todo-plan/events` | `todo-plan:changed` |
 * | `/api/scratchpad/events` | `scratchpad:changed` |
 *
 * 它们是 Vue 宿主的历史资产,随它一起退役;把七条塞进包的事件表会让包认识一堆
 * 与 core 主流无关的域名字(那正是「按能力枚举」)。所以**这只文件不重新实现
 * 任何东西** —— 它复用包导出的纯函数 `parseSseStream`,只补「哪条路由、共享与
 * 退避」这层壳自己的账。
 *
 * ## 与从前 `EventSource` 那版的行为对照
 *
 * - **共享**:同一条路径一条连接,按订阅者引用计数;最后一个退订就断。逐字沿用。
 * - **自动重连**:`EventSource` 断线自愈,这里也自愈(指数退避,基数取服务器的
 *   `retry:`,上限 30s)。
 * - **token 不进 URL**:`EventSource` 带不了 header 才有 `?token=` 那条口;`fetch`
 *   带得了,所以这里一个 token 都不往 URL 上挂。web 壳今天本来就不带 token
 *   (补 Bearer 的是 `apps/web/dev-api-proxy.ts`),于是这条对 web 是**零可感知
 *   变化**,只是把那扇门焊上了。
 * - **坏 JSON 不炸整条流**:照旧记一行 warn 然后丢掉那一条。
 */
import { parseSseStream } from '@onething/client'
import { getLogger } from '@/services/log'
import { webApiUrl } from './client'

const log = getLogger('renderer.platform-web-sse')

type Unsubscribe = () => void
type Listener = (payload: unknown) => void

interface SharedStream {
  refCount: number
  controller: AbortController
  /** 事件名 → 这条路径上认它的订阅者。 */
  listeners: Map<string, Set<Listener>>
}

/** 去重键是**应用内路径**(不是解析后的 URL)—— 与从前那版逐字相同。 */
const streams = new Map<string, SharedStream>()

const INITIAL_RECONNECT_MS = 1000
const MAX_RECONNECT_MS = 30_000

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function pump(path: string, entry: SharedStream): Promise<void> {
  const signal = entry.controller.signal
  let attempt = 0
  let serverRetryMs: number | undefined

  while (!signal.aborted) {
    try {
      const response = await fetch(webApiUrl(path), {
        headers: { accept: 'text/event-stream' },
        signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`Event stream failed: ${response.status} ${response.statusText}`)
      }
      for await (const message of parseSseStream(response.body, {
        onRetry: ms => { serverRetryMs = ms },
      })) {
        if (signal.aborted) return
        attempt = 0
        const named = entry.listeners.get(message.event)
        if (!named || named.size === 0) continue
        let payload: unknown
        try {
          payload = JSON.parse(message.data)
        } catch (error) {
          log.warn('ignored malformed sse event', { path, eventName: message.event }, error)
          continue
        }
        for (const listener of [...named]) {
          try {
            listener(payload)
          } catch (error) {
            log.warn('sse listener threw', { path, eventName: message.event }, error)
          }
        }
      }
    } catch (error) {
      if (signal.aborted) return
      log.warn('sse stream dropped', { path }, error)
    }
    if (signal.aborted) return
    const base = serverRetryMs ?? INITIAL_RECONNECT_MS
    const delay = Math.min(base * 2 ** attempt, MAX_RECONNECT_MS)
    attempt += 1
    await sleep(delay, signal)
  }
}

/**
 * 订阅一条旁路 SSE 上的一个具名事件。返回退订函数(幂等)。
 *
 * 没有 `fetch` 的环境(某些 node 环境的单测)老实返回一个空退订 —— 与从前
 * `typeof EventSource === 'undefined'` 那条早退逐字对应。
 */
export function subscribeWebSse<T>(
  path: string,
  eventName: string,
  callback: (payload: T) => void,
): Unsubscribe {
  if (typeof fetch !== 'function') return () => {}

  let entry = streams.get(path)
  if (!entry) {
    entry = { refCount: 0, controller: new AbortController(), listeners: new Map() }
    streams.set(path, entry)
    void pump(path, entry)
  }
  entry.refCount += 1

  const listener = callback as Listener
  let named = entry.listeners.get(eventName)
  if (!named) {
    named = new Set()
    entry.listeners.set(eventName, named)
  }
  named.add(listener)

  let done = false
  return () => {
    if (done) return
    done = true
    const current = streams.get(path)
    if (!current) return
    const set = current.listeners.get(eventName)
    if (set) {
      set.delete(listener)
      if (set.size === 0) current.listeners.delete(eventName)
    }
    current.refCount -= 1
    if (current.refCount <= 0) {
      current.controller.abort()
      streams.delete(path)
    }
  }
}

/** 只给测试用:把所有共享连接断掉并清表。 */
export function resetWebSseForTests(): void {
  for (const entry of streams.values()) entry.controller.abort()
  streams.clear()
}

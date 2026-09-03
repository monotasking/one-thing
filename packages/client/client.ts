/**
 * `createOnethingClient` —— 一个对象,三个口(§4.2)。
 *
 * ## 为什么没有 `client.sessions` / `client.settings` 这种按域的属性
 *
 * 因为那是**枚举点**。「加一个 RPC 域」如果要改本包一行,这个包就没抽到位
 * (根 CLAUDE.md「加功能不许改骨架」;方案 §6 演练第三条正是被这一条打回过一稿)。
 * 所以域客户端是泛型取用的:`client.api(sessionsRouter)`。壳想要短名字,自己写
 * `const sessionsApi = client.api(sessionsRouter)` —— 那一行住在壳里,不住在这里。
 * 同理**没有按域的文件**:`packages/renderer/platform/` 那 40 多个四行 `*-client.ts`
 * 不搬进来。
 *
 * ## 为什么没有模块级单例
 *
 * `packages/renderer/platform/transport-config.ts` 那种「配置写进模块变量」的形不进
 * 本包:它让「同时连本机与远端两台 core」在结构上不可能(演练第七条),也让测试之间
 * 互相污染。要缺省实例的壳自己 `export const client = createOnethingClient(...)`。
 *
 * ## `api(router)` 按 router 记忆
 *
 * 用 `WeakMap` 以 router 对象为键。理由不是省那点构造开销,而是**同一性**:
 * `client.api(sessionsRouter) === client.api(sessionsRouter)`,于是 React 的
 * `useEffect` 依赖数组、Vue 的 `watch` 源写上它不会每次渲染都重订阅。
 * router 对象是 `@shared/ipc` 里的模块级常量,活得和进程一样久;WeakMap 保证
 * 一个真被丢弃的 router(测试里现造的)不会把客户端钉在内存里。
 */
import { createRouterClient } from './rpc/router-client.js'
import { createEventHub, type EventHub } from './events/subscriptions.js'
import type { ClientLogger, HostCapabilities, Transport } from './transport/types.js'
import type { DomainRoutes, RouteAPI, Router } from '@onething/core/ipc'

export interface OnethingClient {
  /** 泛型取域客户端;同一个 router 恒等地拿到同一个对象。 */
  api<T extends DomainRoutes>(router: Router<T>): RouteAPI<T>
  events: EventHub
  /** `GET /api/capabilities`。记忆一次;宿主想重新问就 `capabilities(true)`。 */
  capabilities(refresh?: boolean): Promise<HostCapabilities>
  /** 停掉事件流与传输。之后这个客户端不再可用。 */
  close(): void
}

export interface CreateOnethingClientOptions {
  transport: Transport
  logger?: ClientLogger
  /** 首次拉推送流时从这个序号之后续播(冷启动重放)。 */
  after?: number
}

export function createOnethingClient(
  options: CreateOnethingClientOptions,
): OnethingClient {
  const { transport } = options
  const invoke = (request: Parameters<Transport['invoke']>[0]) => transport.invoke(request)
  // `Router<DomainRoutes>` 做键、`RouteAPI<DomainRoutes>` 做值:两边都在 `api()`
  // 的签名里按具体 T 收窄回去,外面看不见这层擦除。
  const cache = new WeakMap<object, unknown>()
  const events = createEventHub(transport, {
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.after === undefined ? {} : { after: options.after }),
  })

  let capabilitiesPromise: Promise<HostCapabilities> | undefined

  return {
    api<T extends DomainRoutes>(router: Router<T>): RouteAPI<T> {
      const cached = cache.get(router)
      if (cached) return cached as RouteAPI<T>
      const created = createRouterClient(router, invoke)
      cache.set(router, created)
      return created
    },
    events,
    capabilities(refresh = false) {
      // 失败不粘:一次网络抖动不该让这个客户端永远答"没有能力"。
      if (refresh || !capabilitiesPromise) {
        capabilitiesPromise = transport.capabilities().catch(error => {
          capabilitiesPromise = undefined
          throw error
        })
      }
      return capabilitiesPromise
    },
    close() {
      events.close()
      transport.close()
    },
  }
}

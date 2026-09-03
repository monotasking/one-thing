/**
 * Vue 渲染层的 `@onething/client` 实例(C2,`docs/design/client-sdk-2026-09.md` §5.2)。
 *
 * **单例住在壳里,不住在包里**(包的 `client.ts` 文件头写明为什么:模块级配置槽
 * 让"同时连两台 core"在结构上不可能,也让测试互相污染)。所以这只文件就是 Vue
 * 这一侧的那一份 —— 和 `platform/index.ts` 的 `platformApi` 用**同一条判据、同一
 * 套缓存**:有 `window.electronAPI` 走 IPC 传输,否则走 HTTP 传输。
 *
 * ## 为什么按访问解析,而不是模块加载时定一次
 *
 * 与 `platform/index.ts` 里那段注释同一个理由:node 环境的测试会 import 到这条
 * 路径而当时没有 `window`,happy-dom 的测试在 import **之后**才塞
 * `window.electronAPI`。所以宿主是运行时才知道的事。
 *
 * ## `clientApi(router)` —— 40 多个 `*-client.ts` 的那一行
 *
 * 它不是 `client.api(router)` 的别名,而是**再包一层按访问解析**:那些
 * `export const xxxApi = clientApi(xxxRouter)` 是模块顶层执行的,而宿主此刻可能
 * 还没定下来。迁移前那些文件写的是
 * `createRouterClient(xxxRouter, req => platformApi.rpcInvoke(req))` —— 传输面同样
 * 是**调用时**才解析的;这一层保住的就是那份惰性,不多不少。
 * 记忆仍然在客户端那边(`client.api` 按 router 做 WeakMap 记忆),这里每次 get
 * 只是把方法名转发过去。
 *
 * ## Web 那一侧的基址与 token
 *
 * `baseUrl` 取当前页面的 origin。今天 apps/web 打的是**同源相对路径**,由
 * `apps/web/dev-api-proxy.ts` 按发现文件定位真 core 并补上 Bearer —— 换成
 * `origin + /api/...` 是**同一个请求**(同源、根绝对路径),代理照旧接得住,
 * 而 `createHttpTransport` 需要一个能进 `new URL()` 的绝对基址。
 * **token 这里一个字都不给**:补 Bearer 的是代理,这里再补一次就是两个来源
 * (C1 之前 `transport-config.ts` 那条单槽端口的第一条纪律,原话保留)。
 */
import {
  createHttpTransport,
  createOnethingClient,
  type OnethingClient,
  type Transport,
} from '@onething/client'
import type { DomainRoutes, RouteAPI, Router } from '@onething/core/ipc'
import type { ElectronAPI } from '@/types'
import { createElectronTransport } from './electron-transport'
import { ELECTRON_HOST_CAPABILITIES } from './electron-capabilities'

type WindowWithElectronApi = Window & { electronAPI?: ElectronAPI }

const electronTransports = new WeakMap<ElectronAPI, Transport>()
const electronClients = new WeakMap<ElectronAPI, OnethingClient>()
let webTransportInstance: Transport | undefined
let webClientInstance: OnethingClient | undefined

/**
 * 页面自己的 origin。没有 `window` 的环境(node 环境的测试)退到一个占位绝对
 * 基址 —— 那种环境里没人会真去打这条传输,给它一个能过 `new URL()` 的值即可。
 */
function webBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost'
  return window.location?.origin || 'http://localhost'
}

/** 把一条以 `/` 开头的应用内路径翻成实际要打的 URL(与传输同一个基址)。 */
export function webApiUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path // 已经是绝对 URL,不碰
  return `${webBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * 给定宿主对象的那一条传输;`undefined` = 浏览器(HTTP)那一条。
 *
 * 之所以把传输也露出来:`PlatformApi` 上有一格 `rpcInvoke`(`ElectronAPI` 契约的
 * 一部分,web 实现必须给出),它要的正是 `Transport.invoke`。让 web 那侧自己再
 * `createHttpTransport` 一次就是两条传输、两条 SSE —— 一份足矣。
 */
export function transportFor(electronAPI?: ElectronAPI): Transport {
  if (electronAPI) {
    let existing = electronTransports.get(electronAPI)
    if (!existing) {
      existing = createElectronTransport(electronAPI, {
        capabilities: ELECTRON_HOST_CAPABILITIES,
      })
      electronTransports.set(electronAPI, existing)
    }
    return existing
  }
  webTransportInstance ??= createHttpTransport({ baseUrl: webBaseUrl() })
  return webTransportInstance
}

/** 给定宿主对象的那一份客户端;`undefined` = 浏览器(HTTP 传输)那一份。 */
export function clientFor(electronAPI?: ElectronAPI): OnethingClient {
  if (electronAPI) {
    let existing = electronClients.get(electronAPI)
    if (!existing) {
      existing = createOnethingClient({ transport: transportFor(electronAPI) })
      electronClients.set(electronAPI, existing)
    }
    return existing
  }
  webClientInstance ??= createOnethingClient({ transport: transportFor() })
  return webClientInstance
}

/** 当前宿主的那一份客户端。判据与 `platformApi` 逐字相同。 */
export function currentClient(): OnethingClient {
  const electronAPI = typeof window === 'undefined'
    ? undefined
    : (window as WindowWithElectronApi).electronAPI
  return clientFor(electronAPI)
}

/**
 * 域客户端的一行。**惰性**:每次方法调用才解析宿主(见文件头)。
 * 加一个 RPC 域 = `@shared/ipc` 加一个 `defineRouter` + 这里一行,本文件与
 * `@onething/client` 都零改动(方案 §6 第三条)。
 */
export function clientApi<T extends DomainRoutes>(router: Router<T>): RouteAPI<T> {
  return new Proxy({} as RouteAPI<T>, {
    get: (_target, method) =>
      Reflect.get(currentClient().api(router) as unknown as object, method),
    has: (_target, method) =>
      Reflect.has(currentClient().api(router) as unknown as object, method),
  })
}

/**
 * 宿主壳路由的渲染侧传输面 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * `@onething/client` 的 `createRouterClient` 只认一个 `invoke` 函数,不关心那条通道
 * 通向哪里。数据面走 `client.api(router)`(装配层的域处理者,底下是 IPC / HTTP
 * 传输),窗口系接到这里的 `shellInvoke`(宿主的域处理者)。**同一个客户端工厂,
 * 同一种失败形状** —— `{ ok:false, error }` 在 `createRouterClient` 里统一变成
 * `RpcError`。
 *
 * C2 起这是全 renderer **唯一**还直接调 `createRouterClient` 的地方,理由是
 * `shell:invoke` 不是 core 的 RPC 面:它没有 `Transport`,处理者在浏览器里就是
 * 渲染层自己(`shell-web/`)。给它造一个假 `Transport` 只为走 `client.api()`,
 * 是把"宿主自己那张表"说成"远端的一个域" —— 所以照旧直接用工厂函数。
 *
 * 按访问取 `platformApi.shellInvoke`,不快照:electron / web 两个实现由
 * `platform/index.ts` 的代理按访问决定,preload 在 reload 时还会整只换掉方法。
 */
import type { DomainRoutes, RouteAPI, Router } from '@onething/core/ipc'
import type { RpcRequest, RpcResponse } from '@shared/ipc/rpc.js'
import { platformApi } from './index'
import { createRouterClient } from '@onething/client'

export function shellInvoke(request: RpcRequest): Promise<RpcResponse> {
  return platformApi.shellInvoke(request)
}

export function createShellClient<T extends DomainRoutes>(router: Router<T>): RouteAPI<T> {
  return createRouterClient(router, shellInvoke)
}

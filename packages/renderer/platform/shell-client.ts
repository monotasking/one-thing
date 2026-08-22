/**
 * 宿主壳路由的渲染侧传输面 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * `router-client.ts` 的 `createRouterClient` 只认一个 `invoke` 函数,不关心那条通道
 * 通向哪里。数据面把它接到 `platformApi.rpcInvoke`(装配层的域处理者),窗口系接到
 * 这里的 `shellInvoke`(宿主的域处理者)。**同一个客户端工厂,同一种失败形状** ——
 * `{ ok:false, error }` 在 `createRouterClient` 里统一变成 `RpcError`。
 *
 * 按访问取 `platformApi.shellInvoke`,不快照:electron / web 两个实现由
 * `platform/index.ts` 的代理按访问决定,preload 在 reload 时还会整只换掉方法。
 */
import type { DomainRoutes, RouteAPI, Router } from '@onething/core/ipc'
import type { RpcRequest, RpcResponse } from '@shared/ipc/rpc.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export function shellInvoke(request: RpcRequest): Promise<RpcResponse> {
  return platformApi.shellInvoke(request)
}

export function createShellClient<T extends DomainRoutes>(router: Router<T>): RouteAPI<T> {
  return createRouterClient(router, shellInvoke)
}

/**
 * search(Search Everywhere 的**数据面**)域的渲染侧客户端 —— 结构债 P4 终态批
 * A1-b(2026-08-23)。
 *
 * 只有一条 `query`,走的是**通用 RPC 通道**(`platformApi.rpcInvoke` → 桌面的
 * `rpc:invoke` / web 的 `POST /api/rpc`),而不是宿主壳路由:处理者一行 electron
 * 都不碰,按判据是数据面。两个宿主打的是同一个域,域自己按 `transport` 分叉。
 *
 * 窗口面那四条(toggle / close / setAnchor / executeAction)在
 * `platform/search-window-client.ts` 上;`onSearchAction` 是推送,仍在 platformApi 上。
 */
import { searchRouter } from '@shared/ipc/search.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const searchApi = createRouterClient(searchRouter, request =>
  platformApi.rpcInvoke(request),
)

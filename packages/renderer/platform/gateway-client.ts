/**
 * gateway(IM 网关)域的渲染侧客户端 —— 结构债 P4c 第八批。
 *
 * 形状照 `themes-client.ts` / `oauth-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动。**本域零推送** —— 全仓没有
 * `GATEWAY_*_CHANGED`,状态靠调用方在每次操作之后重新 `getStatus()`。
 *
 * 无参的两条(`getStatus` / `stop`)按本仓惯例递 `{}`。
 */
import { gatewayRouter } from '@shared/ipc/gateway.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const gatewayApi = createRouterClient(gatewayRouter, request =>
  platformApi.rpcInvoke(request),
)

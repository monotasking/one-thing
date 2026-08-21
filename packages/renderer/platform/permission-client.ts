/**
 * permission(运行中的权限询问)域的渲染侧客户端 —— 结构债 P4c。
 *
 * 形状照 `spaces-client.ts` 的判例:壳外一个模块 + 通用 `platformApi.rpcInvoke`,
 * 四壳零改动;入参一律是信封(`permissionApi.getPending({ sessionId })`)。
 *
 * 这里**只有读与清**。应答那条(`command:permission-respond`)仍然走命令总线
 * `platformApi.emitCommand` —— 它是一条命令,不是一次 RPC,通道亲和性由 core 校验。
 * 询问的到达同样不在这里:`permission:request` 是会话事件。
 */
import { permissionRouter } from '@shared/ipc/permissions.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const permissionApi = createRouterClient(permissionRouter, request =>
  platformApi.rpcInvoke(request),
)

/**
 * 权限授权账页域的渲染侧客户端（主线 T 批 3）。
 *
 * 照 E1 判例搭在壳外，理由同 `markdown-client.ts`。
 *
 * 迁移时的实情记在这里：这个域**当前没有 UI 消费者** —— 渲染层里搜不到一处
 * `listPermissionGrants` 的调用点（只有 `types/index.ts` 的声明与 `web.ts` 的桩
 * 测试）。迁移不是为了改 UI，是为了把四条手写通道、四条 HTTP 路由和 server 那两个
 * 归属校验 helper 收成一份实现；能力保持可达，等权限账页 UI 接上来时直接用。
 */
import { permissionGrantsRouter } from '@shared/ipc/permission-grants.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const permissionGrantsApi = createRouterClient(
  permissionGrantsRouter,
  request => platformApi.rpcInvoke(request),
)

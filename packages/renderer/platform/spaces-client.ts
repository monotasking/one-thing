/**
 * space(工作空间)域的渲染侧客户端 —— 结构债 P0.3。
 *
 * 形状照 `agents-client.ts` 的判例:壳外一个模块 + 通用 `platformApi.rpcInvoke`,
 * 四壳零改动。与 agents 那份的差别是这里**不再包一层旧签名** —— 方法名直接是
 * router 上的十三个动词,入参一律是信封(`getOverlay({ id })` 而不是
 * `spacesGetOverlay(id)`)。位置参数在这条通道上没有位置,留着只会让人以为
 * 还有第二种调法。
 *
 * 与被删掉的那两条线的差别值得记一笔:web 端原来是一排 `softJson('/api/spaces'…)`
 * 桩(server 从来没有这些 REST 路由,请求必然失败、降级成「只有默认空间」)。
 * 迁到 router 之后 web 走的是同一条 `POST /api/rpc`,**真的能拿到空间列表** ——
 * 降级路径还在(拿不到就回落 default),只是不再必然踩它。
 *
 * `SPACES_CHANGED` 广播不在这里:router 没有推送面,那条订阅仍然是
 * `platformApi.onSpacesChanged`。
 */
import { spacesRouter } from '@shared/ipc/spaces.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const spacesApi = createRouterClient(spacesRouter, request =>
  platformApi.rpcInvoke(request),
)

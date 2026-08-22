/**
 * interaction(agent 提问 → 用户应答)域的渲染侧客户端 —— 结构债 P4c 第九批。
 *
 * 形状照 `themes-client.ts` / `gateway-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动。**本域零推送** —— 提问/结算走会话事件通道
 * (`interaction:requested` / `interaction:settled`)。
 *
 * ## 能力位 `interactionRespond`(#17,默认关)
 *
 * 迁到通用通道之后,浏览器**技术上**已经能应答桌面那台后端的提问了 —— 这是一次
 * 会让 web 长出新能力的迁移,按「续做口径」必须由一颗能力位挡着,而不是搭搬家的
 * 便车悄悄放开。`platformApi.capabilities.interactionRespond` 在 electron 上为
 * `true`、web 上为 `false`;为 false 时下面两条**根本不发请求**,而是就地返回与
 * 迁移前 web 硬桩(`WEB_DESKTOP_ONLY_PLATFORM_METHODS` 里的
 * `getPendingInteractions` / `respondInteraction`)逐字同形的失败信封 ——
 * `stores/interactions.ts` 因此走同一条分支:卡片不出现,提问照旧由内核到点
 * 自结算,不会挂住。
 *
 * **放开 = 一行**:`platform/web.ts` 的 `interactionRespond: false` 改成 `true`
 * (或让它跟着 `/api/capabilities` 走)。
 */
import { interactionRouter } from '@shared/ipc/interaction.js'
import type {
  InteractionGetPendingResponse,
  InteractionRespondRequest,
  InteractionRespondResponse,
} from '@shared/ipc/interaction.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

const interaction = createRouterClient(interactionRouter, request =>
  platformApi.rpcInvoke(request),
)

/** 与迁移前 web 硬桩逐字同形的失败信封(`unsupported(method)` 的那句话)。 */
function unavailable(method: string): { success: false; error: string } {
  return {
    success: false,
    error: `Platform method "${method}" is not available in the web host yet.`,
  }
}

function enabled(): boolean {
  return platformApi.capabilities.interactionRespond !== false
}

export const interactionApi = {
  getPending: (sessionId: string): Promise<InteractionGetPendingResponse> =>
    enabled()
      ? interaction.getPending({ sessionId })
      : Promise.resolve(unavailable('getPendingInteractions')),
  respond: (request: InteractionRespondRequest): Promise<InteractionRespondResponse> =>
    enabled()
      ? interaction.respond(request)
      : Promise.resolve(unavailable('respondInteraction')),
}

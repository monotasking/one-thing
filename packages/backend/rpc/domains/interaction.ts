/**
 * interaction(agent 提问 → 用户应答)域 —— 结构债 P4c 第九批,两条数据面整只从
 * 手写 IPC 通道搬到通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉两处镜像:
 *  - `apps/electron/src/ipc/interaction.ts` 的手写 IPC 工厂(连同
 *    `__tests__/interaction.test.ts`)+ `apps/electron/src/main/ipc/interaction.ts`
 *    那层壳适配(`IPC_CHANNELS` 上那两条 `interaction:*` 通道);
 *  - `preload/bridge.ts` 的两条包装与 `platform/web.ts` 的两个
 *    `WEB_DESKTOP_ONLY_PLATFORM_METHODS` 名单项。
 *
 * server 侧本来就**一条路由都没有**(web 是硬桩),所以这一批 `server/http.ts` 与
 * `server/runtime.ts` 零改动 —— 域挂上 router 就经 `POST /api/rpc` 自动可达。
 *
 * ## 通道亲和:`channel` 由宿主填,不从请求里读
 *
 * 这是本域唯一带 transport 分叉的地方,而且分叉在**安全侧**:
 *
 *  - `transport:'ipc'`(桌面)—— 恒填 `'ipc'`,与迁移前 `@main/ipc/interaction.ts`
 *    那一行逐字同义。
 *  - `transport:'http'` —— **认领那次提问自己的 `targetChannel`**,与 server 的
 *    HTTP 权限应答同一判例(调用方在 HTTP 边界已经被认证过;通道亲和防的是总线上
 *    的跨通道冒答,不是这一层)。找不到对应的活提问时退回 `'ipc'`,让内核自己按
 *    「没有待答项」如实拒绝,而不是在这里编一个通道出来。
 *
 * 两条路径都不读请求里的 `channel` —— 请求里根本没有那一格:让应答方自报通道,
 * 那道闸就白设了。
 *
 * ## 迁后 web 行为:能力位关着 = 零变化
 *
 * web 今天两条都是硬桩(`unsupported(method)`,返回 `{success:false, error:'…not
 * available in the web host yet.'}`)。迁走之后通道是通的,但渲染侧新立了一颗
 * 能力位 `interactionRespond`(`platform/types.ts`),web 上默认 `false`,
 * `stores/interactions.ts` 在它为 false 时**根本不发请求**,可感知结果与今天逐字
 * 相同(补水拿不到 pending、应答不落地,提问由内核 deadline 自结算)。
 * 放开 = `platform/web.ts` 里 `interactionRespond: false` 改成 `true` 那一行。
 *
 * ## 本域零推送
 *
 * 提问/结算事件走会话事件通道(`interaction:requested` / `interaction:settled`),
 * 不是这个域的通道,所以 `@main/ipc/interaction.ts` 整只删掉(同 acp / collab 判例)。
 */
import { Interaction } from '@onething/core/interaction'
import {
  getPendingInteractionsForIpc,
  respondInteractionForIpc,
} from '@onething/runtime/interaction/ipc-operations.wiring'
import { interactionRouter, type InteractionRoutes } from '@shared/ipc/interaction.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import { registerRouterHandlers, type RpcRouteHandlers } from '../registry.js'

/**
 * 这次应答该盖哪条通道的章。桌面恒 `'ipc'`;联网宿主认领那次提问自己的
 * `targetChannel`(读的是内核的活账,不是请求体)。
 */
function resolveRespondChannel(
  request: InteractionRoutes['respond']['input'],
  context: RpcDispatchContext,
): string {
  if (context.transport === 'ipc') return 'ipc'
  const pending = Interaction.getPending(request.sessionId)
  const match = pending.find(item =>
    (request.interactionId !== undefined && item.id === request.interactionId)
    || (request.toolCallId !== undefined && item.toolCallId === request.toolCallId),
  )
  return match?.targetChannel || 'ipc'
}

export const interactionRpcHandlers: RpcRouteHandlers<InteractionRoutes> = {
  async respond(request, context = DESKTOP_RPC_CONTEXT) {
    return respondInteractionForIpc(request, resolveRespondChannel(request, context))
  },
  async getPending(request) {
    return getPendingInteractionsForIpc(request.sessionId)
  },
}

export function registerInteractionRpcDomain(): () => void {
  return registerRouterHandlers(interactionRouter, interactionRpcHandlers)
}

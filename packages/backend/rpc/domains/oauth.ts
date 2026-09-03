/**
 * oauth(订阅登录)域 —— 结构债 P4c 第七批,六条数据面整只从手写 IPC 通道搬到
 * 通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/oauth.ts` 的手写 IPC 工厂 + `apps/electron/src/main/ipc/oauth.ts`
 *    那层壳适配(`IPC_CHANNELS` 上那六条 oauth invoke 通道);
 *  - `preload/bridge.ts` 的六条包装与 `platform/web.ts` 的六条 REST 镜像
 *    (其中 `oauthRefresh` 在渲染层**零调用点** —— 一条打得通的死镜像);
 *  - `server/http.ts` 的六条 REST 路由、`server/runtime.ts` 的 `oauth` facade adapter,
 *    以及只服务于它的那套 **per-owner 的第二台 authService**。
 *
 * ## 一台 authService(拍板 #20,同 agents / models / skills 判例)
 *
 * 旧 server 按 owner 各开一台 `OnethingAuthService` + 各自的 `OnethingTokenStore`
 * (`owners/<uid>/<wid>/oauth`),桌面用的是装配层那台
 * `@onething/backend/wiring/auth` 单例(默认 `<store>/oauth-tokens.json` 或空间凭证池)。
 * 一个 store 两本令牌账等于把「我登没登录」这件事分叉:桌面登了,浏览器看不见。
 * 搬家取的是桌面那台 —— **web 与桌面从此读同一份凭证**。
 *
 * 顺带,凭证写回目标(`spaceId` / `entryId` / `label`,批 B6)在旧 server 路由上
 * 是被丢掉的(它只转发 `providerId`);走 router 之后它真的传到 `authService` 了 ——
 * 浏览器里往空间凭证池登录从此是真的。
 *
 * ## 唯一的宿主闸:`start` 开不开浏览器
 *
 * 「把授权页拉起来」要宿主的默认浏览器。旧 server 路由的做法是**根本不递
 * `openExternal`**(投影里那是可选项),于是响应里带着 `authUrl` 回给调用方,
 * 由调用方自己开。
 *
 * B1(方案 `docs/design/backend-transport-forks-2026-09.md` §2.2)之前这里问的是
 * `transport === 'http'` —— 而它真正想问的是「这台宿主有没有默认浏览器」。现在
 * 直接问 `hasShellHost()`(`configureShellHost` 那个端口注没注入,P4c 第二批立的)。
 * 效果:没接外壳的宿主(server / daemon / 今天的 React 壳)拿到的响应形状与从前的
 * http 支逐字相同;接了外壳的 Vue 桌面从此在自己的内嵌 HTTP 面上也会真的开浏览器。
 *
 * 顺带修掉一处**沉默的降级**:从前 ipc 支无条件递 `openExternal`,宿主没接时那个
 * 闭包会走进 `getShellHost()` 的结构化失败并被 `.then(() => undefined)` 吞掉 ——
 * 于是「浏览器没开」看上去和「开了」一模一样。现在没接就不递,调用方拿得到 `authUrl`。
 *
 * ## 两条推送不在这里
 *
 * `OAUTH_TOKEN_REFRESHED` / `OAUTH_TOKEN_EXPIRED` 走
 * `configureOAuthEventBroadcaster`(`../../wiring/auth/oauth-events.js`)——
 * router 今天没有推送面。`refresh` 里那句「刷新失败 = 令牌过期」因此改走
 * `notifyOAuthTokenExpired`(经事件源),而不是像从前桌面那样直接调 Electron 广播。
 */
import {
  completeOnethingOAuthCallbackForIpc,
  getOnethingOAuthStatusForIpc,
  logoutOnethingOAuthForIpc,
  normalizeCredentialTarget,
  pollOnethingOAuthDeviceFlowForIpc,
  refreshOnethingOAuthForIpc,
  startOnethingOAuthForIpc,
} from '@onething/runtime/auth'
import { getShellHost, hasShellHost } from '@onething/runtime/shell/host-ports'
import type { OAuthRoutes } from '@shared/ipc/oauth.js'
import { authService } from '../../wiring/auth/auth-service.js'
import { notifyOAuthTokenExpired } from '../../wiring/auth/oauth-events.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import type { RpcRouteHandlers } from '../registry.js'
import type { StartOnethingOAuthForIpcOptions, RefreshOnethingOAuthForIpcOptions, OnethingOAuthIpcLogger } from '@onething/runtime/auth/ipc-operations'
import type { ConsoleLikePort } from '@onething/runtime/logging'

const log = getLogger('rpc.oauth')
/** 投影层收的是鸭子 logger;从前 `@main` 那层递的是裸 `console`。 */
const consoleLog: ConsoleLikePort & OnethingOAuthIpcLogger = consolePort(log)

/** 凭证写回目标的归一 —— 非法 / 默认 spaceId 一律落回 settings(批 B6)。 */
function targetOf(request: {
  spaceId?: string
  entryId?: string
  label?: string
}): ReturnType<typeof normalizeCredentialTarget> {
  return normalizeCredentialTarget({
    spaceId: request.spaceId,
    entryId: request.entryId,
    label: request.label,
  })
}

export const oauthRpcHandlers: RpcRouteHandlers<OAuthRoutes> = {
  async start(request) {
    const target = targetOf(request)
    const startOnethingOAuthForIpcOptions: StartOnethingOAuthForIpcOptions = {
      providerId: request.providerId,
      start: providerId => authService.start(providerId, target),
      // 没有外壳能力就不开浏览器:调用方拿 `authUrl` 自己开(旧 server 路由的形状)。
      openExternal: hasShellHost()
        ? url => getShellHost().openExternal(url).then(() => undefined)
        : undefined,
      logger: consoleLog,
    };
    return startOnethingOAuthForIpc(startOnethingOAuthForIpcOptions)
  },
  async callback(request) {
    const target = targetOf(request)
    return completeOnethingOAuthCallbackForIpc({
      providerId: request.providerId,
      code: request.code,
      state: request.state,
      completeManualCode: (providerId, code, state) =>
        authService.completeManualCode(providerId, code, state, target),
      logger: consoleLog,
    })
  },
  async devicePoll(request) {
    const target = targetOf(request)
    return pollOnethingOAuthDeviceFlowForIpc({
      providerId: request.providerId,
      flowId: request.flowId,
      deviceCode: request.deviceCode,
      pollDeviceFlow: (providerId, flowId) =>
        authService.pollDeviceFlow(providerId, flowId, target),
      logger: consoleLog,
    })
  },
  async refresh(request) {
    const target = targetOf(request)
    const refreshOnethingOAuthForIpcOptions: RefreshOnethingOAuthForIpcOptions = {
      providerId: request.providerId,
      refreshToken: providerId => authService.refreshToken(providerId, target),
      notifyTokenExpired: notifyOAuthTokenExpired,
      logger: consoleLog,
    };
    return refreshOnethingOAuthForIpc(refreshOnethingOAuthForIpcOptions)
  },
  async status(request) {
    const target = targetOf(request)
    return getOnethingOAuthStatusForIpc({
      providerId: request.providerId,
      getStatus: providerId => authService.getStatus(providerId, target),
      logger: consoleLog,
    })
  },
  async logout(request) {
    const target = targetOf(request)
    return logoutOnethingOAuthForIpc({
      providerId: request.providerId,
      deleteToken: providerId => authService.deleteToken(providerId, target),
      logger: consoleLog,
    })
  },
}

